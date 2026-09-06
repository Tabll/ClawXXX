import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { readFile } from 'node:fs/promises';
import { registerManagedSessionBridge } from './managed-session.mjs';

const MAX_CACHE_ENTRIES = 1_000;
const CACHE_TTL_MS = 5 * 60_000;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const receivedByKey = new Map();

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function cacheKey(event, context) {
  return [
    context?.channelId ?? event?.channel ?? '',
    context?.accountId ?? '',
    context?.sessionKey ?? event?.sessionKey ?? '',
    context?.messageId ?? event?.messageId ?? '',
    context?.senderId ?? event?.senderId ?? '',
    (context?.messageId ?? event?.messageId) ? '' : event?.timestamp ?? '',
  ].join('\u0000');
}

function cleanCache(now = Date.now()) {
  for (const [key, item] of receivedByKey) {
    if (now - item.cachedAt > CACHE_TTL_MS) receivedByKey.delete(key);
  }
  while (receivedByKey.size > MAX_CACHE_ENTRIES) {
    const oldest = receivedByKey.keys().next().value;
    if (oldest === undefined) break;
    receivedByKey.delete(oldest);
  }
}

function remember(event, context) {
  cleanCache();
  const item = { event, context, cachedAt: Date.now() };
  receivedByKey.set(cacheKey(event, context), item);
}

async function resolveCached(event, context) {
  // message_received is deliberately fire-and-forget upstream, while
  // before_dispatch is awaited. Yield once so the already-started hook can
  // publish its richer message id and media metadata.
  await Promise.resolve();
  cleanCache();
  const exact = receivedByKey.get(cacheKey(event, context));
  return exact;
}

function deterministicMessageId(input) {
  return `clawx-derived:${createHash('sha256').update(JSON.stringify(input)).digest('hex')}`;
}

function listMedia(metadata) {
  const paths = Array.isArray(metadata?.mediaPaths)
    ? metadata.mediaPaths
    : text(metadata?.mediaPath) ? [metadata.mediaPath] : [];
  const types = Array.isArray(metadata?.mediaTypes)
    ? metadata.mediaTypes
    : text(metadata?.mediaType) ? [metadata.mediaType] : [];
  return paths
    .map((path, index) => ({ path: text(path), mimeType: text(types[index]) }))
    .filter((item) => item.path);
}

async function readAttachments(metadata, logger) {
  const attachments = [];
  let total = 0;
  for (const media of listMedia(metadata)) {
    try {
      const data = await readFile(media.path);
      if (data.byteLength > MAX_ATTACHMENT_BYTES || total + data.byteLength > MAX_TOTAL_ATTACHMENT_BYTES) {
        logger.warn?.('clawx-channel-handoff: inbound attachment exceeded the canonical admission limit');
        continue;
      }
      total += data.byteLength;
      attachments.push({
        dataBase64: data.toString('base64'),
        mimeType: media.mimeType ?? 'application/octet-stream',
        fileName: basename(media.path),
      });
    } catch {
      logger.warn?.('clawx-channel-handoff: an inbound attachment could not be staged');
    }
  }
  return attachments;
}

async function handoff(event, context, cached, logger) {
  const endpoint = text(process.env.CLAWX_CHANNEL_HANDOFF_URL);
  const token = text(process.env.CLAWX_CHANNEL_HANDOFF_TOKEN);
  if (!endpoint || !token || process.env.CLAWX_MANAGED_RUNTIME !== '1') {
    throw new Error('managed Channel handoff endpoint is unavailable');
  }
  // September before_dispatch carries the authoritative message identity and
  // our patch includes its media snapshot. Never borrow another message from
  // the same conversation when concurrent deliveries race.
  const received = { ...cached?.event, ...event };
  const receivedContext = cached?.context ?? {};
  const metadata = received.metadata && typeof received.metadata === 'object' ? received.metadata : {};
  const channelType = text(context?.channelId) ?? text(receivedContext?.channelId) ?? text(event?.channel);
  const nativeAccountId = text(context?.accountId) ?? text(receivedContext?.accountId) ?? 'default';
  const externalConversationId = text(context?.conversationId)
    ?? text(receivedContext?.conversationId)
    ?? text(context?.sessionKey)
    ?? text(received.sessionKey);
  const targetId = externalConversationId ?? text(metadata.to) ?? text(received.from);
  if (!channelType || !externalConversationId || !targetId) {
    throw new Error('managed Channel handoff identity is incomplete');
  }
  const timestamp = Number.isFinite(received.timestamp)
    ? received.timestamp
    : Number.isFinite(event?.timestamp) ? event.timestamp : Date.now();
  const senderId = text(received.senderId) ?? text(context?.senderId) ?? text(received.from);
  const content = typeof event?.body === 'string'
    ? event.body
    : typeof event?.content === 'string' ? event.content : received.content;
  const externalMessageId = text(event?.messageId) ?? text(context?.messageId) ?? text(received.messageId) ?? deterministicMessageId({
    channelType,
    nativeAccountId,
    externalConversationId,
    senderId,
    timestamp,
    content,
  });
  const attachments = await readAttachments(metadata, logger);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      channelType,
      nativeAccountId,
      externalConversationId,
      externalMessageId,
      targetId,
      ...(senderId ? { senderId } : {}),
      ...(text(metadata.senderName) ? { senderName: text(metadata.senderName) } : {}),
      ...(typeof content === 'string' ? { text: content } : {}),
      ...(attachments.length ? { attachments } : {}),
      ...(text(received.replyToId) ? { replyToExternalMessageId: text(received.replyToId) } : {}),
      receivedAt: new Date(timestamp).toISOString(),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status !== 202) {
    throw new Error(`canonical admission rejected with status ${response.status}`);
  }
}

export default {
  id: 'clawx-channel-handoff',
  name: 'ClawX Channel Handoff',
  description: 'Canonical channel ingress handoff for ClawX managed mode',
  register(api) {
    registerManagedSessionBridge(api);
    api.on('message_received', async (event, context) => {
      remember(event, context);
    });
    api.on('before_dispatch', async (event, context) => {
      const cached = await resolveCached(event, context);
      try {
        await handoff(event, context, cached, api.logger);
      } catch (error) {
        // Fail closed: falling through would let OpenClaw create a second run
        // and a second history authority. The external provider can redeliver
        // after the canonical owner has recovered.
        api.logger.error?.(`clawx-channel-handoff: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      } finally {
        if (cached) {
          receivedByKey.delete(cacheKey(cached.event, cached.context));
        }
      }
      return { handled: true, clawxCanonicalAccepted: true };
    });
  },
};
