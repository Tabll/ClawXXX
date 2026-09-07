// @vitest-environment node
import { appendFile, chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { awaitArtifactOperations, createArtifactTestTrace, injectArtifactCorruption, withWritableArtifactFile } from '../fixtures/kernels/artifact-test-support.mjs';

describe('real artifact fault injection and diagnostics', () => {
  it('waits for the other runtime operation before surfacing a one-sided failure', async () => {
    let release!: () => void;
    let settled = false;
    const error = new Error('one kernel failed');
    const result = awaitArtifactOperations([
      Promise.reject(error), new Promise<void>(resolve => { release = resolve; }),
    ]).catch(caught => { settled = true; return caught; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    release();
    expect(await result).toBe(error);
    expect(await awaitArtifactOperations([Promise.resolve(1), Promise.resolve(2)])).toEqual([1, 2]);
  });
  it('reproduces readonly rejection, injects into the owned file and restores readonly mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clawx-injection-'));
    try {
      const path = join(root, 'bridge.mjs');
      await writeFile(path, 'original', { mode: 0o444 });
      await chmod(path, 0o444);
      // Unix root can bypass DAC; CI and Windows must actually deny writes.
      if (process.platform === 'win32' || process.getuid?.() !== 0) {
        await expect(appendFile(path, 'forbidden')).rejects.toMatchObject({ code: expect.stringMatching(/^(EACCES|EPERM)$/) });
      }
      await injectArtifactCorruption(root, 'bridge.mjs');
      expect(await readFile(path, 'utf8')).toContain('integrity failure injection');
      expect((await stat(path)).mode & 0o222).toBe(0);
      await expect(withWritableArtifactFile(root, 'bridge.mjs', async () => { throw new Error('injected writer failure'); }))
        .rejects.toThrow('injected writer failure');
      expect((await stat(path)).mode & 0o222).toBe(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('refuses traversal, directories and physical links outside the test authority', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clawx-injection-boundary-'));
    try {
      await mkdir(join(root, 'owned'));
      await mkdir(join(root, 'owned', 'directory'));
      await writeFile(join(root, 'external.mjs'), 'unchanged');
      await symlink(root, join(root, 'owned', 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
      await link(join(root, 'external.mjs'), join(root, 'owned', 'hard.mjs'));
      for (const path of ['../external.mjs', 'escape/external.mjs', 'hard.mjs', 'directory', '.', '/external.mjs', 'C:\\external.mjs']) {
        await expect(injectArtifactCorruption(join(root, 'owned'), path)).rejects.toThrow();
      }
      expect(await readFile(join(root, 'external.mjs'), 'utf8')).toBe('unchanged');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('persists phase and failure evidence before the success-only report and excludes error contents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clawx-artifact-trace-'));
    const lines: string[] = [];
    const evidence = join(root, 'report.json');
    const trace = createArtifactTestTrace(evidence, (line: string) => lines.push(line));
    try {
      await trace.step('install', async () => { trace.phase('openclaw:staging'); });
      await expect(trace.step('rescan', async () => { throw new Error('secret/path/must-not-leak'); })).rejects.toThrow();
      trace.stop();
      trace.stop(true);
      const journal = await readFile(`${evidence}.progress.jsonl`, 'utf8');
      expect(journal).toBe(lines.join(''));
      expect(journal).not.toContain('secret');
      expect(lines.map(line => JSON.parse(line).status)).toEqual(['started', 'progress', 'passed', 'started', 'failed', 'failed']);
    } finally { trace.stop(); await rm(root, { recursive: true, force: true }); }
  });

  it('emits a bounded heartbeat for hung work and stops timers on timeout cleanup', async () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const trace = createArtifactTestTrace(undefined, (line: string) => lines.push(line));
    let release!: () => void;
    try {
      const step = trace.step('install', () => new Promise<void>(resolve => { release = resolve; }));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(lines.map(line => JSON.parse(line).status)).toEqual(['started', 'running', 'running']);
      trace.stop();
      const length = lines.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(lines).toHaveLength(length);
      release();
      await step;
      expect(lines).toHaveLength(length);
      expect(vi.getTimerCount()).toBe(0);
    } finally { trace.stop(); vi.useRealTimers(); }
  });
});
