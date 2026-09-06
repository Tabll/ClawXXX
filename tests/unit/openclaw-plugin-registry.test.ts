// @vitest-environment node
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('OpenClaw deterministic plugin discovery and SQLite freshness', () => {
  it('round-trips duplicate diagnostics while rejecting actual source, manifest, policy and diagnostic changes', async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      resolve('scripts/kernel-runtime/probe-openclaw-plugin-registry.mjs'),
      '--package-dir', resolve('node_modules/openclaw'),
    ], { encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: 1024 * 1024 });
    expect(JSON.parse(stdout)).toMatchObject({
      ok: true, version: '2026.9.2', duplicateDiagnostics: 2, persistedRoundTrips: 3,
      staleChangesRejected: ['manifest', 'source', 'policy', 'diagnostic'],
      physicalAliasTrust: true, unrelatedPathRejected: true,
      invalidProvenanceRejected: true, ambiguousOwnerRejected: true,
    });
  }, 25_000);
});
