import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import type {
  ChannelInboundAttachment,
  ChannelOutboundAttachment,
} from '../channel-runtime-contracts';
import {
  CONNECTOR_ATTACHMENT_LIMIT_BYTES,
  normalizeMimeType,
  safeFileName,
} from './common';

export const DEFAULT_WECHAT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';

const AES_BLOCK_BYTES = 16;
const CDN_UPLOAD_RETRIES = 3;
const CDN_REQUEST_TIMEOUT_MS = 60_000;

export type WeChatInboundMedia = {
  fullUrl?: string;
  encryptedQueryParam?: string;
  aesKeyBase64?: string;
  mimeType: string;
  fileName: string;
};

export type WeChatUploadUrlRequest = {
  filekey: string;
  media_type: 1 | 2 | 3;
  to_user_id: string;
  rawsize: number;
  rawfilemd5: string;
  filesize: number;
  no_need_thumb: true;
  aeskey: string;
};

export type WeChatUploadUrlResponse = {
  upload_full_url?: string;
  upload_param?: string;
};

export type WeChatOutboundMediaItem = {
  type: 2 | 4 | 5;
  image_item?: {
    media: WeChatWireMedia;
    mid_size: number;
  };
  file_item?: {
    media: WeChatWireMedia;
    file_name: string;
    len: string;
  };
  video_item?: {
    media: WeChatWireMedia;
    video_size: number;
  };
};

type WeChatWireMedia = {
  encrypt_query_param: string;
  aes_key: string;
  encrypt_type: 1;
};

/**
 * Buffer-only adaptation of Tencent's MIT-licensed openclaw-weixin CDN flow.
 * Relay data remains transient: the canonical Blob store is the only durable
 * attachment owner.
 */
export async function downloadWeChatMedia(
  media: WeChatInboundMedia,
  signal?: AbortSignal,
): Promise<ChannelInboundAttachment> {
  const url = resolveDownloadUrl(media);
  const encrypted = await fetchOfficialWeChatBytes(url, signal, CONNECTOR_ATTACHMENT_LIMIT_BYTES + AES_BLOCK_BYTES);
  const data = media.aesKeyBase64
    ? decryptAesEcb(encrypted, parseAesKey(media.aesKeyBase64))
    : encrypted;
  if (data.byteLength > CONNECTOR_ATTACHMENT_LIMIT_BYTES) {
    throw new Error('WeChat attachment exceeds connector limit');
  }
  return {
    data: new Uint8Array(data),
    mimeType: normalizeMimeType(media.mimeType),
    fileName: safeFileName(media.fileName),
  };
}

export async function uploadWeChatMedia(input: {
  attachment: ChannelOutboundAttachment;
  toUserId: string;
  cdnBaseUrl?: string;
  signal?: AbortSignal;
  getUploadUrl(request: WeChatUploadUrlRequest): Promise<WeChatUploadUrlResponse>;
}): Promise<WeChatOutboundMediaItem> {
  const plaintext = Buffer.from(input.attachment.data);
  if (plaintext.byteLength > CONNECTOR_ATTACHMENT_LIMIT_BYTES) {
    throw new Error('WeChat attachment exceeds connector limit');
  }
  const mimeType = normalizeMimeType(input.attachment.mimeType);
  const kind = mimeType.startsWith('image/') ? 'image' : mimeType.startsWith('video/') ? 'video' : 'file';
  const mediaType = kind === 'image' ? 1 : kind === 'video' ? 2 : 3;
  const filekey = randomBytes(16).toString('hex');
  const aesKey = randomBytes(16);
  const aesKeyHex = aesKey.toString('hex');
  const ciphertext = encryptAesEcb(plaintext, aesKey);
  const upload = await input.getUploadUrl({
    filekey,
    media_type: mediaType,
    to_user_id: input.toUserId,
    rawsize: plaintext.byteLength,
    rawfilemd5: createHash('md5').update(plaintext).digest('hex'),
    filesize: ciphertext.byteLength,
    no_need_thumb: true,
    aeskey: aesKeyHex,
  });
  const uploadUrl = resolveUploadUrl(upload, filekey, input.cdnBaseUrl ?? DEFAULT_WECHAT_CDN_BASE_URL);
  const encryptedQueryParam = await uploadEncryptedBytes(uploadUrl, ciphertext, input.signal);
  const wireMedia: WeChatWireMedia = {
    encrypt_query_param: encryptedQueryParam,
    // The protocol uses base64(ASCII hex) for outbound media keys.
    aes_key: Buffer.from(aesKeyHex, 'ascii').toString('base64'),
    encrypt_type: 1,
  };

  if (kind === 'image') {
    return { type: 2, image_item: { media: wireMedia, mid_size: ciphertext.byteLength } };
  }
  if (kind === 'video') {
    return { type: 5, video_item: { media: wireMedia, video_size: ciphertext.byteLength } };
  }
  return {
    type: 4,
    file_item: {
      media: wireMedia,
      file_name: safeFileName(input.attachment.fileName || 'attachment'),
      len: String(plaintext.byteLength),
    },
  };
}

function resolveDownloadUrl(media: WeChatInboundMedia): URL {
  if (media.fullUrl?.trim()) return requireOfficialWeChatUrl(media.fullUrl);
  if (!media.encryptedQueryParam?.trim()) throw new Error('WeChat media has no download reference');
  const base = requireOfficialWeChatUrl(DEFAULT_WECHAT_CDN_BASE_URL);
  const url = new URL(`${base.toString().replace(/\/$/, '')}/download`);
  url.searchParams.set('encrypted_query_param', media.encryptedQueryParam);
  return url;
}

function resolveUploadUrl(response: WeChatUploadUrlResponse, filekey: string, cdnBaseUrl: string): URL {
  if (response.upload_full_url?.trim()) return requireOfficialWeChatUrl(response.upload_full_url);
  if (!response.upload_param?.trim()) throw new Error('WeChat getuploadurl returned no upload reference');
  const base = requireOfficialWeChatUrl(cdnBaseUrl);
  const url = new URL(`${base.toString().replace(/\/$/, '')}/upload`);
  url.searchParams.set('encrypted_query_param', response.upload_param);
  url.searchParams.set('filekey', filekey);
  return url;
}

function requireOfficialWeChatUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error('WeChat media URL must use HTTPS');
  const host = url.hostname.toLowerCase();
  if (host !== 'weixin.qq.com' && !host.endsWith('.weixin.qq.com')) {
    throw new Error('WeChat media URL must use an official weixin.qq.com endpoint');
  }
  url.username = '';
  url.password = '';
  url.hash = '';
  return url;
}

async function fetchOfficialWeChatBytes(url: URL, signal: AbortSignal | undefined, maximum: number): Promise<Buffer> {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: combineSignal(signal, CDN_REQUEST_TIMEOUT_MS),
  });
  if (response.url) requireOfficialWeChatUrl(response.url);
  if (!response.ok) throw new Error(`WeChat CDN download failed (${response.status})`);
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > maximum) throw new Error('WeChat CDN response exceeds connector limit');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > maximum) throw new Error('WeChat CDN response exceeds connector limit');
  return bytes;
}

async function uploadEncryptedBytes(url: URL, ciphertext: Buffer, signal?: AbortSignal): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= CDN_UPLOAD_RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: new Uint8Array(ciphertext),
        signal: combineSignal(signal, CDN_REQUEST_TIMEOUT_MS),
        redirect: 'error',
      });
      if (response.status >= 400 && response.status < 500) {
        throw new WeChatCdnClientError(`WeChat CDN upload rejected (${response.status})`);
      }
      if (!response.ok) throw new Error(`WeChat CDN upload failed (${response.status})`);
      const encryptedQueryParam = response.headers.get('x-encrypted-param')?.trim();
      if (!encryptedQueryParam) throw new Error('WeChat CDN upload response has no encrypted reference');
      return encryptedQueryParam;
    } catch (error) {
      if (error instanceof WeChatCdnClientError || signal?.aborted) throw error;
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('WeChat CDN upload failed');
}

function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function parseAesKey(base64: string): Buffer {
  const decoded = Buffer.from(base64, 'base64');
  if (decoded.byteLength === AES_BLOCK_BYTES) return decoded;
  if (decoded.byteLength === AES_BLOCK_BYTES * 2 && /^[0-9a-f]{32}$/i.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex');
  }
  throw new Error('WeChat media AES key has an invalid encoding');
}

function combineSignal(external: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return external ? AbortSignal.any([external, timeout]) : timeout;
}

class WeChatCdnClientError extends Error {}
