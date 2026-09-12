// @vitest-environment node
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GatewayLaunchContext } from '@electron/gateway/config-sync';
import { configureOpenClawRuntimeLocation } from '@electron/kernels/openclaw/runtime-location';

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));
vi.mock('electron', () => ({ app: { isPackaged: true }, utilityProcess: { fork: () => { throw new Error('Kernel must not use Electron Helper'); } } }));
vi.mock('node:child_process', () => ({ spawn: mockSpawn, default: { spawn: mockSpawn } }));
vi.mock('@electron/utils/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
import { launchGatewayProcess } from '@electron/gateway/process-launcher';
import { waitForGatewayReady } from '@electron/gateway/ws-client';

const node = join(tmpdir(), 'verified runtime', 'bin', 'node');
beforeEach(() => {
  vi.clearAllMocks();
  configureOpenClawRuntimeLocation({
    kernelId: 'openclaw', artifactVersion: 'verified', installRoot: tmpdir(),
    packageDir: tmpdir(), entryPath: join(tmpdir(), 'openclaw.mjs'), nodeExecutable: node,
    stateRoot: tmpdir(), configRoot: tmpdir(), cacheRoot: tmpdir(), tempRoot: tmpdir(),
    managed: true, source: 'installed-artifact',
  });
});

function setup() {
  const child = Object.assign(new EventEmitter(), { pid: 123, stderr: new EventEmitter() });
  mockSpawn.mockReturnValue(child);
  const options = {
    port: 18789,
    launchContext: { openclawDir: tmpdir(), entryScript: join(tmpdir(), 'openclaw.mjs'), gatewayArgs: ['gateway'],
      forkEnv: { ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--require injected.cjs', PATH: '/system' },
      mode: 'packaged', binPathExists: false, loadedProviderKeyCount: 0, proxySummary: 'disabled', channelStartupSummary: 'skipped' } as GatewayLaunchContext,
    sanitizeSpawnArgs: (args: string[]) => args, getCurrentState: () => 'starting' as const,
    getShouldReconnect: () => true, onStderrLine: vi.fn(), onSpawn: vi.fn(), onExit: vi.fn(), onError: vi.fn(),
  };
  return { child, options };
}

describe('Gateway native Node process lifecycle', () => {
  it('launches the selected artifact Node with no shell or Electron flags and reports exit', async () => {
    const { child, options } = setup();
    const pending = launchGatewayProcess(options);
    expect(mockSpawn).toHaveBeenCalledWith(node, [join(tmpdir(), 'openclaw.mjs'), 'gateway'], expect.objectContaining({ shell: false, windowsHide: true }));
    const env = mockSpawn.mock.calls[0][2].env;
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    child.emit('spawn');
    expect((await pending).child).toBe(child);
    child.emit('exit', null, 'SIGABRT');
    expect(options.onSpawn).toHaveBeenCalledWith(123);
    expect(options.onExit).toHaveBeenCalledWith(child, null);
  });

  it('rejects an early spawn error and supplies the failed child before await completes', async () => {
    const { child, options } = setup();
    const pending = launchGatewayProcess(options);
    const error = new Error('spawn ENOENT');
    const rejected = expect(pending).rejects.toThrow('spawn ENOENT');
    child.emit('error', error);
    await rejected;
    expect(options.onError).toHaveBeenCalledWith(error, child);
  });

  it('does not wait for readiness after a signal-only Node exit', async () => {
    await expect(waitForGatewayReady({ port: 0, getProcessExitCode: () => null,
      getProcessExitSignal: () => 'SIGABRT', retries: 1 })).rejects.toThrow('signal=SIGABRT');
  });
});
