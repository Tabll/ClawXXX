// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// The overlay's tsconfig belongs to the upstream checkout, not the host repo.
const probeSource = stripTypeScriptTypes(readFileSync(join(process.cwd(),
  'kernels/deepseek-harness/overlay/packages/runtime/clawx-runtime-host/src/sandbox-probe.ts'), 'utf8'));
const { SANDBOX_WRITE_PROBE, sandboxWriteWasDenied } = await import(
  /* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(probeSource).toString('base64')}`
) as {
  SANDBOX_WRITE_PROBE: string;
  sandboxWriteWasDenied: (result: { status: number | null; stderr: string }, expectedPath: string) => boolean;
};

describe('DeepSeek Harness controlled sandbox write probe', () => {
  it.each(['EPERM', 'EACCES', 'EROFS'])('recognizes only a child-confirmed %s for the exact path', (code) => {
    const path = 'C:\\Users\\runner\\Temp\\sandbox-read-only.txt';
    const result = spawnSync(process.execPath, ['-e', `
      require('node:fs').writeFileSync = () => { throw Object.assign(new Error('localized message'), { code: '${code}' }) };
      ${SANDBOX_WRITE_PROBE}
    `, path], { encoding: 'utf8' });
    expect(result.status).toBe(77);
    expect(sandboxWriteWasDenied(result, path)).toBe(true);
    expect(sandboxWriteWasDenied(result, 'another-path')).toBe(false);
    expect(sandboxWriteWasDenied({ ...result, status: 0 }, path)).toBe(false);
    expect(sandboxWriteWasDenied({ ...result, status: null }, path)).toBe(false);
  });

  it.each(['ENOENT', 'ENOSPC', 'EISDIR', 'EINVAL'])('does not treat an unrelated %s failure as sandbox proof', (code) => {
    const result = spawnSync(process.execPath, ['-e', `
      require('node:fs').writeFileSync = () => { throw Object.assign(new Error('permission denied'), { code: '${code}' }) };
      ${SANDBOX_WRITE_PROBE}
    `, 'target'], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(sandboxWriteWasDenied(result, 'target')).toBe(false);
  });

  it('preserves the successful write probe and rejects bare OS error text', () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-sandbox-probe-'));
    try {
      const path = join(root, 'allowed.txt');
      const result = spawnSync(process.execPath, ['-e', SANDBOX_WRITE_PROBE, path], { encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(readFileSync(path, 'utf8')).toBe('sandbox-ok');
      expect(sandboxWriteWasDenied(result, path)).toBe(false);
      expect(sandboxWriteWasDenied({ status: 1, stderr: 'Error: EPERM: operation not permitted' }, path)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
