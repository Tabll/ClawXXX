// @vitest-environment node
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { configureOpenClawRuntimeLocation, clearOpenClawRuntimeLocation } from '@electron/kernels/openclaw/runtime-location';

const mocks = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: mocks.execFile, default: { execFile: mocks.execFile } }));
import { writeOpenClawAgentAuth } from '@electron/utils/openclaw-agent-auth-writer';

beforeEach(() => {
  vi.clearAllMocks();
  const root = join(tmpdir(), 'verified-auth-runtime');
  configureOpenClawRuntimeLocation({ kernelId: 'openclaw', artifactVersion: 'verified',
    installRoot: root, packageDir: root, entryPath: join(root, 'openclaw.mjs'), nodeExecutable: join(root, 'node'),
    stateRoot: join(root, 'state'), configRoot: join(root, 'state'), cacheRoot: join(root, 'cache'), tempRoot: join(root, 'tmp'),
    managed: true, source: 'installed-artifact' });
});

describe('kernel-owned Agent auth writes', () => {
  it('uses the selected native Node and stdin instead of leaking credentials into argv or logs', async () => {
    const stdin = Object.assign(new EventEmitter(), { end: vi.fn() });
    mocks.execFile.mockReturnValue({ stdin });
    const pending = writeOpenClawAgentAuth('main', { version: 1, profiles: { synthetic: { key: 'secret-only-on-stdin' } } }, null);
    const [command, args, options, done] = mocks.execFile.mock.calls[0];
    expect(command).toBe(join(tmpdir(), 'verified-auth-runtime/node'));
    expect(args.join(' ')).not.toContain('secret-only-on-stdin');
    expect(JSON.stringify(options.env)).not.toContain('secret-only-on-stdin');
    expect(options).toMatchObject({ windowsHide: true, timeout: 30_000, killSignal: 'SIGKILL' });
    expect(options.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(stdin.end).toHaveBeenCalledWith(expect.stringContaining('secret-only-on-stdin'));
    done(null, 'diagnostic\nCLAWX_AGENT_AUTH_RESULT={"ok":true}\n');
    await expect(pending).resolves.toBeUndefined();
  });

  it('rejects worker failure without surfacing raw exception output or input values', async () => {
    mocks.execFile.mockImplementation((_command, _args, _options, done) => {
      queueMicrotask(() => done(new Error('raw-secret-in-exception'), 'raw-secret-in-output', 'raw-secret-in-stderr'));
      return { stdin: Object.assign(new EventEmitter(), { end: vi.fn() }) };
    });
    await expect(writeOpenClawAgentAuth('main', { profiles: {} }, null)).rejects.toThrow('process / worker_failed');
  });

  it('fails before spawning when the runtime, agent ID or payload is invalid', async () => {
    await expect(writeOpenClawAgentAuth('../main', { profiles: {} }, null)).rejects.toThrow('Invalid');
    await expect(writeOpenClawAgentAuth('main', { profiles: {}, oversized: 'x'.repeat(1024 * 1024) }, null)).rejects.toThrow('1 MiB');
    clearOpenClawRuntimeLocation();
    await expect(writeOpenClawAgentAuth('main', { profiles: {} }, null)).rejects.toThrow('not installed');
    expect(mocks.execFile).not.toHaveBeenCalled();
  });
});
