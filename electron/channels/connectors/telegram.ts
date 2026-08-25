import type { ChannelConnectorFactory, ChannelConnectorSession, ChannelOutboundEnvelope } from '../channel-runtime-contracts';
import {
  ConnectorStatusTracker,
  EphemeralTargetDirectory,
  downloadPortableAttachment,
  optionalText,
  parseCsvSet,
  requiredFields,
  requiredText,
  runConnectorLoop,
  safeConnectorError,
  settledPortableAttachments,
  unixTimestampIso,
} from './common';

type TelegramResponse<T> = { ok: boolean; result?: T; description?: string };
type TelegramUpdate = { update_id: number; message?: TelegramMessage; edited_message?: TelegramMessage };
type TelegramMessage = {
  message_id: number;
  date: number;
  message_thread_id?: number;
  text?: string;
  caption?: string;
  chat: { id: number; type: string; title?: string; username?: string; first_name?: string; last_name?: string };
  from?: { id: number; username?: string; first_name?: string; last_name?: string; is_bot?: boolean };
  reply_to_message?: { message_id?: number };
  photo?: Array<{ file_id: string; file_size?: number; width?: number; height?: number }>;
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  audio?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  video?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  voice?: { file_id: string; mime_type?: string; file_size?: number };
};

export function createTelegramConnectorFactory(): ChannelConnectorFactory {
  return {
    channelType: 'telegram',
    async validate(config) {
      const fields = requiredFields(config, ['botToken', 'allowedUsers']);
      if (!fields.valid) return fields;
      try {
        const bot = await telegramCall<{ id: number; username?: string }>(requiredText(config, 'botToken'), 'getMe', {});
        return { valid: true, details: { bot: bot.username ? `@${bot.username}` : String(bot.id) } };
      } catch (error) {
        return { valid: false, errors: [safeConnectorError(error)] };
      }
    },
    async connect(context) {
      const token = requiredText(context.connectionConfig, 'botToken');
      const allowedUsers = parseCsvSet(optionalText(context.connectionConfig, 'allowedUsers'));
      const bot = await telegramCall<{ id: number; username?: string }>(token, 'getMe', {});
      const session = new TelegramSession(context, token, allowedUsers, bot.id);
      await session.start();
      return session;
    },
  };
}

class TelegramSession implements ChannelConnectorSession {
  private readonly abort = new AbortController();
  private readonly statusTracker;
  private readonly targetDirectory = new EphemeralTargetDirectory();
  private nextOffset: number | undefined;
  private stopped = false;

  constructor(
    private readonly context: Parameters<ChannelConnectorFactory['connect']>[0],
    private readonly token: string,
    private readonly allowedUsers: Set<string>,
    private readonly botId: number,
  ) {
    this.statusTracker = new ConnectorStatusTracker(context.onStatus);
  }

  async start(): Promise<void> {
    await this.statusTracker.set('connected');
    runConnectorLoop(() => this.poll(), message => this.statusTracker.set('error', message));
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.abort.abort();
    await this.statusTracker.set('disconnected');
  }

  async send(message: ChannelOutboundEnvelope): Promise<void> {
    const [chatId, threadId] = message.targetId.split('#', 2);
    if (!chatId) throw new Error('Telegram target is required');
    const common: Record<string, unknown> = {
      chat_id: chatId,
      ...(threadId ? { message_thread_id: Number(threadId) } : {}),
      ...(message.replyToExternalMessageId ? {
        reply_parameters: { message_id: Number(message.replyToExternalMessageId) },
      } : {}),
    };
    if (message.attachments.length === 0) {
      if (message.text === undefined) throw new Error('Telegram outbound message has no content');
      await telegramCall(this.token, 'sendMessage', { ...common, text: message.text });
      return;
    }
    for (const [index, attachment] of message.attachments.entries()) {
      const method = attachment.mimeType.startsWith('image/') ? 'sendPhoto' : 'sendDocument';
      const field = method === 'sendPhoto' ? 'photo' : 'document';
      const form = new FormData();
      for (const [key, value] of Object.entries(common)) {
        form.append(key, typeof value === 'string' ? value : JSON.stringify(value));
      }
      form.append(field, new Blob([attachment.data], { type: attachment.mimeType }), attachment.fileName ?? `attachment-${index + 1}`);
      if (index === 0 && message.text) form.append('caption', message.text);
      await telegramCallForm(this.token, method, form);
    }
  }

  async targets(query?: string) {
    return this.targetDirectory.list(query);
  }

  async status() {
    return this.statusTracker.snapshot();
  }

  private async poll(): Promise<void> {
    while (!this.abort.signal.aborted) {
      try {
        const updates = await telegramCall<TelegramUpdate[]>(this.token, 'getUpdates', {
          timeout: 30,
          allowed_updates: ['message', 'edited_message'],
          ...(this.nextOffset !== undefined ? { offset: this.nextOffset } : {}),
        }, this.abort.signal);
        for (const update of updates) {
          this.nextOffset = Math.max(this.nextOffset ?? 0, update.update_id + 1);
          const message = update.message ?? update.edited_message;
          if (message) await this.handle(message);
        }
        if (this.statusTracker.snapshot().state !== 'connected') await this.statusTracker.set('connected');
      } catch (error) {
        if (this.abort.signal.aborted) return;
        await this.statusTracker.set('degraded', safeConnectorError(error));
        await abortableDelay(2_000, this.abort.signal);
      }
    }
  }

  private async handle(message: TelegramMessage): Promise<void> {
    if (message.from?.is_bot || message.from?.id === this.botId) return;
    if (!this.isAllowed(message)) return;
    const chatId = String(message.chat.id);
    const targetId = message.message_thread_id ? `${chatId}#${message.message_thread_id}` : chatId;
    const displayName = message.chat.title
      || message.chat.username
      || [message.chat.first_name, message.chat.last_name].filter(Boolean).join(' ')
      || targetId;
    this.targetDirectory.observe({
      id: targetId,
      displayName,
      kind: message.chat.type === 'private' ? 'direct' : 'group',
    });
    const attachments = await this.loadAttachments(message);
    const text = message.text ?? message.caption;
    if (!text?.trim() && attachments.length === 0) return;
    await this.context.onInbound({
      accountId: this.context.account.id,
      channelType: 'telegram',
      externalConversationId: targetId,
      externalMessageId: String(message.message_id),
      targetId,
      ...(message.from ? { senderId: String(message.from.id) } : {}),
      ...(message.from ? {
        senderName: message.from.username
          || [message.from.first_name, message.from.last_name].filter(Boolean).join(' ')
          || String(message.from.id),
      } : {}),
      ...(text !== undefined ? { text } : {}),
      ...(attachments.length ? { attachments } : {}),
      ...(message.reply_to_message?.message_id !== undefined
        ? { replyToExternalMessageId: String(message.reply_to_message.message_id) }
        : {}),
      receivedAt: unixTimestampIso(message.date),
    });
  }

  private isAllowed(message: TelegramMessage): boolean {
    if (this.allowedUsers.has('*')) return true;
    const id = message.from ? String(message.from.id) : '';
    const username = message.from?.username ?? '';
    return this.allowedUsers.has(id) || (username !== '' && this.allowedUsers.has(username));
  }

  private async loadAttachments(message: TelegramMessage) {
    const media = [
      ...(message.photo?.length ? [{ ...message.photo.at(-1)!, mime_type: 'image/jpeg', file_name: 'photo.jpg' }] : []),
      ...(message.document ? [message.document] : []),
      ...(message.audio ? [message.audio] : []),
      ...(message.video ? [message.video] : []),
      ...(message.voice ? [{ ...message.voice, file_name: 'voice.ogg' }] : []),
    ];
    return settledPortableAttachments(media.map(item => async () => {
      const file = await telegramCall<{ file_path?: string }>(this.token, 'getFile', { file_id: item.file_id }, this.abort.signal);
      if (!file.file_path) throw new Error('Telegram file path unavailable');
      return downloadPortableAttachment({
        url: `https://api.telegram.org/file/bot${this.token}/${file.file_path}`,
        mimeType: item.mime_type,
        fileName: item.file_name,
        signal: this.abort.signal,
      });
    }));
  }
}

async function telegramCall<T>(
  token: string,
  method: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const payload = await response.json() as TelegramResponse<T>;
  if (!response.ok || !payload.ok || payload.result === undefined) {
    throw new Error(payload.description || `Telegram ${method} failed (${response.status})`);
  }
  return payload.result;
}

async function telegramCallForm(token: string, method: string, body: FormData): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', body });
  const payload = await response.json() as TelegramResponse<unknown>;
  if (!response.ok || !payload.ok) throw new Error(payload.description || `Telegram ${method} failed (${response.status})`);
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
