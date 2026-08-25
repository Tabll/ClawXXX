import { Buffer } from 'node:buffer';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const repoRoot = process.cwd();

describe('ClawX OpenAI image plugin request shape', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not force deprecated OpenAI Images response_format', async () => {
    const pluginSource = await readFile(
      join(repoRoot, 'resources/openclaw-plugins/clawx-openai-image/index.mjs'),
      'utf8',
    );
    const packageJson = await readFile(join(repoRoot, 'package.json'), 'utf8');
    const bundleScript = await readFile(join(repoRoot, 'scripts/bundle-openclaw.mjs'), 'utf8');

    expect(pluginSource).not.toContain('response_format');
    expect(packageJson).not.toContain('patch-openclaw-image-b64-json');
    expect(bundleScript).not.toContain('response_format: "b64_json"');
  });

  it('omits response_format from generated OpenAI-compatible requests', async () => {
    let requestBody = '';
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
      requestBody = String(init?.body ?? '');
      return new Response(
        JSON.stringify({
          data: [{ b64_json: Buffer.from('fake-image').toString('base64') }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }));

    const plugin = await import('../../resources/openclaw-plugins/clawx-openai-image/index.mjs');
    let provider: { generateImage: (req: Record<string, unknown>) => Promise<{ images: unknown[] }> } | undefined;
    plugin.default.register({
      registerImageGenerationProvider(nextProvider: typeof provider) {
        provider = nextProvider;
      },
    });

    const result = await provider?.generateImage({
        provider: 'clawx-openai-image',
        model: 'gpt-image-2',
        prompt: 'paint a fox',
        quality: 'high',
        outputFormat: 'png',
        background: 'opaque',
        providerOptions: {
          openai: {
            background: 'opaque',
            moderation: 'auto',
            outputCompression: 90,
            user: 'webchat-user',
          },
        },
        cfg: {
          models: {
            providers: {
              'clawx-openai-image': {
                apiKey: 'test-key',
                baseUrl: 'https://images.example.test/v1',
              },
            },
          },
        },
        agentDir: '/tmp/clawx-openai-image-test-agent',
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
    });

    expect(result?.images).toHaveLength(1);
    expect(JSON.parse(requestBody)).toEqual({
      model: 'gpt-image-2',
      prompt: 'paint a fox',
      n: 1,
      size: '1024x1024',
    });
  }, 15_000);
});
