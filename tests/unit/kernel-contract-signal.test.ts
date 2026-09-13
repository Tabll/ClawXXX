// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createContractSignal } from '../fixtures/kernels/contract-signal';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('contract event barriers', () => {
  it('keeps its real watchdog when scheduler timers are controlled after observer creation', async () => {
    const signal = createContractSignal('real watchdog', 20);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const result = signal.waitFor().catch(error => error);
      expect(vi.getTimerCount()).toBe(0);
      expect(await result).toEqual(new Error('real watchdog: no matching event within 20 ms'));
    } finally {
      signal.dispose();
    }
  });

  it('retains an already-completed event without scheduling a polling timer', async () => {
    vi.useFakeTimers();
    const signal = createContractSignal<number>('persisted');
    signal.publish(1);
    signal.publish(2);
    expect(await signal.waitFor(value => value === 2)).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
    signal.dispose();
  });

  it('waits for the exact event and resolves all matching observers immediately', async () => {
    vi.useFakeTimers();
    const signal = createContractSignal<number>('started');
    let settled = false;
    const first = signal.waitFor(value => value === 2).then(value => { settled = true; return value; });
    const second = signal.waitFor(value => value === 2);
    signal.publish(1);
    await Promise.resolve();
    expect(settled).toBe(false);
    signal.publish(2);
    expect(await Promise.all([first, second])).toEqual([2, 2]);
    expect(vi.getTimerCount()).toBe(0);
    signal.dispose();
  });

  it('fails a missing event within the existing two-second inner wait budget', async () => {
    vi.useFakeTimers();
    const signal = createContractSignal('durable terminal');
    const result = signal.waitFor().catch(error => error);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await result).toEqual(new Error('durable terminal: no matching event within 2000 ms'));
    expect(vi.getTimerCount()).toBe(0);
    signal.dispose();
  });

  it('rejects pending and future observers on teardown without leaking timers', async () => {
    vi.useFakeTimers();
    const signal = createContractSignal('owned test');
    const pending = signal.waitFor().catch(error => error);
    signal.dispose();
    signal.publish('late event');
    expect(await pending).toEqual(new Error('owned test: observer disposed'));
    await expect(signal.waitFor()).rejects.toThrow('observer disposed');
    expect(vi.getTimerCount()).toBe(0);
  });
});
