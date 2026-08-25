import WebSocket from 'ws';
import type { ChannelConnectorFactory, ChannelConnectorSession, ChannelOutboundEnvelope } from '../channel-runtime-contracts';
import {
  ConnectorStatusTracker,
  EphemeralTargetDirectory,
  downloadPortableAttachment,
  requiredFields,
  requiredText,
  runConnectorLoop,
  safeConnectorError,
  settledPortableAttachments,
  unixTimestampIso,
} from './common';

const QQ_API = 'https://api.sgroup.qq.com';
const QQ_INTENTS = (1 << 30) | 4096 | (1 << 25);

type QQGatewayPayload = { op: number; d?: unknown; s?: number; t?: string };
type QQMessage = {
  id?: string;
  content?: string;
  timestamp?: string;
  channel_id?: string;
  guild_id?: string;
  group_openid?: string;
  author?: {
    id?: string;
    username?: string;
    user_openid?: string;
    member_openid?: string;
    bot?: boolean;
  };
  attachments?: Array<{ url?: string; filename?: string; content_type?: string; size?: number }>;
};

export function createQQBotConnectorFactory(): ChannelConnectorFactory {
  return {
    channelType: 'qqbot',
    async validate(config) {
      const fields = requiredFields(config, ['appId', 'clientSecret']);
      if (!fields.valid) return fields;
      try {
        await qqAccessToken(requiredText(config, 'appId'), requiredText(config, 'clientSecret'));
        return { valid: true };
      } catch (error) {
        return { valid: false, errors: [safeConnectorError(error)] };
      }
    },
    async connect(context) {
      const appId = requiredText(context.connectionConfig, 'appId');
      const clientSecret = requiredText(context.connectionConfig, 'clientSecret');
      const session = new QQBotSession(context, appId, clientSecret);
      await session.start();
      return session;
    },
  };
}

class QQBotSession implements ChannelConnectorSession {
  private readonly statusTracker;
  private readonly targetDirectory = new EphemeralTargetDirectory();
  private socket?: WebSocket;
  private heartbeat?: ReturnType<typeof setInterval>;
  private reconnect?: ReturnType<typeof setTimeout>;
  private sequence: number | null = null;
  private stopped = false;

  constructor(
    private readonly context: Parameters<ChannelConnectorFactory['connect']>[0],
    private readonly appId: string,
    private readonly clientSecret: string,
  ) {
    this.statusTracker = new ConnectorStatusTracker(context.onStatus);
  }

  async start(): Promise<void> {
    await this.connect(true);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.reconnect) clearTimeout(this.reconnect);
    this.socket?.close(1000, 'ClawX relay stopped');
    await this.statusTracker.set('disconnected');
  }

  async send(message: ChannelOutboundEnvelope): Promise<void> {
    const token = await qqAccessToken(this.appId, this.clientSecret);
    const target = parseTarget(message.targetId);
    const text = `${message.text ?? ''}${message.attachments.length
      ? `\n${message.attachments.map(item => `📎 ${item.fileName ?? item.mimeType}`).join('\n')}`
      : ''}`.trim();
    if (target.kind === 'c2c' || target.kind === 'group') {
      if (message.attachments.length === 0) {
        await qqRequest(token, this.appId, target.path, {
          msg_type: 0,
          content: text,
          msg_seq: Date.now() % 65_536,
          ...(message.replyToExternalMessageId ? { msg_id: message.replyToExternalMessageId } : {}),
        });
        return;
      }
      for (const [index, attachment] of message.attachments.entries()) {
        const upload = await qqRequest<{ file_info?: string }>(token, this.appId, target.filePath!, {
          file_type: qqFileType(attachment.mimeType),
          file_data: Buffer.from(attachment.data).toString('base64'),
          srv_send_msg: false,
          ...(attachment.fileName ? { file_name: attachment.fileName } : {}),
        });
        if (!upload.file_info) throw new Error('QQ Bot media upload returned no file_info');
        await qqRequest(token, this.appId, target.path, {
          msg_type: 7,
          media: { file_info: upload.file_info },
          msg_seq: (Date.now() + index) % 65_536,
          ...(index === 0 && text ? { content: text } : {}),
          ...(message.replyToExternalMessageId ? { msg_id: message.replyToExternalMessageId } : {}),
        });
      }
      return;
    }
    await qqRequest(token, this.appId, target.path, {
      content: text,
      ...(message.replyToExternalMessageId ? { msg_id: message.replyToExternalMessageId } : {}),
    });
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
    const token = await qqAccessToken(this.appId, this.clientSecret);
    const gateway = await qqRequest<{ url?: string }>(token, this.appId, '/gateway', undefined, 'GET');
    if (!gateway.url?.startsWith('wss://')) throw new Error('QQ Bot Gateway returned an invalid URL');
    const socket = new WebSocket(gateway.url, { handshakeTimeout: 15_000 });
    this.socket = socket;
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('QQ Bot Gateway readiness timed out')), 20_000);
      socket.once('error', error => {
        clearTimeout(timer);
        reject(error);
      });
      socket.on('message', raw => {
        runConnectorLoop(() => this.handleGateway(raw.toString(), token, () => {
          clearTimeout(timer);
          resolve();
        }), detail => this.statusTracker.set('degraded', detail));
      });
    });
    socket.on('close', () => {
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = undefined;
      if (!this.stopped) {
        void this.statusTracker.set('degraded', 'QQ Bot Gateway disconnected');
        this.reconnect = setTimeout(() => {
          this.reconnect = undefined;
          void this.connect(false).catch(error => this.statusTracker.set('error', safeConnectorError(error)));
        }, 2_000);
        this.reconnect.unref?.();
      }
    });
    if (waitForReady) await ready;
    else void ready.catch(() => undefined);
  }

  private async handleGateway(raw: string, token: string, onReady: () => void): Promise<void> {
    const payload = JSON.parse(raw) as QQGatewayPayload;
    if (typeof payload.s === 'number') this.sequence = payload.s;
    if (payload.op === 10) {
      const interval = Number((payload.d as { heartbeat_interval?: unknown } | undefined)?.heartbeat_interval);
      if (!Number.isFinite(interval) || interval < 1_000) throw new Error('QQ Bot heartbeat interval is invalid');
      this.socket?.send(JSON.stringify({
        op: 2,
        d: { token: `QQBot ${token}`, intents: QQ_INTENTS, shard: [0, 1] },
      }));
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => {
        this.socket?.send(JSON.stringify({ op: 1, d: this.sequence }));
      }, interval);
      this.heartbeat.unref?.();
      return;
    }
    if (payload.op === 7 || payload.op === 9) {
      this.socket?.close(4000, 'QQ Bot requested reconnect');
      return;
    }
    if (payload.op !== 0) return;
    if (payload.t === 'READY' || payload.t === 'RESUMED') {
      await this.statusTracker.set('connected');
      onReady();
      return;
    }
    if (payload.t && [
      'C2C_MESSAGE_CREATE',
      'GROUP_AT_MESSAGE_CREATE',
      'GROUP_MESSAGE_CREATE',
      'AT_MESSAGE_CREATE',
      'DIRECT_MESSAGE_CREATE',
    ].includes(payload.t)) {
      await this.handleMessage(payload.t, payload.d as QQMessage);
    }
  }

  private async handleMessage(eventType: string, message: QQMessage): Promise<void> {
    if (!message.id || message.author?.bot) return;
    let targetId: string;
    let kind: 'direct' | 'group' | 'room';
    if (eventType === 'C2C_MESSAGE_CREATE') {
      const id = message.author?.user_openid;
      if (!id) return;
      targetId = `qqbot:c2c:${id}`;
      kind = 'direct';
    } else if (eventType.startsWith('GROUP_')) {
      if (!message.group_openid) return;
      targetId = `qqbot:group:${message.group_openid}`;
      kind = 'group';
    } else if (eventType === 'DIRECT_MESSAGE_CREATE') {
      if (!message.guild_id) return;
      targetId = `qqbot:dm:${message.guild_id}`;
      kind = 'direct';
    } else {
      if (!message.channel_id) return;
      targetId = `qqbot:guild-channel:${message.channel_id}`;
      kind = 'room';
    }
    const senderId = message.author?.member_openid || message.author?.user_openid || message.author?.id;
    const attachments = await settledPortableAttachments((message.attachments ?? [])
      .filter(attachment => Boolean(attachment.url))
      .map(attachment => () => downloadPortableAttachment({
        url: attachment.url!,
        mimeType: attachment.content_type,
        fileName: attachment.filename,
      })));
    if (!message.content?.trim() && attachments.length === 0) return;
    this.targetDirectory.observe({ id: targetId, displayName: message.author?.username || targetId, kind });
    await this.context.onInbound({
      accountId: this.context.account.id,
      channelType: 'qqbot',
      externalConversationId: targetId,
      externalMessageId: message.id,
      targetId,
      ...(senderId ? { senderId } : {}),
      ...(message.author?.username ? { senderName: message.author.username } : {}),
      ...(message.content !== undefined ? { text: message.content } : {}),
      ...(attachments.length ? { attachments } : {}),
      receivedAt: unixTimestampIso(message.timestamp ? Date.parse(message.timestamp) : Date.now()),
    });
  }
}

const qqTokens = new Map<string, { token: string; expiresAt: number }>();

async function qqAccessToken(appId: string, clientSecret: string): Promise<string> {
  const cached = qqTokens.get(appId);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const response = await fetch('https://bots.qq.com/app/getAppAccessToken', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ appId, clientSecret }),
  });
  const payload = await response.json() as { access_token?: string; expires_in?: number; message?: string };
  if (!response.ok || !payload.access_token) throw new Error(payload.message || `QQ Bot authentication failed (${response.status})`);
  qqTokens.set(appId, {
    token: payload.access_token,
    expiresAt: Date.now() + Math.max(payload.expires_in ?? 7_200, 60) * 1_000,
  });
  return payload.access_token;
}

async function qqRequest<T = unknown>(
  token: string,
  appId: string,
  path: string,
  body?: Record<string, unknown>,
  method = 'POST',
): Promise<T> {
  const response = await fetch(`${QQ_API}${path}`, {
    method,
    headers: {
      authorization: `QQBot ${token}`,
      'x-union-appid': appId,
      'content-type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const raw = await response.text();
  if (!response.ok) {
    let detail = `QQ Bot request failed (${response.status})`;
    try {
      const payload = JSON.parse(raw) as { message?: string };
      if (payload.message) detail = payload.message;
    } catch { /* response may not be JSON */ }
    throw new Error(detail);
  }
  return (raw ? JSON.parse(raw) : {}) as T;
}

function parseTarget(value: string): { kind: 'c2c' | 'group' | 'guild' | 'dm'; path: string; filePath?: string } {
  const raw = value.replace(/^qqbot:/, '');
  if (raw.startsWith('c2c:')) {
    const id = raw.slice(4);
    return { kind: 'c2c', path: `/v2/users/${id}/messages`, filePath: `/v2/users/${id}/files` };
  }
  if (raw.startsWith('group:')) {
    const id = raw.slice(6);
    return { kind: 'group', path: `/v2/groups/${id}/messages`, filePath: `/v2/groups/${id}/files` };
  }
  if (raw.startsWith('guild-channel:')) return { kind: 'guild', path: `/channels/${raw.slice(14)}/messages` };
  if (raw.startsWith('dm:')) return { kind: 'dm', path: `/dms/${raw.slice(3)}/messages` };
  throw new Error('QQ Bot target must identify c2c, group, guild-channel or dm scope');
}

function qqFileType(mimeType: string): number {
  if (mimeType.startsWith('image/')) return 1;
  if (mimeType.startsWith('video/')) return 2;
  if (mimeType.startsWith('audio/')) return 3;
  return 4;
}
