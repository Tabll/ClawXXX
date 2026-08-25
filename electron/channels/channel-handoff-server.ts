import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { CanonicalChannelAccount } from '@shared/domains/channels';
import { canonicalChannelAccountKey } from '@shared/domains/channels';
import { toUiChannelType } from '../utils/channel-alias';
import type { ChannelInboundEnvelope } from './channel-runtime-contracts';

const MAX_HANDOFF_BYTES = 136 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const MAX_ATTACHMENTS = 20;
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_EXTERNAL_ID_BYTES = 4 * 1024;
const MAX_ACCOUNT_ID_BYTES = 512;

type HandoffAttachment = {
  dataBase64: string;
  mimeType: string;
  fileName?: string;
};

type HandoffPayload = {
  channelType: string;
  nativeAccountId?: string;
  externalConversationId: string;
  externalMessageId: string;
  targetId: string;
  senderId?: string;
  senderName?: string;
  text?: string;
  attachments?: HandoffAttachment[];
  replyToExternalMessageId?: string;
  receivedAt: string;
};

type Subscription = {
  account: CanonicalChannelAccount;
  handler: (message: ChannelInboundEnvelope) => Promise<void>;
};

export type ChannelHandoffEndpoint = {
  url: string;
  token: string;
};

/**
 * Authenticated loopback admission boundary used by the patched OpenClaw
 * connector host. The server owns no history and acknowledges only after the
 * canonical SQLite admission transaction completes.
 */
export class ChannelHandoffServer {
  private readonly token = randomBytes(32).toString('base64url');
  private readonly subscriptions = new Map<string, Subscription>();
  private server?: Server;
  private endpoint?: ChannelHandoffEndpoint;

  async start(): Promise<ChannelHandoffEndpoint> {
    if (this.endpoint) return this.endpoint;
    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    server.requestTimeout = 30_000;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 5_000;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true });
    });
    const address = server.address() as AddressInfo | null;
    if (!address) {
      server.close();
      throw new Error('Channel handoff server has no loopback address');
    }
    this.server = server;
    this.endpoint = Object.freeze({
      url: `http://127.0.0.1:${address.port}/v1/channel/inbound`,
      token: this.token,
    });
    return this.endpoint;
  }

  subscribe(
    account: CanonicalChannelAccount,
    handler: (message: ChannelInboundEnvelope) => Promise<void>,
  ): () => void {
    const key = canonicalChannelAccountKey(account.channelType, account.nativeAccountId);
    this.subscriptions.set(key, { account, handler });
    return () => {
      const active = this.subscriptions.get(key);
      if (active?.handler === handler) this.subscriptions.delete(key);
    };
  }

  async stop(): Promise<void> {
    this.subscriptions.clear();
    const server = this.server;
    this.server = undefined;
    this.endpoint = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.method !== 'POST' || request.url !== '/v1/channel/inbound') {
        return send(response, 404, { accepted: false, code: 'not-found' });
      }
      if (!this.authorized(request.headers.authorization)) {
        request.resume();
        return send(response, 401, { accepted: false, code: 'unauthorized' });
      }
      const payload = parsePayload(await readBody(request));
      const channelType = toUiChannelType(payload.channelType);
      const nativeAccountId = payload.nativeAccountId?.trim() || 'default';
      const key = canonicalChannelAccountKey(channelType, nativeAccountId);
      const subscription = this.subscriptions.get(key);
      if (!subscription) {
        return send(response, 409, { accepted: false, code: 'owner-not-active' });
      }
      await subscription.handler(toEnvelope(subscription.account, payload));
      return send(response, 202, { accepted: true });
    } catch (error) {
      const code = error instanceof PayloadError ? error.code : 'admission-failed';
      const status = error instanceof PayloadError ? error.status : 503;
      return send(response, status, { accepted: false, code });
    }
  }

  private authorized(header: string | undefined): boolean {
    if (!header?.startsWith('Bearer ')) return false;
    const supplied = Buffer.from(header.slice(7));
    const expected = Buffer.from(this.token);
    return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected);
  }
}

class PayloadError extends Error {
  constructor(readonly code: string, readonly status = 400) {
    super(code);
  }
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const declared = Number(request.headers['content-length'] ?? '0');
  if (Number.isFinite(declared) && declared > MAX_HANDOFF_BYTES) {
    request.resume();
    throw new PayloadError('payload-too-large', 413);
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    length += chunk.byteLength;
    if (length > MAX_HANDOFF_BYTES) throw new PayloadError('payload-too-large', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

function parsePayload(body: Buffer): HandoffPayload {
  let input: unknown;
  try {
    input = JSON.parse(body.toString('utf8'));
  } catch {
    throw new PayloadError('invalid-json');
  }
  if (!isRecord(input)) throw new PayloadError('invalid-payload');
  const channelType = boundedRequiredText(input.channelType, 'channelType', 64);
  const externalConversationId = boundedRequiredText(input.externalConversationId, 'externalConversationId', MAX_EXTERNAL_ID_BYTES);
  const externalMessageId = boundedRequiredText(input.externalMessageId, 'externalMessageId', MAX_EXTERNAL_ID_BYTES);
  const targetId = boundedRequiredText(input.targetId, 'targetId', MAX_EXTERNAL_ID_BYTES);
  const receivedAt = boundedRequiredText(input.receivedAt, 'receivedAt', 128);
  if (!Number.isFinite(Date.parse(receivedAt))) throw new PayloadError('invalid-receivedAt');
  const nativeAccountId = boundedOptionalText(input.nativeAccountId, MAX_ACCOUNT_ID_BYTES);
  if (typeof input.text === 'string' && Buffer.byteLength(input.text, 'utf8') > MAX_TEXT_BYTES) {
    throw new PayloadError('text-too-large', 413);
  }
  const attachments = input.attachments === undefined
    ? undefined
    : parseAttachments(input.attachments);
  return {
    channelType,
    ...(nativeAccountId ? { nativeAccountId } : {}),
    externalConversationId,
    externalMessageId,
    targetId,
    ...(optionalText(input.senderId) ? { senderId: optionalText(input.senderId) } : {}),
    ...(optionalText(input.senderName) ? { senderName: optionalText(input.senderName) } : {}),
    ...(typeof input.text === 'string' ? { text: input.text } : {}),
    ...(attachments?.length ? { attachments } : {}),
    ...(optionalText(input.replyToExternalMessageId)
      ? { replyToExternalMessageId: optionalText(input.replyToExternalMessageId) }
      : {}),
    receivedAt: new Date(receivedAt).toISOString(),
  };
}

function parseAttachments(input: unknown): HandoffAttachment[] {
  if (!Array.isArray(input)) throw new PayloadError('invalid-attachments');
  if (input.length > MAX_ATTACHMENTS) throw new PayloadError('too-many-attachments', 413);
  let total = 0;
  return input.map((item) => {
    if (!isRecord(item) || typeof item.dataBase64 !== 'string' || typeof item.mimeType !== 'string') {
      throw new PayloadError('invalid-attachment');
    }
    if (!isCanonicalBase64(item.dataBase64)) throw new PayloadError('invalid-attachment-base64');
    const data = Buffer.from(item.dataBase64, 'base64');
    if (data.byteLength > MAX_ATTACHMENT_BYTES) throw new PayloadError('attachment-too-large', 413);
    total += data.byteLength;
    if (total > MAX_TOTAL_ATTACHMENT_BYTES) throw new PayloadError('attachments-too-large', 413);
    return {
      dataBase64: data.toString('base64'),
      mimeType: normalizedMimeType(item.mimeType),
      ...(optionalText(item.fileName) ? { fileName: safeFileName(optionalText(item.fileName)!) } : {}),
    };
  });
}

function toEnvelope(account: CanonicalChannelAccount, payload: HandoffPayload): ChannelInboundEnvelope {
  return {
    accountId: account.id,
    channelType: account.channelType,
    externalConversationId: payload.externalConversationId,
    externalMessageId: payload.externalMessageId,
    targetId: payload.targetId,
    ...(payload.senderId ? { senderId: payload.senderId } : {}),
    ...(payload.senderName ? { senderName: payload.senderName } : {}),
    ...(payload.text !== undefined ? { text: payload.text } : {}),
    ...(payload.attachments ? {
      attachments: payload.attachments.map(attachment => ({
        data: Buffer.from(attachment.dataBase64, 'base64'),
        mimeType: attachment.mimeType,
        ...(attachment.fileName ? { fileName: attachment.fileName } : {}),
      })),
    } : {}),
    ...(payload.replyToExternalMessageId
      ? { replyToExternalMessageId: payload.replyToExternalMessageId }
      : {}),
    receivedAt: payload.receivedAt,
  };
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 4096) : undefined;
}

function boundedRequiredText(value: unknown, field: string, maximumBytes: number): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new PayloadError(`invalid-${field}`);
  }
  const normalized = value.trim();
  if (Buffer.byteLength(normalized, 'utf8') > maximumBytes) throw new PayloadError(`${field}-too-large`, 413);
  return normalized;
}

function boundedOptionalText(value: unknown, maximumBytes: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.includes('\0')) throw new PayloadError('invalid-nativeAccountId');
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (Buffer.byteLength(normalized, 'utf8') > maximumBytes) throw new PayloadError('nativeAccountId-too-large', 413);
  return normalized;
}

function isCanonicalBase64(value: string): boolean {
  if (value === '') return true;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  return Buffer.from(value, 'base64').toString('base64') === value;
}

function normalizedMimeType(value: string): string {
  const mimeType = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mimeType)
    ? mimeType
    : 'application/octet-stream';
}

function safeFileName(value: string): string {
  return value.replace(/[\\/\0\r\n]/g, '_').slice(0, 255) || 'attachment';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function send(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': encoded.byteLength,
    'cache-control': 'no-store',
    connection: 'close',
  });
  response.end(encoded);
}
