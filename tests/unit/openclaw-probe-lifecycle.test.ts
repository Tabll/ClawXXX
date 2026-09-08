// @vitest-environment node
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { openClawProbeBudgets, waitForGatewayReady } from '../../scripts/kernel-runtime/lib/openclaw-probe-lifecycle.mjs';
import { nextOpenClawProbeToolCall, PROBE_PROCESS_POLL_LIMIT, PROBE_PROCESS_POLL_MS } from '../../scripts/kernel-runtime/lib/openclaw-probe-provider.mjs';
import { collectOpenClawProbe, createOpenClawProbeTrace } from '../../scripts/kernel-runtime/lib/openclaw-probe-process.mjs';

const child = () => Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null as string | null });
const clock = () => {
  let elapsed = 0;
  return { now: () => elapsed, sleep: async (ms: number) => { elapsed += ms; }, advance: (ms: number) => { elapsed += ms; } };
};

const outputChild = () => Object.assign(child(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) });

describe('sealed OpenClaw process output and failure evidence', () => {
  it('waits for close and retains output arriving after exit instead of reading a partial report', async () => {
    const process = outputChild();
    const settled = vi.fn();
    const result = collectOpenClawProbe(process, { timeoutMs: 1000 }).then(settled);
    process.stdout.write('{"ok":');
    process.stderr.write('early warning\n');
    process.exitCode = 37;
    process.emit('exit', 37, null);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    process.stdout.write('false}\n');
    process.stderr.write('late failure detail');
    process.emit('close', 37, null);
    await result;
    expect(settled).toHaveBeenCalledWith({ exitCode: 37, signal: null, stdout: '{"ok":false}\n', stderr: 'early warning\nlate failure detail' });
    expect(process.listenerCount('close')).toBe(0);
    expect(process.listenerCount('error')).toBe(0);
    expect(process.stdout.listenerCount('data')).toBe(0);
  });

  it('collects the complete output and real nonzero status of a native child', async () => {
    const process = spawn(globalThis.process.execPath, ['-e', 'process.stdout.write("x".repeat(90000)); process.stderr.write("native failure tail"); process.exitCode=37;'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const result = await collectOpenClawProbe(process, { timeoutMs: 3000 });
    expect(result).toMatchObject({ exitCode: 37, signal: null, stderr: 'native failure tail' });
    expect(result.stdout).toBe('x'.repeat(90000));
    expect(result.failure).toBeUndefined();
  });

  it('preserves signal-only termination and spawn errors without inventing a zero exit', async () => {
    for (const kind of ['signal', 'spawn']) {
      const process = outputChild();
      const result = collectOpenClawProbe(process, { timeoutMs: 1000 });
      if (kind === 'signal') process.signalCode = 'SIGTERM';
      else {
        process.exitCode = -2;
        process.emit('error', Object.assign(new Error('missing executable'), { code: 'ENOENT' }));
      }
      process.emit('close', process.exitCode, process.signalCode);
      expect(await result).toMatchObject(kind === 'signal'
        ? { exitCode: null, signal: 'SIGTERM' }
        : { exitCode: -2, signal: null, failure: 'process-error', spawnError: 'ENOENT' });
      expect(process.kill).not.toHaveBeenCalled();
    }
  });

  it('does not turn a timeout into success when close later reports zero', async () => {
    vi.useFakeTimers();
    try {
      const process = outputChild();
      const result = collectOpenClawProbe(process, { timeoutMs: 100, killDrainMs: 50 });
      await vi.advanceTimersByTimeAsync(100);
      expect(process.kill).toHaveBeenCalledOnce();
      expect(process.kill).toHaveBeenCalledWith('SIGKILL');
      process.exitCode = 0;
      process.stderr.write('tail after termination request');
      process.emit('close', 0, null);
      expect(await result).toMatchObject({ failure: 'timeout', exitCode: 0, stderr: 'tail after termination request' });
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('bounds failed drain cleanup without killing an already exited process', async () => {
    vi.useFakeTimers();
    try {
      const process = outputChild();
      const result = collectOpenClawProbe(process, { timeoutMs: 100, killDrainMs: 50 });
      process.exitCode = 0;
      process.emit('exit', 0, null);
      await vi.advanceTimersByTimeAsync(150);
      expect(await result).toMatchObject({ failure: 'timeout', exitCode: 0 });
      expect(process.kill).not.toHaveBeenCalled();
      expect(process.stdout.destroyed).toBe(true);
      expect(process.stderr.destroyed).toBe(true);
      expect(process.listenerCount('close')).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('rejects oversized reports while retaining bounded stdout and the stderr tail', async () => {
    const process = outputChild();
    const result = collectOpenClawProbe(process, { timeoutMs: 1000, stdoutLimit: 8, stderrLimit: 8 });
    process.stderr.write('0123456789');
    process.stdout.write('0123456789');
    process.exitCode = 1;
    process.emit('close', 1, null);
    expect(await result).toMatchObject({ failure: 'stdout-limit', stdout: '01234567', stderr: '23456789', exitCode: 1 });
    expect(process.kill).toHaveBeenCalledOnce();
  });

  it('rejects invalid collection budgets before registering listeners', () => {
    const process = outputChild();
    for (const timeoutMs of [undefined, 0, -1, Infinity, 1.5]) {
      expect(() => collectOpenClawProbe(process, { timeoutMs })).toThrow('Invalid probe process collection budget');
    }
    expect(process.listenerCount('close')).toBe(0);
  });

  it('persists only bounded closed phase labels before a final report exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-probe-trace-'));
    const report = join(root, 'nested', 'probe.json');
    let now = 10;
    try {
      const phase = createOpenClawProbeTrace(report, { now: () => now });
      phase('prepare');
      now = 135;
      phase('tool');
      phase('failed');
      const rows = readFileSync(`${report}.progress.jsonl`, 'utf8').trim().split('\n').map(row => JSON.parse(row));
      expect(rows.map(row => [row.sequence, row.phase, row.elapsedMs])).toEqual([[1, 'prepare', 0], [2, 'tool', 125], [3, 'failed', 125]]);
      expect(Object.keys(rows[0]).sort()).toEqual(['elapsedMs', 'event', 'phase', 'schemaVersion', 'sequence']);
      expect(() => phase('arbitrary local path')).toThrow('Unknown OpenClaw probe phase');
      for (let index = 3; index < 64; index++) phase('cleanup');
      expect(() => phase('complete')).toThrow('phase budget exceeded');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('does not silently claim that failed evidence writes were persisted', () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-probe-trace-failure-'));
    try {
      const phase = createOpenClawProbeTrace(join(root, 'probe.json'), { write: () => { throw new Error('owned evidence volume full'); } });
      expect(() => phase('report')).toThrow('owned evidence volume full');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('real OpenClaw probe lifecycle', () => {
  it('limits the Windows full-runtime budget without changing other platforms', () => {
    expect(openClawProbeBudgets('win32')).toEqual({ gatewayReadyMs: 180_000, totalMs: 600_000 });
    for (const platform of ['darwin', 'linux']) expect(openClawProbeBudgets(platform)).toEqual({ gatewayReadyMs: 90_000, totalMs: 300_000 });
  });

  it('waits for actual HTTP success and releases unsuccessful response bodies', async () => {
    const process = child();
    const cancel = vi.fn(async () => {});
    const fetchHealth = vi.fn().mockResolvedValueOnce({ status: 503, ok: false, body: { cancel } }).mockResolvedValueOnce({ status: 200, ok: true, body: { cancel } });
    await expect(waitForGatewayReady(process, 'http://127.0.0.1/healthz', { ...clock(), timeoutMs: 1000, fetchHealth })).resolves.toEqual({ readyMs: 200, budgetMs: 1000 });
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(process.listenerCount('error')).toBe(0);
  });

  it('fails at the finite deadline and retains the last HTTP status', async () => {
    const process = child();
    const cancel = vi.fn(async () => {});
    const fetchHealth = vi.fn(async () => ({ status: 503, ok: false, body: { cancel } }));
    const timing = clock();
    await expect(waitForGatewayReady(process, 'http://127.0.0.1/healthz', { ...timing, timeoutMs: 450, fetchHealth })).rejects.toThrow('450ms; last health=HTTP 503');
    expect(timing.now()).toBe(450);
    expect(cancel).toHaveBeenCalledTimes(3);
    expect(process.listenerCount('error')).toBe(0);
  });

  it.each([{ exitCode: 0, signalCode: null }, { exitCode: null, signalCode: 'SIGKILL' }])('rejects an exited process, including signal-only termination: %o', async state => {
    const process = Object.assign(child(), state);
    const fetchHealth = vi.fn();
    await expect(waitForGatewayReady(process, 'http://127.0.0.1/healthz', { fetchHealth })).rejects.toThrow('Gateway exited during startup');
    expect(fetchHealth).not.toHaveBeenCalled();
    expect(process.listenerCount('error')).toBe(0);
  });

  it('does not accept HTTP success after the deadline or after process death', async () => {
    for (const termination of ['deadline', 'signal']) {
      const process = child();
      const timing = clock();
      const fetchHealth = vi.fn(async () => {
        if (termination === 'deadline') timing.advance(500);
        else process.signalCode = 'SIGKILL';
        return { status: 200, ok: true, body: { cancel: async () => {} } };
      });
      await expect(waitForGatewayReady(process, 'http://127.0.0.1/healthz', { ...timing, timeoutMs: 500, fetchHealth })).rejects.toThrow(/timed out|exited/);
    }
  });

  it('reports spawn errors instead of waiting the full startup budget', async () => {
    const process = child();
    const fetchHealth = vi.fn(async () => { process.emit('error', new Error('ENOENT')); throw new Error('unreachable'); });
    await expect(waitForGatewayReady(process, 'http://127.0.0.1/healthz', { ...clock(), fetchHealth })).rejects.toThrow('Gateway spawn failed: ENOENT');
    expect(process.listenerCount('error')).toBe(0);
  });
});

describe('real OpenClaw probe background execution', () => {
  const command = 'node.exe clawx-tool-probe.cjs';
  const running = 'Command still running (session owned-42, pid 123). Use process for follow-up.';
  const next = (messages: unknown[]) => nextOpenClawProbeToolCall(messages, command);
  const exchange = (messages: unknown[], content: unknown) => {
    const call = next(messages);
    expect(call).toBeDefined();
    messages.push({ role: 'assistant', tool_calls: [call] });
    messages.push({ role: 'tool', tool_call_id: call.id, content });
    return call;
  };

  it('forces the fixed command to background and polls only its exact returned session', () => {
    const messages: unknown[] = [];
    const exec = exchange(messages, running);
    expect(exec.function.name).toBe('exec');
    expect(JSON.parse(exec.function.arguments)).toEqual({ command, background: true });
    const poll = next(messages);
    expect(poll.function.name).toBe('process');
    expect(JSON.parse(poll.function.arguments)).toEqual({ action: 'poll', sessionId: 'owned-42', timeout: 5_000 });
  });

  it('does not finish on a running result, even if it already contains stdout', () => {
    const messages: unknown[] = [];
    exchange(messages, running);
    exchange(messages, 'CLAWX_TOOL_OK\n\nProcess still running.');
    expect(next(messages).id).toBe('clawx-probe-poll-2');
    exchange(messages, '(no new output)\n\nProcess exited with code 0.');
    expect(next(messages)).toBeUndefined();
  });

  it('binds adapter-normalized call IDs without reissuing exec', () => {
    const exec = next([]);
    exec.id = 'normalized-exec-call';
    const messages: unknown[] = [{ role: 'assistant', tool_calls: [exec] }, { role: 'tool', tool_call_id: exec.id, content: running }];
    const poll = next(messages);
    expect(poll.function.name).toBe('process');
    poll.id = 'normalized-process-call';
    messages.push({ role: 'assistant', tool_calls: [poll] }, { role: 'tool', tool_call_id: poll.id, content: 'CLAWX_TOOL_OK\n\nProcess exited with code 0.' });
    expect(next(messages)).toBeUndefined();
  });

  it('never repeats exec if the provider history has an unbound tool result', () => {
    expect(() => next([{ role: 'tool', tool_call_id: 'unknown', content: running }])).toThrow('lost tool call identity');
  });

  it.each(['CLAWX_TOOL_OK\n\nProcess exited with code 0.', [{ type: 'text', text: 'CLAWX_TOOL_OK\r\n\r\nProcess exited with code 0.' }]])('accepts native terminal success with its real marker: %j', content => {
    const messages: unknown[] = [];
    exchange(messages, running);
    exchange(messages, content);
    expect(next(messages)).toBeUndefined();
  });

  it.each([
    'CLAWX_TOOL_OK\n\nProcess exited with code 1.',
    'CLAWX_TOOL_OK\n\nProcess exited with signal SIGTERM.',
    '(no new output)\n\nProcess exited with code 0.',
    'No session found for owned-42',
    'unrecognized result',
  ])('fails closed on failed, missing or malformed completion: %s', content => {
    const messages: unknown[] = [];
    exchange(messages, running);
    exchange(messages, content);
    expect(() => next(messages)).toThrow();
  });

  it('bounds polls without changing the native probe deadlines', () => {
    expect(PROBE_PROCESS_POLL_LIMIT).toBe(8);
    expect(PROBE_PROCESS_POLL_MS).toBe(5_000);
    const messages: unknown[] = [];
    exchange(messages, running);
    for (let index = 0; index < PROBE_PROCESS_POLL_LIMIT; index += 1) {
      exchange(messages, '(no new output)\n\nProcess still running.');
    }
    expect(() => next(messages)).toThrow('bounded poll sequence');
  });

  it('rejects mismatched command, session or response identities', () => {
    for (const mutation of ['command', 'session', 'missing', 'duplicate']) {
      const exec = next([]);
      const messages = [{ role: 'assistant', tool_calls: [exec] }, { role: 'tool', tool_call_id: exec.id, content: running }];
      if (mutation === 'command') exec.function.arguments = JSON.stringify({ command: 'unowned command', background: true });
      if (mutation === 'missing') messages[1].tool_call_id = 'foreign-result';
      if (mutation === 'duplicate') messages.push(messages[1]);
      if (mutation === 'session') {
        const poll = next(messages);
        poll.function.arguments = JSON.stringify({ action: 'poll', sessionId: 'foreign-session', timeout: 5_000 });
        messages.push({ role: 'assistant', tool_calls: [poll] }, { role: 'tool', tool_call_id: poll.id, content: 'CLAWX_TOOL_OK\n\nProcess exited with code 0.' });
      }
      expect(() => next(messages)).toThrow();
    }
  });

  it('handles native foreground completion but rejects unknown results instead of assuming success', () => {
    const success: unknown[] = [];
    exchange(success, 'CLAWX_TOOL_OK\n');
    expect(next(success)).toBeUndefined();
    for (const text of ['approval denied', 'Command still running (session invalid/session, pid 123).', 'CLAWX_TOOL_OK\n(Command exited with code 1)']) {
      const messages: unknown[] = [];
      exchange(messages, text);
      expect(() => next(messages)).toThrow();
    }
  });
});
