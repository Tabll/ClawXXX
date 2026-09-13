// @vitest-environment node
import { appendFile, chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { assertArtifactBytesEqual, awaitArtifactOperations, createArtifactTestTrace, injectArtifactCorruption, withWritableArtifactFile } from '../fixtures/kernels/artifact-test-support.mjs';

describe('exact native artifact byte comparison', () => {
  it('accepts equal independently allocated large buffers and empty buffers', () => {
    const expected = Buffer.alloc(2 * 1024 * 1024, 0xa5);
    const actual = Buffer.from(expected);
    // Fail immediately on generic iterable comparison, not only on slow CI.
    // Native identity and byte equality do not access the JavaScript iterator.
    for (const buffer of [actual, expected]) {
      Object.defineProperty(buffer, Symbol.iterator, {
        get() { throw new Error('Buffer iterator inspection is forbidden'); },
      });
    }
    // Vitest not.toBe still computes deep-equality diagnostics for raw objects.
    expect(Object.is(actual, expected)).toBe(false);
    expect(() => assertArtifactBytesEqual(actual, expected)).not.toThrow();
    expect(() => assertArtifactBytesEqual(Buffer.alloc(0), Buffer.alloc(0))).not.toThrow();
  });

  it.each(['beginning', 'middle', 'end'])('rejects same-length corruption at the %s', position => {
    const expected = Buffer.alloc(1024 * 1024, 0xa5);
    const actual = Buffer.from(expected);
    const index = position === 'beginning' ? 0 : position === 'middle' ? actual.length / 2 : actual.length - 1;
    actual[index] ^= 0xff;
    expect(actual.length).toBe(expected.length);
    expect(() => assertArtifactBytesEqual(actual, expected)).toThrow('Artifact byte content differs');
    expect(() => assertArtifactBytesEqual(expected, actual)).toThrow('Artifact byte content differs');
  });

  it.each(['truncated', 'extended'])('rejects %s buffers with the same byte prefix', kind => {
    const expected = Buffer.alloc(1024, 0xa5);
    const actual = kind === 'truncated' ? expected.subarray(0, -1) : Buffer.concat([expected, Buffer.from([0xa5])]);
    expect(() => assertArtifactBytesEqual(actual, expected)).toThrow('Artifact byte content differs');
  });

  it('compares only each view range with a nonzero byte offset', () => {
    const left = Buffer.from([99, 1, 2, 3, 88]);
    const right = Buffer.from([77, 66, 1, 2, 3, 55]);
    const actual = left.subarray(1, 4);
    const expected = right.subarray(2, 5);
    expect(actual.byteOffset).toBeGreaterThan(0);
    expect(expected.byteOffset).toBeGreaterThan(0);
    expect(() => assertArtifactBytesEqual(actual, expected)).not.toThrow();
    right[3] = 9;
    expect(() => assertArtifactBytesEqual(actual, expected)).toThrow('Artifact byte content differs');
  });

  it('refuses non-Buffer inputs and never renders mismatching contents in errors', () => {
    for (const invalid of [undefined, null, 'secret', new Uint8Array([1]), { equals: () => true }]) {
      expect(() => assertArtifactBytesEqual(invalid, Buffer.from([1]))).toThrow('requires two Buffers');
      expect(() => assertArtifactBytesEqual(Buffer.from([1]), invalid)).toThrow('requires two Buffers');
    }
    let failure: unknown;
    try { assertArtifactBytesEqual(Buffer.from('private-source'), Buffer.from('private-target')); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toBe('Error: Artifact byte content differs');
  });
});

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
