// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

const electronState = vi.hoisted(() => ({
  userData: '/Users/test/Library/Application Support/ClawX',
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: fsMocks.existsSync,
    readFileSync: fsMocks.readFileSync,
    default: { ...actual, existsSync: fsMocks.existsSync, readFileSync: fsMocks.readFileSync },
  };
});

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => electronState.userData,
  },
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => '/Users/test' };
});

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

async function activateRuntime(overrides: Partial<{
  entryPath: string;
  nodeExecutable: string;
  packageDir: string;
}> = {}) {
  const runtime = await import('@electron/kernels/openclaw/runtime-location');
  runtime.configureOpenClawRuntimeLocation({
    kernelId: 'openclaw',
    artifactVersion: '2026.8.1-clawx.1',
    installRoot: '/kernels/openclaw/2026.8.1',
    packageDir: overrides.packageDir ?? '/kernels/openclaw/2026.8.1/runtime/kernel',
    entryPath: overrides.entryPath ?? '/kernels/openclaw/2026.8.1/runtime/kernel/openclaw.mjs',
    nodeExecutable: overrides.nodeExecutable ?? '/kernels/openclaw/2026.8.1/runtime/node/bin/node',
    stateRoot: '/user-data/kernel-config/openclaw',
    configRoot: '/user-data/kernel-config/openclaw',
    cacheRoot: '/user-data/kernel-cache/openclaw',
    tempRoot: '/user-data/kernel-cache/openclaw/tmp',
    managed: true,
    source: 'installed-artifact',
  });
}

describe('OpenClaw CLI over an optional verified runtime', () => {
  beforeEach(() => {
    vi.resetModules();
    fsMocks.existsSync.mockReset().mockReturnValue(false);
    fsMocks.readFileSync.mockReset().mockReturnValue('');
    electronState.userData = '/Users/test/Library/Application Support/ClawX';
    setPlatform('darwin');
  });

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  it('fails explicitly when OpenClaw is not installed or activated', async () => {
    const {
      getOpenClawCliCommand,
      getOpenClawCliSpawnSpec,
      getOpenClawEmbeddedForkSpec,
    } = await import('@electron/utils/openclaw-cli');

    expect(getOpenClawCliCommand).toThrow('OpenClaw runtime is not installed or activated');
    expect(getOpenClawCliSpawnSpec).toThrow('OpenClaw runtime is not installed or activated');
    expect(getOpenClawEmbeddedForkSpec).toThrow('OpenClaw runtime is not installed or activated');
  });

  it('builds a POSIX shell command from the activated artifact, not app resources', async () => {
    await activateRuntime();
    const { getOpenClawCliCommand } = await import('@electron/utils/openclaw-cli');

    expect(getOpenClawCliCommand()).toBe(
      "'/kernels/openclaw/2026.8.1/runtime/node/bin/node' '/kernels/openclaw/2026.8.1/runtime/kernel/openclaw.mjs'",
    );
  });

  it('quotes the activated artifact paths for PowerShell on Windows', async () => {
    setPlatform('win32');
    electronState.userData = 'C:\\Users\\test\\AppData\\Roaming\\ClawX';
    await activateRuntime({
      nodeExecutable: 'C:\\ClawX Kernels\\openclaw\\runtime\\node\\node.exe',
      entryPath: 'C:\\ClawX Kernels\\openclaw\\runtime\\kernel\\openclaw.mjs',
    });
    const { getOpenClawCliCommand } = await import('@electron/utils/openclaw-cli');

    expect(getOpenClawCliCommand()).toBe(
      "& 'C:\\ClawX Kernels\\openclaw\\runtime\\node\\node.exe' 'C:\\ClawX Kernels\\openclaw\\runtime\\kernel\\openclaw.mjs'",
    );
  });

  it('uses a generated managed wrapper but rejects an unrelated file at the same path', async () => {
    await activateRuntime();
    const wrapper = '/Users/test/.local/bin/openclaw';
    fsMocks.existsSync.mockImplementation((path) => String(path) === wrapper);
    fsMocks.readFileSync.mockReturnValue('# ClawX managed OpenClaw CLI');
    const { getOpenClawCliCommand, getOpenClawCliSpawnSpec } = await import('@electron/utils/openclaw-cli');

    expect(getOpenClawCliCommand()).toBe(`'${wrapper}'`);
    expect(getOpenClawCliSpawnSpec()).toEqual({ command: wrapper, args: [], shell: false });

    fsMocks.readFileSync.mockReturnValue('# user-owned wrapper');
    expect(getOpenClawCliSpawnSpec()).toMatchObject({
      command: '/kernels/openclaw/2026.8.1/runtime/node/bin/node',
      args: ['/kernels/openclaw/2026.8.1/runtime/kernel/openclaw.mjs'],
      shell: false,
    });
  });

  it('injects managed history and private state roots into direct CLI launches', async () => {
    await activateRuntime();
    const { getOpenClawCliSpawnSpec } = await import('@electron/utils/openclaw-cli');

    expect(getOpenClawCliSpawnSpec().env).toMatchObject({
      CLAWX_MANAGED_RUNTIME: '1',
      CLAWX_CONVERSATION_STORE_PROTOCOL: 'clawx.conversation-store/v1',
      OPENCLAW_STATE_DIR: '/user-data/kernel-config/openclaw',
      OPENCLAW_HISTORY_MODE: 'clawx-data-service',
      OPENCLAW_DISABLE_NATIVE_HISTORY: '1',
      OPENCLAW_DISABLE_CRON_HISTORY: '1',
    });
  });

  it('forks the activated runtime with its CI-provided Node executable', async () => {
    await activateRuntime();
    const { getOpenClawEmbeddedForkSpec } = await import('@electron/utils/openclaw-cli');

    expect(getOpenClawEmbeddedForkSpec(['acp'])).toMatchObject({
      modulePath: '/kernels/openclaw/2026.8.1/runtime/kernel/openclaw.mjs',
      args: ['acp'],
      options: {
        cwd: '/kernels/openclaw/2026.8.1/runtime/kernel',
        execPath: '/kernels/openclaw/2026.8.1/runtime/node/bin/node',
        execArgv: [],
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
        env: expect.objectContaining({ OPENCLAW_NO_RESPAWN: '1' }),
      },
    });
  });
});
