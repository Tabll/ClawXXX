// @vitest-environment node
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renameRuntimeDirectory } from '@electron/kernels/package-manager/runtime-directory';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('atomic runtime directory moves', () => {
  it.each(['EPERM', 'EBUSY'])('allows a short Windows %s lock to release without changing paths or permissions', async code => {
    vi.useFakeTimers();
    const move = vi.spyOn(fs, 'rename')
      .mockRejectedValueOnce(Object.assign(new Error('locked'), { code }))
      .mockResolvedValueOnce(undefined);
    const chmod = vi.spyOn(fs, 'chmod');
    const copy = vi.spyOn(fs, 'copyFile');
    const remove = vi.spyOn(fs, 'rm');
    const result = renameRuntimeDirectory('owned/staging', 'owned/installed', 'win32');
    await vi.advanceTimersByTimeAsync(49);
    expect(move).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await result;
    expect(move.mock.calls).toEqual([['owned/staging', 'owned/installed'], ['owned/staging', 'owned/installed']]);
    expect(chmod).not.toHaveBeenCalled(); expect(copy).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails with the original error after six attempts and 1500 ms total waiting for a persistent Windows lock', async () => {
    vi.useFakeTimers();
    const error = Object.assign(new Error('persistent lock'), { code: 'EPERM' });
    const move = vi.spyOn(fs, 'rename').mockRejectedValue(error);
    let settled = false;
    const result = renameRuntimeDirectory('staging', 'installed', 'win32').catch(caught => { settled = true; return caught; });
    await vi.advanceTimersByTimeAsync(1499);
    expect(settled).toBe(false);
    expect(move).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe(error);
    expect(move).toHaveBeenCalledTimes(6);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['EACCES', 'ENOENT', 'EXDEV', 'ENOTEMPTY'])('does not retry or hide Windows %s errors', async code => {
    const error = Object.assign(new Error(code), { code });
    const move = vi.spyOn(fs, 'rename').mockRejectedValue(error);
    await expect(renameRuntimeDirectory('staging', 'installed', 'win32')).rejects.toBe(error);
    expect(move).toHaveBeenCalledTimes(1);
  });

  it.each(['darwin', 'linux'] as const)('does not introduce lock retries on %s', async platform => {
    const error = Object.assign(new Error('locked'), { code: 'EPERM' });
    const move = vi.spyOn(fs, 'rename').mockRejectedValue(error);
    await expect(renameRuntimeDirectory('staging', 'installed', platform)).rejects.toBe(error);
    expect(move).toHaveBeenCalledTimes(1);
  });

  it('moves a real readonly payload without copying or changing its mode', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'clawx-atomic-directory-'));
    try {
      const source = join(root, 'staging'); const destination = join(root, 'installed');
      await fs.mkdir(source);
      await fs.writeFile(join(source, 'control.mjs'), 'immutable');
      await fs.chmod(join(source, 'control.mjs'), 0o444);
      const before = await fs.stat(join(source, 'control.mjs'));
      await renameRuntimeDirectory(source, destination);
      await expect(fs.stat(source)).rejects.toMatchObject({ code: 'ENOENT' });
      const after = await fs.stat(join(destination, 'control.mjs'));
      expect(after.ino).toBe(before.ino);
      expect(after.mode).toBe(before.mode);
      expect(await fs.readFile(join(destination, 'control.mjs'), 'utf8')).toBe('immutable');
    } finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 3 }); }
  });
});
