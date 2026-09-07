// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { forEachKernelFile, KERNEL_FILE_IO_CONCURRENCY } from '@electron/kernels/package-manager/bounded-io';

describe('bounded kernel filesystem work', () => {
  it('runs every file once with a fixed pool instead of serial or unbounded work', async () => {
    let active = 0;
    let maximum = 0;
    const visited: number[] = [];
    await forEachKernelFile(Array.from({ length: 73 }, (_, index) => index), async (item, index) => {
      expect(item).toBe(index);
      maximum = Math.max(maximum, ++active);
      await new Promise<void>(resolve => setImmediate(resolve));
      visited.push(item);
      active -= 1;
    });
    expect(maximum).toBe(8);
    expect(KERNEL_FILE_IO_CONCURRENCY).toBe(8);
    expect(active).toBe(0);
    expect(visited.sort((a, b) => a - b)).toEqual(Array.from({ length: 73 }, (_, index) => index));
  });

  it('stops admitting work on failure and drains every in-flight operation before rejecting', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const error = new Error('hash mismatch');
    let active = 0;
    let settled = false;
    const visited: number[] = [];
    const result = forEachKernelFile(Array.from({ length: 50 }, (_, index) => index), async index => {
      visited.push(index);
      if (index === 0) throw error;
      active += 1;
      await blocked;
      active -= 1;
    }).catch(caught => { settled = true; return caught; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(visited).toHaveLength(8);
    expect(active).toBe(7);
    release();
    expect(await result).toBe(error);
    expect(active).toBe(0);
    expect(visited).toHaveLength(8);
  });

  it('handles empty work and thrown undefined without swallowing failure', async () => {
    await forEachKernelFile([], async () => { throw new Error('must not run'); });
    let rejected = false;
    await forEachKernelFile([1], async () => { throw undefined; }).catch(() => { rejected = true; });
    expect(rejected).toBe(true);
  });
});
