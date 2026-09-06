// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyPlatformRuntime } from '../../scripts/kernel-runtime/verify-platform-runtime.mjs';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));

describe('standalone macOS runtime notarization verification', () => {
  let root: string;
  let kernelRoot: string;
  let nodeRoot: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'clawx-macho-verification-'));
    kernelRoot = join(root, 'kernel');
    nodeRoot = join(root, 'node');
    mkdirSync(kernelRoot);
    mkdirSync(join(nodeRoot, 'bin'), { recursive: true });
    writeFileSync(join(kernelRoot, 'addon.node'), Buffer.from('cffaedfe00000000', 'hex'));
    writeFileSync(join(nodeRoot, 'bin/node'), Buffer.from('cffaedfe00000000', 'hex'));
    vi.mocked(spawnSync).mockReset().mockReturnValue({ status: 0, stdout: '', stderr: '' } as unknown as ReturnType<typeof spawnSync>);
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('requires strict signatures and an online notarized requirement on every native file', () => {
    expect(verifyPlatformRuntime({ platform: 'darwin', kernelRoot, nodeRoot })).toMatchObject({
      ok: true, signedFiles: 2, notarizationAssessed: true, notarizationAssessment: 'codesign-notarized-requirement',
    });
    expect(spawnSync).toHaveBeenCalledTimes(2);
    for (const [command, args] of vi.mocked(spawnSync).mock.calls) {
      expect(command).toBe('codesign');
      expect(args).toEqual(expect.arrayContaining(['--verify', '--strict', '--check-notarization', '-R=notarized']));
    }
  });

  it('does not accept a missing ticket or fall back to signature-only verification', () => {
    vi.mocked(spawnSync).mockReturnValueOnce({ status: 1, stdout: '', stderr: 'explicit requirement failed' } as unknown as ReturnType<typeof spawnSync>);
    expect(() => verifyPlatformRuntime({ platform: 'darwin', kernelRoot, nodeRoot })).toThrow(/explicit requirement failed/);
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });
});
