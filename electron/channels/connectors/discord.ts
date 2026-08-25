import WebSocket from 'ws';
import type { ChannelConnectorFactory, ChannelConnectorSession, ChannelOutboundEnvelope } from '../channel-runtime-contracts';
import {
  ConnectorStatusTracker,
  EphemeralTargetDirectory,
  downloadPortableAttachment,
  optionalText,
  requiredFields,
  requiredText,
  runConnectorLoop,
  safeConnectorError,
  settledPortableAttachments,
  unixTimestampIso,
} from './common';

const DISCORD_API = 'https://discord.com/api/v10';
const DISCORD_GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json';
const DISCORD_INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);

type DiscordGatewayPayload = { op: number; d?: unknown; s?: number; t?: string };
type DiscordMessage = {
  id: string;
  channel_id: string;
  guild_id?: string;
  content?: string;
  timestamp?: string;
  author?: { id: string; username?: string; global_name?: string; bot?: boolean };
  member?: { nick?: string };
  message_reference?: { message_id?: string };
  attachments?: Array<{ url: string; filename: string; content_type?: string; size?: number }>;
};

export function createDiscordConnectorFactory(): ChannelConnectorFactory {
  return {
    channelType: 'discord',
    async validate(config) {
      const fields = requiredFields(config, ['token', 'guildId']);
      if (!fields.valid) return fields;
      try {
        const me = await discordRequest<{ id: string; username: string }>(requiredText(config, 'token'), '/users/@me');
        return { valid: true, details: { bot: `${me.username} (${me.id})` } };
      } catch (error) {
        return { valid: false, errors: [safeConnectorError(error)] };
      }
    },
    async connect(context) {
      const token = requiredText(context.connectionConfig, 'token');
      await discordRequest(token, '/users/@me');
      const session = new DiscordSession(
        context,
        token,
        requiredText(context.connectionConfig, 'guildId'),
        optionalText(context.connectionConfig, 'channelId'),
      );
      await session.start();
      return session;
    },
  };
}

class DiscordSession implements ChannelConnectorSession {
  private readonly statusTracker;
  private readonly targetDirectory = new EphemeralTargetDirectory();
  private socket?: WebSocket;
  private heartbeat?: ReturnType<typeof setInterval>;
  private reconnect?: ReturnType<typeof setTimeout>;
  private sequence: number | null = null;
  private stopped = false;

  constructor(
    private readonly context: Parameters<ChannelConnectorFactory['connect']>[0],
    private readonly token: string,
    private readonly guildId: string,
    private readonly configuredChannelId?: string,
  ) {
    this.statusTracker = new ConnectorStatusTracker(context.onStatus);
    if (configuredChannelId) {
      this.targetDirectory.observe({ id: configuredChannelId, displayName: configuredChannelId, kind: 'room' });
    }
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
    this.socket = undefined;
    await this.statusTracker.set('disconnected');
  }

  async send(message: ChannelOutboundEnvelope): Promise<void> {
    const channelId = message.targetId.replace(/^discord:/, '').trim();
    if (!channelId) throw new Error('Discord channel target is required');
    const form = new FormData();
    const payload = {
      ...(message.text !== undefined ? { content: message.text } : {}),
      ...(message.replyToExternalMessageId ? {
        message_reference: { message_id: message.replyToExternalMessageId, fail_if_not_exists: false },
      } : {}),
      ...(message.attachments.length ? {
        attachments: message.attachments.map((attachment, index) => ({
          id: index,
          filename: attachment.fileName ?? `attachment-${index + 1}`,
        })),
      } : {}),
    };
    form.append('payload_json', JSON.stringify(payload));
    for (const [index, attachment] of message.attachments.entries()) {
      form.append(
        `files[${index}]`,
        new Blob([attachment.data], { type: attachment.mimeType }),
        attachment.fileName ?? `attachment-${index + 1}`,
      );
    }
    await discordRequest(this.token, `/channels/${encodeURIComponent(channelId)}/messages`, {
      method: 'POST',
      body: form,
      idempotencyKey: message.externalMessageId,
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
    const socket = new WebSocket(DISCORD_GATEWAY, { handshakeTimeout: 15_000 });
    this.socket = socket;
    const ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Discord Gateway readiness timed out')), 20_000);
      const onReady = () => {
        clearTimeout(timeout);
        resolve();
      };
      socket.once('error', error => {
        clearTimeout(timeout);
        reject(error);
      });
      socket.on('message', raw => {
        runConnectorLoop(() => this.handleGateway(raw.toString(), onReady), message => this.statusTracker.set('degraded', message));
      });
    });
    socket.on('close', () => {
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = undefined;
      if (!this.stopped) {
        void this.statusTracker.set('degraded', 'Discord Gateway disconnected');
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

  private async handleGateway(raw: string, onReady: () => void): Promise<void> {
    const payload = JSON.parse(raw) as DiscordGatewayPayload;
    if (typeof payload.s === 'number') this.sequence = payload.s;
    if (payload.op === 10) {
      const interval = Number((payload.d as { heartbeat_interval?: unknown } | undefined)?.heartbeat_interval);
      if (!Number.isFinite(interval) || interval < 1_000) throw new Error('Discord heartbeat interval is invalid');
      if (this.heartbeat) clearInterval(this.heartbeat);
      const beat = () => this.socket?.send(JSON.stringify({ op: 1, d: this.sequence }));
      this.heartbeat = setInterval(beat, interval);
      this.heartbeat.unref?.();
      this.socket?.send(JSON.stringify({
        op: 2,
        d: {
          token: this.token,
          intents: DISCORD_INTENTS,
          properties: { os: process.platform, browser: 'ClawX', device: 'ClawX' },
        },
      }));
      return;
    }
    if (payload.op === 7 || payload.op === 9) {
      this.socket?.close(4000, 'Discord requested reconnect');
      return;
    }
    if (payload.op !== 0) return;
    if (payload.t === 'READY' || payload.t === 'RESUMED') {
      await this.statusTracker.set('connected');
      onReady();
      return;
    }
    if (payload.t === 'MESSAGE_CREATE') await this.handleMessage(payload.d as DiscordMessage);
  }

  private async handleMessage(message: DiscordMessage): Promise<void> {
    if (message.author?.bot) return;
    if (message.guild_id && message.guild_id !== this.guildId) return;
    if (this.configuredChannelId && message.channel_id !== this.configuredChannelId) return;
    const senderName = message.member?.nick || message.author?.global_name || message.author?.username || message.author?.id;
    this.targetDirectory.observe({
      id: message.channel_id,
      displayName: message.guild_id ? `Discord #${message.channel_id}` : (senderName || message.channel_id),
      kind: message.guild_id ? 'room' : 'direct',
      metadata: message.guild_id ? { guildId: message.guild_id } : undefined,
    });
    const attachments = await settledPortableAttachments((message.attachments ?? []).map(attachment => () => (
      downloadPortableAttachment({
        url: attachment.url,
        mimeType: attachment.content_type,
        fileName: attachment.filename,
      })
    )));
    if (!message.content?.trim() && attachments.length === 0) return;
    await this.context.onInbound({
      accountId: this.context.account.id,
      channelType: 'discord',
      externalConversationId: message.channel_id,
      externalMessageId: message.id,
      targetId: message.channel_id,
      ...(message.author?.id ? { senderId: message.author.id } : {}),
      ...(senderName ? { senderName } : {}),
      ...(message.content !== undefined ? { text: message.content } : {}),
      ...(attachments.length ? { attachments } : {}),
      ...(message.message_reference?.message_id ? { replyToExternalMessageId: message.message_reference.message_id } : {}),
      receivedAt: unixTimestampIso(message.timestamp ? Date.parse(message.timestamp) : Date.now()),
    });
  }
}

async function discordRequest<T = unknown>(
  token: string,
  path: string,
  options: { method?: string; body?: FormData | string; idempotencyKey?: string } = {},
): Promise<T> {
  const response = await fetch(`${DISCORD_API}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      authorization: `Bot ${token}`,
      ...(options.idempotencyKey ? { 'x-idempotency-key': options.idempotencyKey } : {}),
    },
    body: options.body,
  });
  const body = await response.text();
  if (!response.ok) {
    let detail = `Discord request failed (${response.status})`;
    try {
      const parsed = JSON.parse(body) as { message?: string };
      if (parsed.message) detail = parsed.message;
    } catch { /* response may not be JSON */ }
    throw new Error(detail);
  }
  return (body ? JSON.parse(body) : {}) as T;
}
