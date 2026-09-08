// @vitest-environment node
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { openClawProbeBudgets, waitForGatewayReady } from '../../scripts/kernel-runtime/lib/openclaw-probe-lifecycle.mjs';
import { nextOpenClawProbeToolCall, PROBE_PROCESS_POLL_LIMIT, PROBE_PROCESS_POLL_MS } from '../../scripts/kernel-runtime/lib/openclaw-probe-provider.mjs';

const child = () => Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null as string | null });
const clock = () => {
  let elapsed = 0;
  return { now: () => elapsed, sleep: async (ms: number) => { elapsed += ms; }, advance: (ms: number) => { elapsed += ms; } };
};

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
