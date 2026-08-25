import {
  WSClient,
  type BaseMessage,
  type FileMessage,
  type ImageMessage,
  type MixedMessage,
  type VideoMessage,
  type VoiceMessage,
  type WsFrame,
} from '@wecom/aibot-node-sdk';
import type { ChannelConnectorFactory, ChannelConnectorSession, ChannelOutboundEnvelope } from '../channel-runtime-contracts';
import {
  CONNECTOR_ATTACHMENT_BATCH_LIMIT_BYTES,
  CONNECTOR_ATTACHMENT_LIMIT_BYTES,
  ConnectorStatusTracker,
  EphemeralTargetDirectory,
  normalizeMimeType,
  requiredFields,
  requiredText,
  runConnectorLoop,
  safeConnectorError,
  safeFileName,
  unixTimestampIso,
} from './common';

export function createWeComConnectorFactory(): ChannelConnectorFactory {
  return {
    channelType: 'wecom',
    async validate(config) {
      return requiredFields(config, ['botId', 'secret']);
    },
    async connect(context) {
      const client = new WSClient({
        botId: requiredText(context.connectionConfig, 'botId'),
        secret: requiredText(context.connectionConfig, 'secret'),
        plug_version: 'ClawX-Channel-Relay/1',
        maxReconnectAttempts: -1,
        maxAuthFailureAttempts: 3,
      });
      const session = new WeComSession(context, client);
      await session.start();
      return session;
    },
  };
}

class WeComSession implements ChannelConnectorSession {
  private readonly statusTracker;
  private readonly targetDirectory = new EphemeralTargetDirectory();
  private stopped = false;

  constructor(
    private readonly context: Parameters<ChannelConnectorFactory['connect']>[0],
    private readonly client: WSClient,
  ) {
    this.statusTracker = new ConnectorStatusTracker(context.onStatus);
  }

  async start(): Promise<void> {
    this.client.on('message', frame => {
      runConnectorLoop(() => this.handle(frame), detail => this.statusTracker.set('degraded', detail));
    });
    this.client.on('authenticated', () => { void this.statusTracker.set('connected'); });
    this.client.on('reconnecting', () => { void this.statusTracker.set('connecting'); });
    this.client.on('disconnected', reason => {
      if (!this.stopped) void this.statusTracker.set('degraded', reason);
    });
    this.client.on('error', error => { void this.statusTracker.set('error', safeConnectorError(error)); });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WeCom authentication timed out')), 20_000);
      const authenticated = () => {
        clearTimeout(timer);
        this.client.off('error', failed);
        resolve();
      };
      const failed = (error: Error) => {
        clearTimeout(timer);
        this.client.off('authenticated', authenticated);
        reject(error);
      };
      this.client.once('authenticated', authenticated);
      this.client.once('error', failed);
      this.client.connect();
    });
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.client.removeAllListeners();
    this.client.disconnect();
    await this.statusTracker.set('disconnected');
  }

  async send(message: ChannelOutboundEnvelope): Promise<void> {
    if (message.text !== undefined) {
      await this.client.sendMessage(message.targetId, {
        msgtype: 'markdown',
        markdown: { content: message.text },
      });
    }
    for (const attachment of message.attachments) {
      const mediaType = weComMediaType(attachment.mimeType);
      const uploaded = await this.client.uploadMedia(Buffer.from(attachment.data), {
        type: mediaType,
        filename: attachment.fileName ?? `attachment.${extensionForMime(attachment.mimeType)}`,
      });
      if (!uploaded.media_id) throw new Error('WeCom media upload returned no media id');
      await this.client.sendMediaMessage(message.targetId, mediaType, uploaded.media_id);
    }
    if (message.text === undefined && message.attachments.length === 0) {
      throw new Error('WeCom outbound message has no content');
    }
  }

  async targets(query?: string) {
    return this.targetDirectory.list(query);
  }

  async status() {
    return this.statusTracker.snapshot();
  }

  private async handle(frame: WsFrame<BaseMessage>): Promise<void> {
    const message = frame.body;
    if (!message?.msgid || !message.from?.userid) return;
    const targetId = message.chattype === 'group' && message.chatid ? message.chatid : message.from.userid;
    this.targetDirectory.observe({
      id: targetId,
      displayName: message.chattype === 'group' ? `WeCom ${message.chatid}` : message.from.userid,
      kind: message.chattype === 'group' ? 'group' : 'direct',
    });
    const text = weComText(message);
    const attachments = await this.weComAttachments(message);
    if (!text?.trim() && attachments.length === 0) return;
    await this.context.onInbound({
      accountId: this.context.account.id,
      channelType: 'wecom',
      externalConversationId: targetId,
      externalMessageId: message.msgid,
      targetId,
      senderId: message.from.userid,
      senderName: message.from.userid,
      ...(text ? { text } : {}),
      ...(attachments.length ? { attachments } : {}),
      receivedAt: unixTimestampIso(message.create_time),
    });
  }

  private async weComAttachments(message: BaseMessage) {
    const candidates: Array<{ url: string; aeskey?: string; fileName?: string; mimeType: string }> = [];
    if (message.msgtype === 'image') {
      const image = (message as ImageMessage).image;
      if (image?.url) candidates.push({ url: image.url, aeskey: image.aeskey, mimeType: 'image/jpeg' });
    } else if (message.msgtype === 'file') {
      const file = (message as FileMessage).file;
      if (file?.url) candidates.push({ url: file.url, aeskey: file.aeskey, mimeType: 'application/octet-stream' });
    } else if (message.msgtype === 'video') {
      const video = (message as VideoMessage).video;
      if (video?.url) candidates.push({ url: video.url, aeskey: video.aeskey, mimeType: 'video/mp4' });
    } else if (message.msgtype === 'mixed') {
      for (const item of (message as MixedMessage).mixed?.msg_item ?? []) {
        if (item.msgtype === 'image' && item.image?.url) {
          candidates.push({ url: item.image.url, aeskey: item.image.aeskey, mimeType: 'image/jpeg' });
        }
      }
    }
    const attachments = [];
    let total = 0;
    for (const candidate of candidates) {
      try {
        const downloaded = await this.client.downloadFile(candidate.url, candidate.aeskey);
        if (downloaded.buffer.byteLength > CONNECTOR_ATTACHMENT_LIMIT_BYTES) continue;
        total += downloaded.buffer.byteLength;
        if (total > CONNECTOR_ATTACHMENT_BATCH_LIMIT_BYTES) break;
        attachments.push({
          data: new Uint8Array(downloaded.buffer),
          mimeType: normalizeMimeType(candidate.mimeType),
          ...(downloaded.filename || candidate.fileName
            ? { fileName: safeFileName(downloaded.filename || candidate.fileName!) }
            : {}),
        });
      } catch {
        // The canonical text admission remains valid when a temporary media URL expires.
      }
    }
    return attachments;
  }
}

function weComText(message: BaseMessage): string | undefined {
  if (message.msgtype === 'text') return (message as BaseMessage & { text?: { content?: string } }).text?.content;
  if (message.msgtype === 'voice') return (message as VoiceMessage).voice?.content;
  if (message.msgtype === 'mixed') {
    return (message as MixedMessage).mixed?.msg_item
      ?.filter(item => item.msgtype === 'text')
      .map(item => item.text?.content ?? '')
      .filter(Boolean)
      .join('\n');
  }
  return undefined;
}

function weComMediaType(mimeType: string): 'image' | 'voice' | 'video' | 'file' {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'voice';
  if (mimeType.startsWith('video/')) return 'video';
  return 'file';
}

function extensionForMime(mimeType: string): string {
  if (mimeType.startsWith('image/')) return 'jpg';
  if (mimeType.startsWith('audio/')) return 'mp3';
  if (mimeType.startsWith('video/')) return 'mp4';
  return 'bin';
}
