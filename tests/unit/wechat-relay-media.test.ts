// @vitest-environment node

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  downloadWeChatMedia,
  uploadWeChatMedia,
  type WeChatUploadUrlRequest,
} from '@electron/channels/connectors/wechat-media';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('WeChat Relay media transport', () => {
  it('downloads and decrypts official CDN media without creating connector history', async () => {
    const plaintext = Buffer.from('canonical blob only');
    const key = randomBytes(16);
    const cipher = createCipheriv('aes-128-ecb', key, null);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    globalThis.fetch = vi.fn(async () => new Response(ciphertext, {
      status: 200,
      headers: { 'content-length': String(ciphertext.byteLength) },
    })) as typeof fetch;

    const attachment = await downloadWeChatMedia({
      fullUrl: 'https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=signed',
      aesKeyBase64: key.toString('base64'),
      mimeType: 'image/jpeg',
      fileName: '../photo.jpg',
    });

    expect(Buffer.from(attachment.data)).toEqual(plaintext);
    expect(attachment).toEqual(expect.objectContaining({ mimeType: 'image/jpeg', fileName: '.._photo.jpg' }));
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects non-official CDN endpoints before issuing a request', async () => {
    globalThis.fetch = vi.fn() as typeof fetch;
    await expect(downloadWeChatMedia({
      fullUrl: 'https://attacker.example/media',
      mimeType: 'image/jpeg',
      fileName: 'photo.jpg',
    })).rejects.toThrow('official weixin.qq.com');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('encrypts uploads with the negotiated key and emits the official image wire shape', async () => {
    const plaintext = Buffer.from('image bytes');
    let request: WeChatUploadUrlRequest | undefined;
    let uploaded: Buffer | undefined;
    globalThis.fetch = vi.fn(async (_url, init) => {
      uploaded = Buffer.from(init?.body as Uint8Array);
      return new Response('', {
        status: 200,
        headers: { 'x-encrypted-param': 'download-reference' },
      });
    }) as typeof fetch;

    const item = await uploadWeChatMedia({
      attachment: { data: plaintext, mimeType: 'image/png', fileName: 'photo.png' },
      toUserId: 'weixin-user',
      getUploadUrl: async value => {
        request = value;
        return { upload_full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/upload?signed=1' };
      },
    });

    expect(request).toEqual(expect.objectContaining({
      media_type: 1,
      to_user_id: 'weixin-user',
      rawsize: plaintext.byteLength,
      no_need_thumb: true,
    }));
    const decipher = createDecipheriv('aes-128-ecb', Buffer.from(request!.aeskey, 'hex'), null);
    expect(Buffer.concat([decipher.update(uploaded!), decipher.final()])).toEqual(plaintext);
    expect(request!.filesize).toBe(uploaded!.byteLength);
    expect(item).toEqual({
      type: 2,
      image_item: {
        media: {
          encrypt_query_param: 'download-reference',
          aes_key: Buffer.from(request!.aeskey, 'ascii').toString('base64'),
          encrypt_type: 1,
        },
        mid_size: uploaded!.byteLength,
      },
    });
  });

  it('does not retry a CDN client rejection', async () => {
    globalThis.fetch = vi.fn(async () => new Response('', { status: 403 })) as typeof fetch;
    await expect(uploadWeChatMedia({
      attachment: { data: Buffer.from('file'), mimeType: 'application/pdf', fileName: '../report.pdf' },
      toUserId: 'weixin-user',
      getUploadUrl: async () => ({ upload_param: 'upload-reference' }),
    })).rejects.toThrow('rejected (403)');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});
