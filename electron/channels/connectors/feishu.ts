import { createLarkChannel, type LarkChannel, type NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { ChannelConnectorFactory, ChannelConnectorSession, ChannelOutboundEnvelope } from '../channel-runtime-contracts';
import {
  CONNECTOR_ATTACHMENT_BATCH_LIMIT_BYTES,
  CONNECTOR_ATTACHMENT_LIMIT_BYTES,
  ConnectorStatusTracker,
  EphemeralTargetDirectory,
  normalizeMimeType,
  optionalText,
  requiredFields,
  requiredText,
  runConnectorLoop,
  safeConnectorError,
  safeFileName,
  unixTimestampIso,
} from './common';

export function createFeishuConnectorFactory(): ChannelConnectorFactory {
  return {
    channelType: 'feishu',
    async validate(config) {
      const fields = requiredFields(config, ['appId', 'appSecret']);
      if (!fields.valid) return fields;
      try {
        const base = resolveDomain(optionalText(config, 'domain'));
        const response = await fetch(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ app_id: requiredText(config, 'appId'), app_secret: requiredText(config, 'appSecret') }),
        });
        const payload = await response.json() as { code?: number; msg?: string; tenant_access_token?: string };
        if (!response.ok || payload.code !== 0 || !payload.tenant_access_token) {
          throw new Error(payload.msg || `Feishu validation failed (${response.status})`);
        }
        return { valid: true };
      } catch (error) {
        return { valid: false, errors: [safeConnectorError(error)] };
      }
    },
    async connect(context) {
      const channel = createLarkChannel({
        appId: requiredText(context.connectionConfig, 'appId'),
        appSecret: requiredText(context.connectionConfig, 'appSecret'),
        transport: 'websocket',
        domain: resolveDomain(optionalText(context.connectionConfig, 'domain')),
        source: 'ClawX-Channel-Relay',
        includeRawInMessage: false,
        safety: {
          dedup: { ttl: 60_000, maxEntries: 2_000 },
          chatQueue: { enabled: false },
        },
      });
      const session = new FeishuSession(context, channel);
      await session.start();
      return session;
    },
  };
}

class FeishuSession implements ChannelConnectorSession {
  private readonly statusTracker;
  private readonly targetDirectory = new EphemeralTargetDirectory();
  private readonly disposers: Array<() => void> = [];
  private stopped = false;

  constructor(
    private readonly context: Parameters<ChannelConnectorFactory['connect']>[0],
    private readonly channel: LarkChannel,
  ) {
    this.statusTracker = new ConnectorStatusTracker(context.onStatus);
  }

  async start(): Promise<void> {
    this.disposers.push(this.channel.on('message', message => {
      runConnectorLoop(() => this.handleMessage(message), detail => this.statusTracker.set('degraded', detail));
    }));
    this.disposers.push(this.channel.on('error', error => {
      void this.statusTracker.set('degraded', safeConnectorError(error));
    }));
    this.disposers.push(this.channel.on('reconnecting', () => {
      void this.statusTracker.set('connecting');
    }));
    this.disposers.push(this.channel.on('reconnected', () => {
      void this.statusTracker.set('connected');
    }));
    await this.channel.connect();
    await this.statusTracker.set('connected');
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const dispose of this.disposers.splice(0)) dispose();
    await this.channel.disconnect();
    await this.statusTracker.set('disconnected');
  }

  async send(message: ChannelOutboundEnvelope): Promise<void> {
    const options = message.replyToExternalMessageId ? { replyTo: message.replyToExternalMessageId } : undefined;
    if (message.text !== undefined) await this.channel.send(message.targetId, { text: message.text }, options);
    for (const attachment of message.attachments) {
      const buffer = Buffer.from(attachment.data);
      if (attachment.mimeType.startsWith('image/')) {
        await this.channel.send(message.targetId, { image: { source: buffer } }, options);
      } else {
        await this.channel.send(message.targetId, {
          file: { source: buffer, fileName: attachment.fileName ?? 'attachment' },
        }, options);
      }
    }
    if (message.text === undefined && message.attachments.length === 0) {
      throw new Error('Feishu outbound message has no content');
    }
  }

  async targets(query?: string) {
    return this.targetDirectory.list(query);
  }

  async status() {
    return this.statusTracker.snapshot();
  }

  private async handleMessage(message: NormalizedMessage): Promise<void> {
    let displayName: string;
    try {
      const info = await this.channel.getChatInfo(message.chatId);
      displayName = info.name || message.senderName || message.chatId;
    } catch {
      displayName = message.senderName || message.chatId;
    }
    this.targetDirectory.observe({
      id: message.chatId,
      displayName,
      kind: message.chatType === 'p2p' ? 'direct' : 'group',
      ...(message.threadId ? { metadata: { threadId: message.threadId } } : {}),
    });
    const attachments = [];
    let total = 0;
    for (const resource of message.resources.slice(0, 20)) {
      try {
        const data = await this.channel.downloadResource(resource.fileKey, resource.type === 'image' ? 'image' : 'file');
        if (data.byteLength > CONNECTOR_ATTACHMENT_LIMIT_BYTES) continue;
        total += data.byteLength;
        if (total > CONNECTOR_ATTACHMENT_BATCH_LIMIT_BYTES) break;
        attachments.push({
          data: new Uint8Array(data),
          mimeType: normalizeMimeType(mimeForResource(resource.type, resource.fileName)),
          ...(resource.fileName ? { fileName: safeFileName(resource.fileName) } : {}),
        });
      } catch {
        // Resource download is best effort; canonical admission still owns retry semantics.
      }
    }
    if (!message.content.trim() && attachments.length === 0) return;
    await this.context.onInbound({
      accountId: this.context.account.id,
      channelType: 'feishu',
      externalConversationId: message.threadId ? `${message.chatId}:${message.threadId}` : message.chatId,
      externalMessageId: message.messageId,
      targetId: message.chatId,
      senderId: message.senderId,
      ...(message.senderName ? { senderName: message.senderName } : {}),
      ...(message.content ? { text: message.content } : {}),
      ...(attachments.length ? { attachments } : {}),
      ...(message.replyToMessageId ? { replyToExternalMessageId: message.replyToMessageId } : {}),
      receivedAt: unixTimestampIso(message.createTime),
    });
  }
}

function resolveDomain(domain: string | undefined): string {
  if (!domain || domain === 'feishu') return 'https://open.feishu.cn';
  if (domain === 'lark') return 'https://open.larksuite.com';
  try {
    const parsed = new URL(domain);
    if (parsed.protocol !== 'https:') throw new Error('Feishu domain must use HTTPS');
    return parsed.origin;
  } catch {
    throw new Error('Feishu domain is invalid');
  }
}

function mimeForResource(type: string, fileName?: string): string {
  if (type === 'image') return 'image/jpeg';
  if (type === 'audio') return 'audio/mpeg';
  if (type === 'video') return 'video/mp4';
  const extension = fileName?.split('.').at(-1)?.toLowerCase();
  if (extension === 'pdf') return 'application/pdf';
  if (extension === 'png') return 'image/png';
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  return 'application/octet-stream';
}
