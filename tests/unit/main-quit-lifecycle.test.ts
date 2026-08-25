import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createQuitLifecycleState,
  markQuitCleanupCompleted,
  requestQuitLifecycleAction,
} from '@electron/main/quit-lifecycle';

describe('main quit lifecycle coordination', () => {
  it('starts cleanup only once', () => {
    const state = createQuitLifecycleState();

    expect(requestQuitLifecycleAction(state)).toBe('start-cleanup');
    expect(requestQuitLifecycleAction(state)).toBe('cleanup-in-progress');
  });

  it('allows quit after cleanup is marked complete', () => {
    const state = createQuitLifecycleState();

    expect(requestQuitLifecycleAction(state)).toBe('start-cleanup');
    markQuitCleanupCompleted(state);
    expect(requestQuitLifecycleAction(state)).toBe('allow-quit');
  });

  it('keeps scheduling independent of window lifetime and stops it before explicit quit teardown', () => {
    const source = readFileSync(join(process.cwd(), 'electron/main/index.ts'), 'utf8');
    const windowClosed = source.slice(
      source.indexOf("app.on('window-all-closed'"),
      source.indexOf("app.on('before-quit'"),
    );
    const beforeQuit = source.slice(
      source.indexOf("app.on('before-quit'"),
      source.indexOf('// Best-effort Gateway cleanup'),
    );

    expect(source).toContain('await clawXScheduler.start();');
    expect(windowClosed).not.toContain('clawXScheduler?.stop');
    expect(beforeQuit).toContain('await clawXScheduler?.stop()');
    expect(beforeQuit.indexOf('await clawXScheduler?.stop()')).toBeLessThan(
      beforeQuit.indexOf('await runtimeLifecycleCoordinator.stopAllForQuit'),
    );
  });

  it('runs integrity and read-only recovery before the DataService utility process starts', () => {
    const source = readFileSync(join(process.cwd(), 'electron/main/index.ts'), 'utf8');
    const recovery = source.indexOf('prepareClawXDataStore({');
    const dataServiceStart = source.indexOf('await dataServiceHost.start();');
    expect(recovery).toBeGreaterThan(0);
    expect(dataServiceStart).toBeGreaterThan(recovery);
    expect(source).toContain("recovery.state === 'read-only'");
  });
});
