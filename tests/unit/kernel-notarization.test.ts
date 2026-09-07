// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { boundedCommand, isTransientNotaryFailure, notarizeArchive } from '../../scripts/kernel-runtime/lib/notarization.mjs';
import { sha256File } from '../../scripts/kernel-runtime/lib/canonical.mjs';

const id = 'e14fd882-fd40-4450-8b25-55b67951dc13';
const otherId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const success = (status = 'Accepted', identity = id) => ({ ok: true, stdout: JSON.stringify({ id: identity, status }), stderr: '', code: 0 });
const networkFailure = { ok: false, stdout: '', stderr: 'Error: HTTPError(statusCode: nil, error: Error Domain=NSURLErrorDomain Code=-1001 "The request timed out.")', code: 1 };

describe('kernel notarization submit-once recovery', () => {
  let root: string;
  let archivePath: string;
  let journalPath: string;
  let reportPath: string;
  let clock: number;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'clawx-notary-test-'));
    archivePath = join(root, 'signed runtime.zip');
    journalPath = join(root, 'submission.json');
    reportPath = join(root, 'notarization.json');
    writeFileSync(archivePath, 'signed fixture bytes');
    clock = 0;
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true, maxRetries: 3 }); });
  const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
  function harness(replies: unknown[], timeoutMs = 300_000) {
    const command = vi.fn(async (args: string[], budget: number) => {
      expect(budget).toBeGreaterThan(0);
      expect(args).toContain('--keychain-profile');
      expect(args).not.toContain('--password');
      const reply = replies.shift();
      if (typeof reply === 'function') return reply(args, budget);
      if (!reply) throw new Error('Unexpected command');
      return reply;
    });
    const sleep = vi.fn(async (ms: number) => { clock += ms; });
    const options = { archivePath, keychainProfile: 'test-profile', journalPath, reportPath, command, now: () => clock, sleep, timeoutMs };
    return { command, sleep, options, run: () => notarizeArchive(options) };
  }
  function savedSubmission(phase = 'submitted') {
    writeFileSync(journalPath, JSON.stringify({ schemaVersion: 1, archiveSha256: sha256File(archivePath), phase, ...(phase === 'submitted' ? { id } : {}) }));
  }

  it('persists the archive identity and submission ID before querying; recovers the CI timeout without uploading twice', async () => {
    const h = harness([
      (args: string[]) => {
        expect(args[0]).toBe('submit');
        expect(args).toContain('--no-wait');
        expect(args).not.toContain('--wait');
        expect(json(journalPath)).toMatchObject({ phase: 'submitting', archiveSha256: sha256File(archivePath) });
        return success('In Progress');
      },
      (args: string[]) => {
        expect(args.slice(0, 2)).toEqual(['info', id]);
        expect(json(journalPath)).toMatchObject({ phase: 'submitted', id });
        return networkFailure;
      },
      success('In Progress'), success(),
    ]);
    await expect(h.run()).resolves.toMatchObject({ id, status: 'Accepted', pollAttempts: 3 });
    expect(h.command.mock.calls.map(([args]) => args[0])).toEqual(['submit', 'info', 'info', 'info']);
    expect(h.sleep.mock.calls).toEqual([[5_000], [15_000]]);
    expect(json(reportPath)).toMatchObject({ ok: true, status: 'Accepted', id });
    expect(readdirSync(root).some(name => name.endsWith('.tmp'))).toBe(false);
  });

  it('resumes the exact persisted archive by ID without resubmitting', async () => {
    savedSubmission();
    const h = harness([success()]);
    await expect(h.run()).resolves.toMatchObject({ id, status: 'Accepted' });
    expect(h.command.mock.calls.map(([args]) => args[0])).toEqual(['info']);
  });

  it('recovers a known Apple submission URL from a transient submit response, then polls only that ID', async () => {
    const h = harness([{ ...networkFailure, stderr: `${networkFailure.stderr} https://appstoreconnect.apple.com/notary/v2/submissions/${id}?` }, success()]);
    await expect(h.run()).resolves.toMatchObject({ id, status: 'Accepted' });
    expect(json(journalPath)).toMatchObject({ id, phase: 'submitted' });
    expect(h.command).toHaveBeenCalledTimes(2);
  });

  it('does not retry an ambiguous upload, including after restarting the helper', async () => {
    const h = harness([networkFailure]);
    await expect(h.run()).rejects.toThrow(/uncertain/);
    expect(json(journalPath)).toMatchObject({ phase: 'submitting' });
    await expect(h.run()).rejects.toThrow(/uncertain/);
    expect(h.command).toHaveBeenCalledTimes(1);
    expect(json(reportPath)).toMatchObject({ ok: false, status: 'Failed' });
  });

  it.each([
    { ok: true, stdout: 'not json', stderr: '' },
    { ok: true, stdout: '{"id":"not-a-uuid"}', stderr: '' },
    { ...networkFailure, stderr: `${networkFailure.stderr} https://untrusted.test/notary/v2/submissions/${id}?` },
    { ...networkFailure, stderr: `${networkFailure.stderr} https://appstoreconnect.apple.com/notary/v2/submissions/${id}? https://appstoreconnect.apple.com/notary/v2/submissions/${otherId}?` },
  ])('never guesses an ID from malformed or ambiguous submit output (%#)', async (response) => {
    const h = harness([response]);
    await expect(h.run()).rejects.toThrow();
    expect(h.command).toHaveBeenCalledTimes(1);
    expect(json(reportPath)).toMatchObject({ status: 'Failed' });
  });

  it.each(['Invalid', 'Rejected'])('keeps Apple %s fatal and does not weaken the Accepted gate', async (status) => {
    const h = harness([success('In Progress'), success(status)]);
    await expect(h.run()).rejects.toThrow(`Notarization ${status}`);
    expect(h.command).toHaveBeenCalledTimes(2);
    expect(h.sleep).not.toHaveBeenCalled();
    expect(json(reportPath)).toMatchObject({ ok: false, status: 'Failed', lastStatus: status, id });
  });

  it.each([
    'HTTPError(statusCode: 401) password=SHOULD_NOT_BE_RECORDED',
    'HTTPError(statusCode: 403) NSURLErrorDomain Code=-1001',
    'NSURLErrorDomain Code=-1202 certificate validation failed',
    'unknown tool failure',
  ])('fails non-transient errors immediately without persisting raw diagnostics (%#)', async (stderr) => {
    const h = harness([success('In Progress'), { ok: false, stdout: '', stderr, code: 1 }]);
    await expect(h.run()).rejects.toThrow(/Non-retryable/);
    expect(h.sleep).not.toHaveBeenCalled();
    expect(readFileSync(reportPath, 'utf8')).not.toContain(stderr);
    expect(readFileSync(reportPath, 'utf8')).not.toContain('SHOULD_NOT_BE_RECORDED');
  });

  it.each([
    success('Accepted', otherId), success('Unknown'),
    { ok: true, stdout: '{}', stderr: '' },
    { ok: true, stdout: 'bad json', stderr: '' },
  ])('rejects mismatched IDs and malformed or unknown statuses (%#)', async (response) => {
    const h = harness([success('In Progress'), response]);
    await expect(h.run()).rejects.toThrow();
    expect(h.sleep).not.toHaveBeenCalled();
    expect(json(reportPath)).toMatchObject({ ok: false, status: 'Failed' });
  });

  it('caps transient retries with exponential backoff and preserves a resumable journal', async () => {
    const h = harness([success('In Progress'), ...Array(6).fill(networkFailure)]);
    await expect(h.run()).rejects.toThrow(/retry limit/);
    expect(h.sleep.mock.calls).toEqual([[5_000], [10_000], [20_000], [30_000], [30_000]]);
    expect(json(journalPath)).toMatchObject({ id, phase: 'submitted' });
    const resumed = harness([success()]);
    await expect(resumed.run()).resolves.toMatchObject({ status: 'Accepted' });
    expect(resumed.command.mock.calls[0][0][0]).toBe('info');
  });

  it('bounds In Progress polling by a total deadline', async () => {
    const h = harness([success('In Progress'), success('In Progress'), success('In Progress')], 20_000);
    await expect(h.run()).rejects.toThrow(/deadline/);
    expect(clock).toBe(20_000);
    expect(h.sleep.mock.calls).toEqual([[15_000], [5_000]]);
    expect(json(reportPath)).toMatchObject({ status: 'Failed' });
  });

  it('rejects a late Accepted response', async () => {
    const h = harness([success('In Progress'), () => { clock = 20_001; return success(); }], 20_000);
    await expect(h.run()).rejects.toThrow(/deadline/);
    expect(json(reportPath)).toMatchObject({ ok: false, status: 'Failed' });
  });

  it('does not reuse a submission for changed archive bytes', async () => {
    savedSubmission();
    writeFileSync(archivePath, 'a different signed archive');
    const h = harness([]);
    await expect(h.run()).rejects.toThrow(/exact archive/);
    expect(h.command).not.toHaveBeenCalled();
  });

  it('rejects archive changes during polling and never leaves a stale Accepted report', async () => {
    writeFileSync(reportPath, JSON.stringify({ id, status: 'Accepted' }));
    const h = harness([success('In Progress'), () => { writeFileSync(archivePath, 'changed'); return success(); }]);
    await expect(h.run()).rejects.toThrow(/Archive changed/);
    expect(json(reportPath)).toMatchObject({ ok: false, status: 'Failed' });
  });

  it('rejects invalid budgets and output/archive collisions before running a command', async () => {
    const h = harness([]);
    for (const timeoutMs of [0, -1, Infinity, 2_400_001]) {
      await expect(notarizeArchive({ ...h.options, timeoutMs })).rejects.toThrow(/budget/);
    }
    await expect(notarizeArchive({ ...h.options, reportPath: archivePath })).rejects.toThrow(/distinct/);
    expect(h.command).not.toHaveBeenCalled();
    expect(existsSync(journalPath)).toBe(false);
  });
});

describe('notary command and transport classification', () => {
  it.each([-1001, -1003, -1004, -1005, -1009])('retries known transient network code %s', (code) => {
    expect(isTransientNotaryFailure({ stderr: `Error Domain=NSURLErrorDomain Code=${code}` })).toBe(true);
  });
  it.each([408, 429, 500, 502, 503, 504])('retries read-only HTTP %s', (code) => {
    expect(isTransientNotaryFailure({ stderr: `HTTPError(statusCode: ${code})` })).toBe(true);
  });
  it('kills a hung command within its bounded timeout without exposing its command-line error', async () => {
    const result = await boundedCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], 200);
    expect(result).toMatchObject({ ok: false, timedOut: true });
    expect(result).not.toHaveProperty('message');
  }, 10_000);
  it('reports executable failures as non-transient rather than hanging or retrying', async () => {
    const result = await boundedCommand('clawx-nonexistent-notary-fixture-executable', [], 1_000);
    expect(result).toMatchObject({ ok: false, code: 'ENOENT' });
    expect(isTransientNotaryFailure(result)).toBe(false);
  });
});
