// @vitest-environment node
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { openClawProbeBudgets, waitForGatewayReady } from '../../scripts/kernel-runtime/lib/openclaw-probe-lifecycle.mjs';

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
