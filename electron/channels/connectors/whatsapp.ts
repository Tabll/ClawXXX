import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  makeWASocket,
  proto,
  useMultiFileAuthState as loadMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from '@whiskeysockets/baileys';
import { canonicalChannelAccountKey } from '@shared/domains/channels';
import {
  captureChannelAuthBundle,
  restoreChannelAuthBundle,
  safeChannelProjectionPath,
} from '../channel-auth-bundle';
import type {
  ChannelConnectorFactory,
  ChannelConnectorSession,
  ChannelInboundAttachment,
  ChannelOutboundEnvelope,
} from '../channel-runtime-contracts';
import {
  CONNECTOR_ATTACHMENT_LIMIT_BYTES,
  ConnectorStatusTracker,
  EphemeralTargetDirectory,
  normalizeMimeType,
  safeConnectorError,
  safeFileName,
  unixTimestampIso,
} from './common';

type WhatsAppConnectorOptions = {
  projectionRoot: string;
  persistCredential(accountId: string, values: Record<string, string>): Promise<void>;
  renderQr(qr: string): Promise<string>;
};

type BaileysLogger = NonNullable<Parameters<typeof makeWASocket>[0]['logger']>;

const silentLogger: BaileysLogger = {
  level: 'silent',
  child: () => silentLogger,
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export function createWhatsAppConnectorFactory(options: WhatsAppConnectorOptions): ChannelConnectorFactory {
  const loginSessions = new Map<string, WASocket>();
  return {
    channelType: 'whatsapp',
    async validate(config) {
      return typeof config.authBundle === 'string' && config.authBundle.trim()
        ? { valid: true }
        : { valid: false, errors: ['WhatsApp QR login is required'] };
    },
    async connect(context) {
      const root = safeChannelProjectionPath(options.projectionRoot, context.account.id);
      const bundle = context.connectionConfig.authBundle;
      if (typeof bundle !== 'string' || !bundle.trim()) throw new Error('WhatsApp QR login is required');
      await restoreChannelAuthBundle(root, bundle);
      const session = new WhatsAppSession(context, root, options.persistCredential);
      await session.start();
      return session;
    },
    async startLogin(nativeAccountId, emit) {
      const loginKey = nativeAccountId?.trim() || 'default';
      loginSessions.get(loginKey)?.end(new Error('WhatsApp QR login replaced'));
      const root = safeChannelProjectionPath(resolve(options.projectionRoot, '.login'), loginKey);
      await rm(root, { recursive: true, force: true });
      await mkdir(root, { recursive: true, mode: 0o700 });
      const { state, saveCreds } = await loadMultiFileAuthState(root);
      const { version } = await fetchLatestBaileysVersion();
      const socket = makeWASocket({
        auth: state,
        version,
        logger: silentLogger,
        browser: ['ClawX', 'Desktop', '1.0.0'],
        syncFullHistory: false,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
      });
      loginSessions.set(loginKey, socket);
      let credentialWrite = Promise.resolve();
      let finished = false;
      socket.ev.on('creds.update', () => {
        credentialWrite = credentialWrite.then(saveCreds);
      });
      socket.ev.on('connection.update', update => {
        if (update.qr) {
          void options.renderQr(update.qr)
            .then(qr => emit({ type: 'qr', qr, sessionKey: loginKey }))
            .catch(error => emit({ type: 'error', message: safeConnectorError(error) }));
        }
        if (update.connection === 'open' && !finished) {
          finished = true;
          void credentialWrite.then(async () => {
            const nativeId = normalizeWhatsAppIdentity(socket.user?.id) || loginKey;
            const authBundle = await captureChannelAuthBundle(root);
            emit({ type: 'success', nativeAccountId: nativeId, credential: { authBundle } });
            loginSessions.delete(loginKey);
            socket.end(undefined);
            await rm(root, { recursive: true, force: true });
          }).catch(error => emit({ type: 'error', message: safeConnectorError(error) }));
        }
        if (update.connection === 'close' && !finished) {
          finished = true;
          loginSessions.delete(loginKey);
          emit({ type: 'error', message: safeConnectorError(update.lastDisconnect?.error ?? 'WhatsApp login closed') });
          void rm(root, { recursive: true, force: true });
        }
      });
    },
    async cancelLogin(nativeAccountId) {
      const loginKey = nativeAccountId?.trim() || 'default';
      const socket = loginSessions.get(loginKey);
      loginSessions.delete(loginKey);
      socket?.end(new Error('WhatsApp QR login cancelled'));
    },
    async removeProjection(account) {
      const root = safeChannelProjectionPath(options.projectionRoot, account.id);
      await rm(root, { recursive: true, force: true });
    },
  };
}

class WhatsAppSession implements ChannelConnectorSession {
  private readonly statusTracker;
  private readonly targetDirectory = new EphemeralTargetDirectory();
  private socket?: WASocket;
  private stopped = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private credentialWrite = Promise.resolve();

  constructor(
    private readonly context: Parameters<ChannelConnectorFactory['connect']>[0],
    private readonly authRoot: string,
    private readonly persistCredential: WhatsAppConnectorOptions['persistCredential'],
  ) {
    this.statusTracker = new ConnectorStatusTracker(context.onStatus);
  }

  async start(): Promise<void> {
    await this.connect(true);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.end(undefined);
    this.socket = undefined;
    await this.credentialWrite.catch(() => undefined);
    await this.statusTracker.set('disconnected');
  }

  async send(message: ChannelOutboundEnvelope): Promise<void> {
    const socket = this.socket;
    if (!socket || this.statusTracker.snapshot().state !== 'connected') throw new Error('WhatsApp is disconnected');
    const target = normalizeWhatsAppTarget(message.targetId);
    if (message.attachments.length === 0) {
      if (message.text === undefined) throw new Error('WhatsApp outbound message has no content');
      await socket.sendMessage(target, { text: message.text });
      return;
    }
    for (const [index, attachment] of message.attachments.entries()) {
      const data = Buffer.from(attachment.data);
      const caption = index === 0 ? message.text : undefined;
      if (attachment.mimeType.startsWith('image/')) {
        await socket.sendMessage(target, { image: data, ...(caption ? { caption } : {}) });
      } else if (attachment.mimeType.startsWith('video/')) {
        await socket.sendMessage(target, { video: data, mimetype: attachment.mimeType, ...(caption ? { caption } : {}) });
      } else if (attachment.mimeType.startsWith('audio/')) {
        if (caption) await socket.sendMessage(target, { text: caption });
        await socket.sendMessage(target, { audio: data, mimetype: attachment.mimeType, ptt: false });
      } else {
        await socket.sendMessage(target, {
          document: data,
          mimetype: attachment.mimeType,
          fileName: attachment.fileName ?? 'attachment',
          ...(caption ? { caption } : {}),
        });
      }
    }
  }

  async targets(query?: string) {
    return this.targetDirectory.list(query);
  }

  async status() {
    return this.statusTracker.snapshot();
  }

  private async connect(waitForReady: boolean): Promise<void> {
    if (this.stopped) return;
    await this.statusTracker.set('connecting');
    const { state, saveCreds } = await loadMultiFileAuthState(this.authRoot);
    const { version } = await fetchLatestBaileysVersion();
    const socket = makeWASocket({
      auth: state,
      version,
      logger: silentLogger,
      browser: ['ClawX', 'Desktop', '1.0.0'],
      syncFullHistory: false,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
    });
    this.socket = socket;
    let readyResolve: (() => void) | undefined;
    let readyReject: ((error: Error) => void) | undefined;
    const ready = new Promise<void>((resolveReady, rejectReady) => {
      readyResolve = resolveReady;
      readyReject = rejectReady;
    });
    const timeout = setTimeout(() => readyReject?.(new Error('WhatsApp readiness timed out')), 25_000);
    socket.ev.on('creds.update', () => {
      this.credentialWrite = this.credentialWrite.then(async () => {
        await saveCreds();
        const authBundle = await captureChannelAuthBundle(this.authRoot);
        await this.persistCredential(this.context.account.id, { authBundle });
      }).catch(error => this.statusTracker.set('degraded', safeConnectorError(error)));
    });
    socket.ev.on('messages.upsert', event => {
      for (const message of event.messages) {
        void this.handleMessage(message).catch(error => this.statusTracker.set('degraded', safeConnectorError(error)));
      }
    });
    socket.ev.on('connection.update', update => {
      if (update.connection === 'open') {
        clearTimeout(timeout);
        readyResolve?.();
        void this.statusTracker.set('connected');
      } else if (update.connection === 'close') {
        clearTimeout(timeout);
        const statusCode = disconnectStatus(update.lastDisconnect?.error);
        const error = new Error(statusCode === DisconnectReason.loggedOut
          ? 'WhatsApp session is logged out'
          : safeConnectorError(update.lastDisconnect?.error ?? 'WhatsApp connection closed'));
        readyReject?.(error);
        if (!this.stopped && statusCode !== DisconnectReason.loggedOut) {
          void this.statusTracker.set('degraded', error.message);
          this.reconnectTimer = setTimeout(() => {
            void this.connect(false).catch(failed => this.statusTracker.set('error', safeConnectorError(failed)));
          }, 2_000);
        } else if (!this.stopped) {
          void this.statusTracker.set('error', error.message);
        }
      }
    });
    if (waitForReady) await ready;
  }

  private async handleMessage(message: WAMessage): Promise<void> {
    const remoteJid = message.key.remoteJid;
    const externalMessageId = message.key.id;
    if (!remoteJid || !externalMessageId || message.key.fromMe || remoteJid === 'status@broadcast') return;
    const content = unwrapMessage(message.message);
    if (!content) return;
    const text = extractMessageText(content);
    const attachment = await extractMessageAttachment(message, content);
    if (!text.trim() && !attachment) return;
    const senderId = message.key.participant || remoteJid;
    const kind = remoteJid.endsWith('@g.us') ? 'group' as const : 'direct' as const;
    this.targetDirectory.observe({
      id: remoteJid,
      displayName: message.pushName || normalizeWhatsAppIdentity(remoteJid) || remoteJid,
      kind,
    });
    await this.context.onInbound({
      accountId: this.context.account.id,
      channelType: 'whatsapp',
      externalConversationId: remoteJid,
      externalMessageId,
      targetId: remoteJid,
      senderId,
      ...(message.pushName ? { senderName: message.pushName } : {}),
      ...(text ? { text } : {}),
      ...(attachment ? { attachments: [attachment] } : {}),
      receivedAt: unixTimestampIso(Number(message.messageTimestamp ?? Date.now())),
    });
  }
}

function unwrapMessage(message: proto.IMessage | null | undefined): proto.IMessage | undefined {
  let current = message ?? undefined;
  for (let depth = 0; current && depth < 4; depth += 1) {
    const nested = current.ephemeralMessage?.message
      ?? current.viewOnceMessage?.message
      ?? current.viewOnceMessageV2?.message
      ?? current.documentWithCaptionMessage?.message;
    if (!nested) break;
    current = nested;
  }
  return current;
}

function extractMessageText(message: proto.IMessage): string {
  return message.conversation
    || message.extendedTextMessage?.text
    || message.imageMessage?.caption
    || message.videoMessage?.caption
    || message.documentMessage?.caption
    || '';
}

async function extractMessageAttachment(
  envelope: WAMessage,
  message: proto.IMessage,
): Promise<ChannelInboundAttachment | undefined> {
  const descriptor = message.imageMessage
    ? { mimeType: message.imageMessage.mimetype, fileName: 'image.jpg' }
    : message.videoMessage
      ? { mimeType: message.videoMessage.mimetype, fileName: 'video.mp4' }
      : message.audioMessage
        ? { mimeType: message.audioMessage.mimetype, fileName: 'audio.ogg' }
        : message.documentMessage
          ? { mimeType: message.documentMessage.mimetype, fileName: message.documentMessage.fileName || 'document' }
          : undefined;
  if (!descriptor) return undefined;
  const data = await downloadMediaMessage(envelope, 'buffer', {});
  if (data.byteLength > CONNECTOR_ATTACHMENT_LIMIT_BYTES) throw new Error('WhatsApp attachment exceeds connector limit');
  return {
    data: new Uint8Array(data),
    mimeType: normalizeMimeType(descriptor.mimeType || ''),
    fileName: safeFileName(descriptor.fileName),
  };
}

function normalizeWhatsAppTarget(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('WhatsApp target is required');
  if (trimmed.includes('@')) return trimmed;
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) throw new Error('WhatsApp target is invalid');
  return `${digits}@s.whatsapp.net`;
}

function normalizeWhatsAppIdentity(value: string | null | undefined): string {
  return (value ?? '').split(':', 1)[0]?.split('@', 1)[0] ?? '';
}

function disconnectStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const record = error as { output?: { statusCode?: unknown }; statusCode?: unknown };
  const value = record.output?.statusCode ?? record.statusCode;
  return typeof value === 'number' ? value : undefined;
}

export function canonicalWhatsAppAccountId(nativeAccountId: string): string {
  return canonicalChannelAccountKey('whatsapp', nativeAccountId);
}
