import { DWClient, TOPIC_ROBOT, type DWClientDownStream } from 'dingtalk-stream';
import type { ChannelConnectorFactory, ChannelConnectorSession, ChannelOutboundEnvelope } from '../channel-runtime-contracts';
import {
  ConnectorStatusTracker,
  EphemeralTargetDirectory,
  requiredFields,
  requiredText,
  runConnectorLoop,
  safeConnectorError,
  unixTimestampIso,
} from './common';

type DingTalkInbound = {
  msgId?: string;
  msgtype?: string;
  createAt?: number;
  text?: { content?: string; repliedMsg?: { msgId?: string } };
  content?: { recognition?: string; text?: string; title?: string; fileName?: string };
  conversationType?: string;
  conversationId?: string;
  conversationTitle?: string;
  senderId?: string;
  senderStaffId?: string;
  senderNick?: string;
};

export function createDingTalkConnectorFactory(): ChannelConnectorFactory {
  return {
    channelType: 'dingtalk',
    async validate(config) {
      const fields = requiredFields(config, ['clientId', 'clientSecret']);
      if (!fields.valid) return fields;
      try {
        await dingTalkAccessToken(requiredText(config, 'clientId'), requiredText(config, 'clientSecret'));
        return { valid: true };
      } catch (error) {
        return { valid: false, errors: [safeConnectorError(error)] };
      }
    },
    async connect(context) {
      const clientId = requiredText(context.connectionConfig, 'clientId');
      const clientSecret = requiredText(context.connectionConfig, 'clientSecret');
      const client = new DWClient({ clientId, clientSecret, keepAlive: true, debug: false, ua: 'ClawX-Channel-Relay/1' });
      const session = new DingTalkSession(context, client, clientId, clientSecret);
      await session.start();
      return session;
    },
  };
}

class DingTalkSession implements ChannelConnectorSession {
  private readonly statusTracker;
  private readonly targetDirectory = new EphemeralTargetDirectory();
  private stopped = false;

  constructor(
    private readonly context: Parameters<ChannelConnectorFactory['connect']>[0],
    private readonly client: DWClient,
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {
    this.statusTracker = new ConnectorStatusTracker(context.onStatus);
  }

  async start(): Promise<void> {
    this.client.registerCallbackListener(TOPIC_ROBOT, downstream => {
      runConnectorLoop(() => this.handle(downstream), detail => this.statusTracker.set('degraded', detail));
    });
    this.client.on('connect', () => { void this.statusTracker.set('connected'); });
    this.client.on('close', () => {
      if (!this.stopped) void this.statusTracker.set('degraded', 'DingTalk Stream disconnected');
    });
    this.client.on('error', error => { void this.statusTracker.set('error', safeConnectorError(error)); });
    await this.client.connect();
    await this.statusTracker.set('connected');
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.client.removeAllListeners();
    this.client.disconnect();
    await this.statusTracker.set('disconnected');
  }

  async send(message: ChannelOutboundEnvelope): Promise<void> {
    const token = await dingTalkAccessToken(this.clientId, this.clientSecret);
    const target = normalizeTarget(message.targetId);
    const isGroup = target.startsWith('cid');
    const url = isGroup
      ? 'https://api.dingtalk.com/v1.0/robot/groupMessages/send'
      : 'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend';
    const attachmentNote = message.attachments.length
      ? `\n\n${message.attachments.map(item => `📎 ${item.fileName ?? item.mimeType}`).join('\n')}`
      : '';
    const body: Record<string, unknown> = {
      robotCode: this.clientId,
      msgKey: 'sampleMarkdown',
      msgParam: JSON.stringify({ title: 'ClawX', text: `${message.text ?? ''}${attachmentNote}`.trim() }),
      ...(isGroup ? { openConversationId: target } : { userIds: [target] }),
    };
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-acs-dingtalk-access-token': token,
        'x-acs-dingtalk-idempotency-key': message.externalMessageId,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(await dingTalkError(response));
  }

  async targets(query?: string) {
    return this.targetDirectory.list(query);
  }

  async status() {
    return this.statusTracker.snapshot();
  }

  private async handle(downstream: DWClientDownStream): Promise<void> {
    const message = JSON.parse(downstream.data) as DingTalkInbound;
    const callbackId = downstream.headers?.messageId;
    const externalMessageId = message.msgId || callbackId;
    const conversationId = message.conversationId;
    const senderId = message.senderStaffId || message.senderId;
    if (!externalMessageId || !conversationId || !senderId) return;
    const isGroup = message.conversationType === '2' || conversationId.startsWith('cid');
    const targetId = isGroup ? conversationId : senderId;
    const text = message.text?.content ?? message.content?.recognition ?? message.content?.text
      ?? (message.content?.title || message.content?.fileName ? `[${message.content.title || message.content.fileName}]` : undefined);
    if (!text?.trim()) {
      if (callbackId) this.client.socketCallBackResponse(callbackId, { success: true });
      return;
    }
    this.targetDirectory.observe({
      id: targetId,
      displayName: message.conversationTitle || message.senderNick || targetId,
      kind: isGroup ? 'group' : 'direct',
    });
    // Ack only after canonical SQLite admission. DingTalk retries the callback
    // if admission fails, and the canonical message identity deduplicates it.
    await this.context.onInbound({
      accountId: this.context.account.id,
      channelType: 'dingtalk',
      externalConversationId: conversationId,
      externalMessageId,
      targetId,
      senderId,
      ...(message.senderNick ? { senderName: message.senderNick } : {}),
      text,
      ...(message.text?.repliedMsg?.msgId ? { replyToExternalMessageId: message.text.repliedMsg.msgId } : {}),
      receivedAt: unixTimestampIso(message.createAt),
    });
    if (callbackId) this.client.socketCallBackResponse(callbackId, { success: true });
  }
}

const dingTalkTokens = new Map<string, { token: string; expiresAt: number }>();

async function dingTalkAccessToken(clientId: string, clientSecret: string): Promise<string> {
  const cached = dingTalkTokens.get(clientId);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const response = await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ appKey: clientId, appSecret: clientSecret }),
  });
  const payload = await response.json() as { accessToken?: string; expireIn?: number; code?: string; message?: string };
  if (!response.ok || !payload.accessToken) throw new Error(payload.message || `DingTalk authentication failed (${response.status})`);
  dingTalkTokens.set(clientId, {
    token: payload.accessToken,
    expiresAt: Date.now() + Math.max(payload.expireIn ?? 7_200, 60) * 1_000,
  });
  return payload.accessToken;
}

function normalizeTarget(value: string): string {
  return value.replace(/^(?:dingtalk|ding|dd):/i, '').replace(/^(?:group|user):/i, '').trim();
}

async function dingTalkError(response: Response): Promise<string> {
  const body = await response.text();
  try {
    const parsed = JSON.parse(body) as { message?: string; errmsg?: string };
    return parsed.message || parsed.errmsg || `DingTalk send failed (${response.status})`;
  } catch {
    return `DingTalk send failed (${response.status})`;
  }
}
