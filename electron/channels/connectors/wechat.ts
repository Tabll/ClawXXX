import { randomBytes } from 'node:crypto';
import {
  DEFAULT_WECHAT_BASE_URL,
  cancelWeChatLoginSession,
  startWeChatLoginSession,
  waitForWeChatLoginSession,
} from '../../utils/wechat-login';
import type {
  ChannelConnectorFactory,
  ChannelConnectorSession,
  ChannelInboundAttachment,
  ChannelOutboundEnvelope,
} from '../channel-runtime-contracts';
import {
  ConnectorStatusTracker,
  EphemeralTargetDirectory,
  optionalText,
  requiredFields,
  requiredText,
  runConnectorLoop,
  safeConnectorError,
  settledPortableAttachments,
  unixTimestampIso,
} from './common';
import {
  DEFAULT_WECHAT_CDN_BASE_URL,
  downloadWeChatMedia,
  uploadWeChatMedia,
  type WeChatInboundMedia,
  type WeChatUploadUrlResponse,
} from './wechat-media';

const WECHAT_LONG_POLL_MS = 35_000;
const WECHAT_API_TIMEOUT_MS = 15_000;
const WECHAT_QR_TIMEOUT_MS = 8 * 60_000;

type WeChatMedia = {
  full_url?: string;
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
};
type WeChatItem = {
  type?: number;
  text_item?: { text?: string; ref_msg?: { message_id?: string } };
  voice_item?: { text?: string; media?: WeChatMedia };
  image_item?: { media?: WeChatMedia; aeskey?: string };
  video_item?: { media?: WeChatMedia; video_size?: number };
  file_item?: { media?: WeChatMedia; file_name?: string; len?: string };
};
type WeChatMessage = {
  seq?: number | string;
  message_id?: string;
  from_user_id?: string;
  create_time_ms?: number | string;
  context_token?: string;
  item_list?: WeChatItem[];
};
type WeChatUpdates = {
  ret?: number;
  errmsg?: string;
  msgs?: WeChatMessage[];
  get_updates_buf?: string;
};

export function createWeChatConnectorFactory(): ChannelConnectorFactory {
  const loginSessions = new Map<string, string>();
  return {
    channelType: 'wechat',
    async validate(config) {
      const fields = requiredFields(config, ['botToken']);
      if (!fields.valid) return fields;
      try {
        normalizeBaseUrl(optionalText(config, 'baseUrl'));
        return { valid: true };
      } catch (error) {
        return { valid: false, errors: [safeConnectorError(error)] };
      }
    },
    async connect(context) {
      const session = new WeChatSession(
        context,
        requiredText(context.connectionConfig, 'botToken'),
        normalizeBaseUrl(optionalText(context.connectionConfig, 'baseUrl')),
      );
      await session.start();
      return session;
    },
    async startLogin(nativeAccountId, emit) {
      const key = nativeAccountId?.trim() || 'default';
      const previous = loginSessions.get(key);
      if (previous) await cancelWeChatLoginSession(previous);
      const started = await startWeChatLoginSession({
        ...(nativeAccountId ? { accountId: nativeAccountId } : {}),
        force: true,
      });
      if (!started.sessionKey || !started.qrcodeUrl) throw new Error(started.message || 'WeChat QR login failed');
      loginSessions.set(key, started.sessionKey);
      emit({ type: 'qr', qr: started.qrcodeUrl, sessionKey: started.sessionKey });
      void waitForWeChatLoginSession({
        sessionKey: started.sessionKey,
        timeoutMs: WECHAT_QR_TIMEOUT_MS,
        ...(nativeAccountId ? { accountId: nativeAccountId } : {}),
        onQrRefresh: payload => emit({ type: 'qr', qr: payload.qrcodeUrl, sessionKey: started.sessionKey }),
      }).then(result => {
        loginSessions.delete(key);
        if (!result.connected || !result.botToken) {
          emit({ type: 'error', message: result.message });
          return;
        }
        emit({
          type: 'success',
          nativeAccountId: result.accountId || nativeAccountId || 'default',
          message: result.message,
          credential: {
            botToken: result.botToken,
            baseUrl: result.baseUrl || DEFAULT_WECHAT_BASE_URL,
            ...(result.userId ? { userId: result.userId } : {}),
          },
        });
      }).catch(error => {
        loginSessions.delete(key);
        emit({ type: 'error', message: safeConnectorError(error) });
      });
    },
    async cancelLogin(nativeAccountId) {
      const key = nativeAccountId?.trim() || 'default';
      const sessionKey = loginSessions.get(key);
      loginSessions.delete(key);
      await cancelWeChatLoginSession(sessionKey);
    },
  };
}

class WeChatSession implements ChannelConnectorSession {
  private readonly abort = new AbortController();
  private readonly statusTracker;
  private readonly targetDirectory = new EphemeralTargetDirectory();
  private readonly contextTokens = new Map<string, string>();
  private cursor = '';
  private stopped = false;

  constructor(
    private readonly context: Parameters<ChannelConnectorFactory['connect']>[0],
    private readonly token: string,
    private readonly baseUrl: string,
  ) {
    this.statusTracker = new ConnectorStatusTracker(context.onStatus);
  }

  async start(): Promise<void> {
    await this.statusTracker.set('connected');
    runConnectorLoop(() => this.poll(), detail => this.statusTracker.set('error', detail));
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.abort.abort();
    this.contextTokens.clear();
    await this.statusTracker.set('disconnected');
  }

  async send(message: ChannelOutboundEnvelope): Promise<void> {
    const items: Array<Record<string, unknown>> = [];
    if (message.text !== undefined) items.push({ type: 1, text_item: { text: message.text } });
    for (const attachment of message.attachments) {
      const mediaItem = await uploadWeChatMedia({
        attachment,
        toUserId: message.targetId,
        cdnBaseUrl: DEFAULT_WECHAT_CDN_BASE_URL,
        signal: this.abort.signal,
        getUploadUrl: request => weChatPost<WeChatUploadUrlResponse>(
          this.baseUrl,
          this.token,
          'ilink/bot/getuploadurl',
          { ...request, base_info: baseInfo() },
          WECHAT_API_TIMEOUT_MS,
          this.abort.signal,
        ),
      });
      items.push(mediaItem as unknown as Record<string, unknown>);
    }
    if (items.length === 0) throw new Error('WeChat outbound message has no content');

    for (const [index, item] of items.entries()) {
      await weChatPost(this.baseUrl, this.token, 'ilink/bot/sendmessage', {
        msg: {
          from_user_id: '',
          to_user_id: message.targetId,
          client_id: items.length === 1 ? message.externalMessageId : `${message.externalMessageId}:${index}`,
          message_type: 2,
          message_state: 2,
          item_list: [item],
          ...(this.contextTokens.get(message.targetId)
            ? { context_token: this.contextTokens.get(message.targetId) }
            : {}),
        },
        base_info: baseInfo(),
      }, WECHAT_API_TIMEOUT_MS, this.abort.signal);
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
        const updates = await weChatPost<WeChatUpdates>(this.baseUrl, this.token, 'ilink/bot/getupdates', {
          get_updates_buf: this.cursor,
          base_info: baseInfo(),
        }, WECHAT_LONG_POLL_MS, this.abort.signal);
        if (updates.ret && updates.ret !== 0) throw new Error(`WeChat getupdates failed: ${updates.errmsg || updates.ret}`);
        if (typeof updates.get_updates_buf === 'string') this.cursor = updates.get_updates_buf;
        for (const message of updates.msgs ?? []) await this.handleMessage(message);
        if (this.statusTracker.snapshot().state !== 'connected') await this.statusTracker.set('connected');
      } catch (error) {
        if (this.abort.signal.aborted) return;
        await this.statusTracker.set('degraded', safeConnectorError(error));
        await abortableDelay(2_000, this.abort.signal);
      }
    }
  }

  private async handleMessage(message: WeChatMessage): Promise<void> {
    const senderId = message.from_user_id?.trim();
    if (!senderId) return;
    const externalMessageId = message.message_id?.trim() || String(message.seq ?? '');
    if (!externalMessageId) return;
    if (message.context_token) this.rememberContextToken(senderId, message.context_token);
    const text = extractText(message.item_list ?? []);
    const attachments = await loadAttachments(message.item_list ?? [], this.abort.signal);
    if (!text && attachments.length === 0) return;
    this.targetDirectory.observe({ id: senderId, displayName: senderId, kind: 'direct' });
    await this.context.onInbound({
      accountId: this.context.account.id,
      channelType: 'wechat',
      externalConversationId: senderId,
      externalMessageId,
      targetId: senderId,
      senderId,
      ...(text ? { text } : {}),
      ...(attachments.length ? { attachments } : {}),
      receivedAt: unixTimestampIso(message.create_time_ms ?? Date.now()),
    });
  }

  private rememberContextToken(targetId: string, token: string): void {
    this.contextTokens.delete(targetId);
    this.contextTokens.set(targetId, token);
    while (this.contextTokens.size > 2_000) {
      const oldest = this.contextTokens.keys().next().value as string | undefined;
      if (!oldest) break;
      this.contextTokens.delete(oldest);
    }
  }
}

function normalizeBaseUrl(value: string | undefined): string {
  const url = new URL(value || DEFAULT_WECHAT_BASE_URL);
  if (url.protocol !== 'https:') throw new Error('WeChat baseUrl must use HTTPS');
  if (url.hostname !== 'weixin.qq.com' && !url.hostname.endsWith('.weixin.qq.com')) {
    throw new Error('WeChat baseUrl must use an official weixin.qq.com endpoint');
  }
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function baseInfo() {
  return { channel_version: '1.0.0', bot_agent: 'ClawX/1.0.0' };
}

function weChatHeaders(token: string): Record<string, string> {
  const uin = randomBytes(4).readUInt32BE(0);
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': Buffer.from(String(uin)).toString('base64'),
    'iLink-App-Id': 'bot',
    'iLink-App-ClientVersion': '65536',
  };
}

async function weChatPost<T = Record<string, unknown>>(
  baseUrl: string,
  token: string,
  endpoint: string,
  body: Record<string, unknown>,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<T> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = externalSignal ? AbortSignal.any([timeout, externalSignal]) : timeout;
  const response = await fetch(new URL(endpoint, `${baseUrl}/`), {
    method: 'POST',
    headers: weChatHeaders(token),
    body: JSON.stringify(body),
    signal,
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`WeChat request failed (${response.status})`);
  const parsed = JSON.parse(raw) as T & { ret?: number; errmsg?: string };
  if (parsed.ret && parsed.ret !== 0) throw new Error(`WeChat request failed: ${parsed.errmsg || parsed.ret}`);
  return parsed;
}

function extractText(items: WeChatItem[]): string {
  for (const item of items) {
    if (item.type === 1 && item.text_item?.text) return item.text_item.text;
    if (item.type === 3 && item.voice_item?.text) return item.voice_item.text;
  }
  return '';
}

async function loadAttachments(items: WeChatItem[], signal: AbortSignal): Promise<ChannelInboundAttachment[]> {
  const candidates = items.flatMap<WeChatInboundMedia>(item => {
    if (item.type === 2 && hasMediaReference(item.image_item?.media)) {
      const image = item.image_item!;
      return [{
        ...mediaReference(image.media!),
        ...(image.aeskey
          ? { aesKeyBase64: Buffer.from(image.aeskey, 'hex').toString('base64') }
          : image.media?.aes_key ? { aesKeyBase64: image.media.aes_key } : {}),
        mimeType: 'image/jpeg',
        fileName: 'image.jpg',
      }];
    }
    if (item.type === 3 && hasMediaReference(item.voice_item?.media)) {
      return [{
        ...mediaReference(item.voice_item!.media!),
        ...(item.voice_item?.media?.aes_key ? { aesKeyBase64: item.voice_item.media.aes_key } : {}),
        mimeType: 'audio/silk',
        fileName: 'voice.silk',
      }];
    }
    if (item.type === 4 && hasMediaReference(item.file_item?.media)) {
      return [{
        ...mediaReference(item.file_item!.media!),
        ...(item.file_item?.media?.aes_key ? { aesKeyBase64: item.file_item.media.aes_key } : {}),
        mimeType: 'application/octet-stream',
        fileName: item.file_item?.file_name || 'file',
      }];
    }
    if (item.type === 5 && hasMediaReference(item.video_item?.media)) {
      return [{
        ...mediaReference(item.video_item!.media!),
        ...(item.video_item?.media?.aes_key ? { aesKeyBase64: item.video_item.media.aes_key } : {}),
        mimeType: 'video/mp4',
        fileName: 'video.mp4',
      }];
    }
    return [];
  });
  return settledPortableAttachments(candidates.map(candidate => () => downloadWeChatMedia(candidate, signal)));
}

function hasMediaReference(media: WeChatMedia | undefined): boolean {
  return Boolean(media?.full_url?.trim() || media?.encrypt_query_param?.trim());
}

function mediaReference(media: WeChatMedia): Pick<WeChatInboundMedia, 'fullUrl' | 'encryptedQueryParam'> {
  return {
    ...(media.full_url?.trim() ? { fullUrl: media.full_url.trim() } : {}),
    ...(media.encrypt_query_param?.trim() ? { encryptedQueryParam: media.encrypt_query_param.trim() } : {}),
  };
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolveDelay => {
    const timer = setTimeout(resolveDelay, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolveDelay();
    }, { once: true });
  });
}
