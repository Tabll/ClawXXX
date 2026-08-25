import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('OpenClaw runtime control bridge', () => {
  it('keeps stdout protocol-pure and negotiates artifact identity, generation, health, and shutdown', async () => {
    const child = spawn(process.execPath, [join(process.cwd(), 'kernels/openclaw/overlay/clawx-control-bridge.mjs')], {
      env: {
        ...process.env,
        CLAWX_KERNEL_ARTIFACT_VERSION: '2026.7.1-2+clawx.1',
        CLAWX_KERNEL_GENERATION: '42',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity, terminal: false });
    const responses: unknown[] = [];
    lines.on('line', (line) => responses.push(JSON.parse(line)));
    const send = async (id: string, method: string, params: Record<string, unknown> = {}) => {
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const response = responses.find((candidate) => (candidate as { id?: string }).id === id);
        if (response) return response as { ok: boolean; result?: Record<string, unknown>; error?: { code: string } };
        await new Promise((accept) => setTimeout(accept, 5));
      }
      throw new Error(`Timed out waiting for ${method}`);
    };

    expect(await send('wrong', 'initialize', { artifactVersion: 'wrong' })).toMatchObject({
      ok: false,
      error: { code: 'artifact-mismatch' },
    });
    expect(await send('initialize', 'initialize', {
      artifactVersion: '2026.7.1-2+clawx.1',
      capabilitiesDigest: 'fixture',
    })).toMatchObject({
      ok: true,
      result: { kernelId: 'openclaw', artifactVersion: '2026.7.1-2+clawx.1', generation: 42 },
    });
    expect(await send('health', 'health')).toMatchObject({
      ok: true,
      result: { status: 'ready', generation: 42, rssBytes: expect.any(Number) },
    });
    expect(await send('shutdown', 'shutdown')).toMatchObject({ ok: true, result: { accepted: true } });
    await new Promise<void>((accept, reject) => {
      if (child.exitCode === 0) {
        accept();
        return;
      }
      const timeout = setTimeout(() => reject(new Error('Control bridge did not stop')), 2_000);
      child.once('exit', (code) => {
        clearTimeout(timeout);
        if (code === 0) accept();
        else reject(new Error(`Control bridge exited ${code}`));
      });
    });
    expect(responses).toHaveLength(4);
  });
});
