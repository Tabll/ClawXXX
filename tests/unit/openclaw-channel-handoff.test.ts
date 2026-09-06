// @vitest-environment node
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('canonical Channel admission handoff', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  async function setup() {
    vi.stubEnv('CLAWX_MANAGED_RUNTIME', '1');
    vi.stubEnv('CLAWX_CHANNEL_HANDOFF_URL', 'http://127.0.0.1/clawx-test-only');
    vi.stubEnv('CLAWX_CHANNEL_HANDOFF_TOKEN', 'test-only');
    const { default: plugin } = await import('../../kernels/openclaw/overlay/clawx-channel-handoff/index.mjs');
    const hooks: Record<string, (event: object, context: object) => Promise<unknown>> = {};
    plugin.register({ on: (name: string, hook: typeof hooks[string]) => { hooks[name] = hook; }, registerGatewayMethod: vi.fn(), logger: { error: vi.fn(), warn: vi.fn() } });
    return hooks;
  }

  it('never borrows another concurrent message attachment from the same conversation', async () => {
    const hooks = await setup();
    const root = await mkdtemp(join(tmpdir(), 'clawx-channel-isolation-'));
    const payloads: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => { payloads.push(JSON.parse(init.body)); return new Response(null, { status: 202 }); }));
    try {
      await writeFile(join(root, 'one.txt'), 'one');
      await writeFile(join(root, 'two.txt'), 'two');
      const context = { channelId: 'telegram', accountId: 'default', sessionKey: 'same-session', conversationId: 'same-chat', senderId: 'same-sender' };
      await hooks.message_received({ messageId: 'one', metadata: { mediaPath: join(root, 'one.txt') } }, context);
      await hooks.message_received({ messageId: 'two', metadata: { mediaPath: join(root, 'two.txt') } }, context);
      await Promise.all(['two', 'one'].map(messageId => hooks.before_dispatch({ messageId, body: messageId }, context)));
      for (const payload of payloads) {
        const attachments = payload.attachments as Array<{ dataBase64: string }>;
        expect(Buffer.from(attachments[0].dataBase64, 'base64').toString()).toBe(payload.externalMessageId);
      }
      expect(payloads).toHaveLength(2);
      await hooks.before_dispatch({ messageId: 'missing', body: 'no attachment' }, context);
      expect(payloads[2]).not.toHaveProperty('attachments');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('acknowledges only canonical 202 admission and fails closed on rejection or an unavailable bridge', async () => {
    const hooks = await setup();
    const context = { channelId: 'telegram', conversationId: 'test' };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })));
    await expect(hooks.before_dispatch({ messageId: 'failed', body: 'test' }, context)).rejects.toThrow('503');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 202 })));
    await expect(hooks.before_dispatch({ messageId: 'accepted', body: 'test' }, context)).resolves.toEqual({ handled: true, clawxCanonicalAccepted: true });
    vi.stubEnv('CLAWX_CHANNEL_HANDOFF_TOKEN', '');
    await expect(hooks.before_dispatch({ messageId: 'offline', body: 'test' }, context)).rejects.toThrow('unavailable');
  });
});
