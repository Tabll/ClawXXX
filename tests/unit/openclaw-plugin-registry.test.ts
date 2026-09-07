// @vitest-environment node
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('OpenClaw deterministic plugin discovery and SQLite freshness', () => {
  it.each(['native', 'alias'])('round-trips %s paths while rejecting actual source, manifest, policy and diagnostic changes', async (fixturePathMode) => {
    const { stdout } = await execFileAsync(process.execPath, [
      resolve('scripts/kernel-runtime/probe-openclaw-plugin-registry.mjs'),
      '--package-dir', resolve('node_modules/openclaw'),
      '--fixture-path-mode', fixturePathMode,
    ], { encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: 1024 * 1024 });
    expect(JSON.parse(stdout)).toMatchObject({
      ok: true, version: '2026.9.2', duplicateDiagnostics: 2, persistedRoundTrips: 3,
      staleChangesRejected: ['manifest', 'source', 'policy', 'diagnostic'],
      physicalAliasTrust: true, unrelatedPathRejected: true,
      invalidProvenanceRejected: true, ambiguousOwnerRejected: true,
      fixturePathMode, manifestHashesVerified: true, unsafePathsRejected: true,
    });
  }, 25_000);
});
