// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { ChannelHandoffServer } from '@electron/channels/channel-handoff-server';
import type { CanonicalChannelAccount } from '@shared/domains/channels';

function account(): CanonicalChannelAccount {
  return {
    id: 'wechat:default' as CanonicalChannelAccount['id'],
    channelType: 'wechat',
    nativeAccountId: 'default',
    displayName: 'WeChat',
    status: 'connected',
    config: {},
    form: [],
    targets: [],
    enabled: true,
    isDefault: true,
    supportedKernels: ['openclaw', 'deepseek-harness'],
    projections: [],
    revision: 1,
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
  };
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    channelType: 'openclaw-weixin',
    nativeAccountId: 'default',
    externalConversationId: 'thread-1',
    externalMessageId: 'message-1',
    targetId: 'user-1',
    text: 'hello',
    receivedAt: '2026-08-24T00:00:00.000Z',
    ...overrides,
  };
}

async function post(server: ChannelHandoffServer, token: string | undefined, body: unknown) {
  const encoded = Buffer.from(JSON.stringify(body));
  const request = Readable.from([encoded]) as Readable & {
    method?: string;
    url?: string;
    headers: Record<string, string>;
  };
  request.method = 'POST';
  request.url = '/v1/channel/inbound';
  request.headers = {
    'content-type': 'application/json',
    'content-length': String(encoded.byteLength),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  let status = 0;
  const chunks: Buffer[] = [];
  const response = {
    writeHead(nextStatus: number) {
      status = nextStatus;
      return response;
    },
    end(chunk?: Uint8Array) {
      if (chunk) chunks.push(Buffer.from(chunk));
      return response;
    },
  };
  await (server as unknown as {
    handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
  }).handle(request as unknown as IncomingMessage, response as unknown as ServerResponse);
  return {
    status,
    json: async () => JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
  };
}

function serverToken(server: ChannelHandoffServer): string {
  return (server as unknown as { token: string }).token;
}

describe('OpenClaw Channel handoff admission boundary', () => {
  it('authenticates, resolves the active canonical owner, and waits for admission', async () => {
    const server = new ChannelHandoffServer();
    const admitted = vi.fn(async () => undefined);
    server.subscribe(account(), admitted);
    const token = serverToken(server);

    expect((await post(server, undefined, payload())).status).toBe(401);
    expect((await post(server, `${token}x`, payload())).status).toBe(401);
    expect(admitted).not.toHaveBeenCalled();

    const response = await post(server, token, payload({
      attachments: [{ dataBase64: Buffer.from('blob').toString('base64'), mimeType: 'TEXT/PLAIN', fileName: '../a.txt' }],
    }));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    expect(admitted).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 'wechat:default',
      channelType: 'wechat',
      externalMessageId: 'message-1',
      attachments: [expect.objectContaining({ mimeType: 'text/plain', fileName: '.._a.txt' })],
    }));
  });

  it('refuses ingress when no canonical owner subscription is active', async () => {
    const server = new ChannelHandoffServer();
    const response = await post(server, serverToken(server), payload());
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ accepted: false, code: 'owner-not-active' });
  });

  it.each([
    ['malformed attachment encoding', payload({ attachments: [{ dataBase64: 'not base64', mimeType: 'text/plain' }] }), 400],
    ['too many attachments', payload({ attachments: Array.from({ length: 21 }, () => ({ dataBase64: '', mimeType: 'text/plain' })) }), 413],
    ['oversized external identity', payload({ externalMessageId: 'x'.repeat(4 * 1024 + 1) }), 413],
  ])('rejects %s before canonical admission', async (_label, body, status) => {
    const server = new ChannelHandoffServer();
    const admitted = vi.fn(async () => undefined);
    server.subscribe(account(), admitted);
    expect((await post(server, serverToken(server), body)).status).toBe(status);
    expect(admitted).not.toHaveBeenCalled();
  });
});
