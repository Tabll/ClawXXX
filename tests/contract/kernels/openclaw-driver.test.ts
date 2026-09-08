// @vitest-environment node

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OpenClawKernelDriver,
  type OpenClawChatAdapter,
  type OpenClawGatewayAdapter,
} from '@electron/kernels/openclaw/openclaw-driver';
import {
  assertManagedOpenClawRuntimeProtocol,
  buildManagedOpenClawEnvironment,
  clearOpenClawRuntimeLocation,
  getManagedOpenClawDataRoots,
  resolveOpenClawRuntimeLocation,
} from '@electron/kernels/openclaw/runtime-location';
import {
  assertNoForbiddenOpenClawHistory,
  listForbiddenOpenClawHistory,
  purgeForbiddenOpenClawHistory,
} from '@electron/kernels/openclaw/managed-history-guard';
import { createFakeHost } from './driver-contract-kit';
import { FakeKernelDriver } from './fakes/fake-kernel-driver';
import { asConversationId, asRunId, asTurnId } from '@shared/conversations/contracts';
import type { KernelInstallationRecord } from '@shared/kernels/package-manager';

const ownedRoots: string[] = [];
afterEach(() => {
  clearOpenClawRuntimeLocation();
  for (const root of ownedRoots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

function runtimeFixture(platform: 'darwin' | 'linux' | 'win32' = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux') {
  const root = mkdtempSync(join(tmpdir(), 'clawx-openclaw-driver-'));
  ownedRoots.push(root);
  const packageRoot = join(root, 'kernels');
  const userDataRoot = join(root, 'user-data');
  const artifactVersion = '2026.7.1-2+clawx.test';
  const installRoot = join(packageRoot, 'openclaw', 'installs', artifactVersion);
  const entryPath = join(installRoot, 'runtime', 'kernel', 'clawx-openclaw.mjs');
  const nodeRelative = platform === 'win32' ? 'runtime/node/node.exe' : 'runtime/node/bin/node';
  const nodePath = join(installRoot, nodeRelative);
  mkdirSync(join(installRoot, 'runtime', 'kernel'), { recursive: true });
  mkdirSync(dirname(nodePath), { recursive: true });
  writeFileSync(entryPath, 'export {};');
  writeFileSync(nodePath, 'test');
  const manifest = {
    schemaVersion: 1 as const,
    kernelId: 'openclaw' as const,
    artifactVersion,
    upstreamVersion: '2026.7.1-2',
    patchRevision: 99,
    platform,
    arch: process.arch === 'arm64' ? 'arm64' as const : 'x64' as const,
    nodeVersion: '24.0.0',
    hostVersionRange: '>=0.5.4',
    contractVersion: 1 as const,
    storeProtocolRange: '1',
    checkpointCodecs: ['clawx.openclaw.session-manager/v1'],
    nativeHistoryPolicy: 'forbidden' as const,
    archiveSha256: 'a'.repeat(64),
    unpackedBytes: 1,
    fileCount: 2,
    entrypoints: { chat: 'runtime/kernel/clawx-openclaw.mjs' },
    executablePaths: [nodeRelative],
  };
  const installation: KernelInstallationRecord = {
    kernelId: 'openclaw',
    activeVersion: artifactVersion,
    lastKnownGoodVersion: artifactVersion,
    desiredVersion: artifactVersion,
    state: 'installed',
    manifest,
    updatedAt: new Date(0).toISOString(),
  };
  const runtime = resolveOpenClawRuntimeLocation({
    installation,
    packageRoot,
    userDataRoot,
    platform,
  });
  return { root, runtime, userDataRoot, packageRoot, installation, installRoot, entryPath, nodePath };
}

describe('OpenClaw optional runtime driver', () => {
  it.each(['darwin', 'linux', 'win32'] as const)('uses the exact %s executable layout and refuses a missing runtime', platform => {
    const f = runtimeFixture(platform);
    expect(f.runtime.installRoot).toBe(f.installRoot);
    expect(f.runtime.entryPath).toBe(f.entryPath);
    expect(f.runtime.nodeExecutable).toBe(f.nodePath);
    expect(f.runtime.source).toBe('installed-artifact');
    rmSync(f.nodePath);
    expect(() => resolveOpenClawRuntimeLocation({
      installation: f.installation, packageRoot: f.packageRoot, userDataRoot: f.userDataRoot, platform,
    })).toThrow('Node runtime is missing from active artifact');
    expect(existsSync(f.runtime.configRoot)).toBe(false);
  });

  it('rejects an old or incomplete managed protocol without changing config or the installed payload', () => {
    const { root, runtime } = runtimeFixture();
    try {
      mkdirSync(runtime.configRoot, { recursive: true });
      const configPath = join(runtime.configRoot, 'openclaw.json');
      const config = '{"agents":{"list":[{"id":"main"}]},"channels":{"telegram":{"tokenRef":"keep"}}}';
      writeFileSync(configPath, config);
      const packagePath = join(runtime.packageDir, 'package.json');
      for (const clawx of [undefined, { managedSessionProtocol: 'clawx.openclaw-session/v1' }, { managedSessionProtocol: 'clawx.openclaw-session/v2', storageFenceVersion: 1 }]) {
        const pkg = JSON.stringify({ name: 'openclaw', version: '2026.9.2', clawx });
        writeFileSync(packagePath, pkg);
        expect(() => assertManagedOpenClawRuntimeProtocol(runtime)).toThrow('Install the updated verified OpenClaw runtime');
        expect(readFileSync(packagePath, 'utf8')).toBe(pkg);
        expect(readFileSync(configPath, 'utf8')).toBe(config);
        expect(existsSync(runtime.cacheRoot)).toBe(false);
      }
      writeFileSync(packagePath, JSON.stringify({ clawx: { managedSessionProtocol: 'clawx.openclaw-session/v1', storageFenceVersion: 1 } }));
      expect(() => assertManagedOpenClawRuntimeProtocol(runtime)).not.toThrow();
      expect(readFileSync(configPath, 'utf8')).toBe(config);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves only an active installation record and creates no managed data before start', async () => {
    const { runtime, userDataRoot, entryPath, nodePath, root } = runtimeFixture();
    const roots = getManagedOpenClawDataRoots(userDataRoot);
    expect(runtime.entryPath).toBe(entryPath);
    expect(runtime.nodeExecutable).toBe(nodePath);
    expect(runtime.entryPath).not.toContain(join('resources', 'openclaw'));
    expect(existsSync(roots.configRoot)).toBe(false);

    const gateway: OpenClawGatewayAdapter = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      getStatus: () => ({ state: 'running', pid: 12, version: 'test' }),
      checkHealth: vi.fn(async () => ({ ok: true })),
    };
    const chat: OpenClawChatAdapter = {
      initialize: vi.fn(async () => undefined),
      execute: vi.fn(async input => ({ ...input, acceptedAt: new Date(0).toISOString() })),
      cancel: vi.fn(async () => ({ acknowledged: true })),
      resolvePermission: vi.fn(async () => undefined),
      updateRunConfiguration: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    const hooks: string[] = [];
    const driver = new OpenClawKernelDriver({
      generation: 3,
      runtime,
      gateway,
      chat,
      control: new FakeKernelDriver('openclaw').control,
      hooks: {
        beforeStart: async () => { hooks.push('before-start'); },
        afterStart: async () => { hooks.push('after-start'); },
        beforeStop: async () => { hooks.push('before-stop'); },
        afterStop: async () => { hooks.push('after-stop'); },
      },
    });
    await driver.initialize(createFakeHost());
    expect(existsSync(roots.configRoot)).toBe(false);
    expect(await driver.start()).toEqual(expect.objectContaining({
      kernelId: 'openclaw', generation: 3, state: 'ready', pid: 12,
    }));
    expect(existsSync(roots.configRoot)).toBe(true);
    expect(buildManagedOpenClawEnvironment(runtime, {})).toEqual(expect.objectContaining({
      CLAWX_MANAGED_RUNTIME: '1',
      OPENCLAW_DISABLE_NATIVE_HISTORY: '1',
      OPENCLAW_DISABLE_CRON_HISTORY: '1',
      OPENCLAW_SKIP_CRON: '1',
      CLAWX_DISABLE_NATIVE_SCHEDULER: '1',
      OPENCLAW_STATE_DIR: runtime.configRoot,
    }));

    const identity = {
      conversationId: asConversationId('conversation'),
      turnId: asTurnId('turn'),
      runId: asRunId('run'),
      kernelId: 'openclaw' as const,
      generation: 3,
    };
    await driver.execute({ ...identity, context: [], agentId: 'main', workspaceUri: pathToFileURL(join(root, 'workspace # % 中文')).href });
    expect(() => driver.cancel({ ...identity, generation: 2 })).toThrow(/outside this driver generation/);
    await driver.stop();
    expect(hooks).toEqual(['before-start', 'after-start', 'before-stop', 'after-stop']);
    expect(gateway.stop).toHaveBeenCalledOnce();
    clearOpenClawRuntimeLocation();
  });

  it('fails closed when native-history fallback is enabled', async () => {
    const { runtime } = runtimeFixture();
    const driver = new OpenClawKernelDriver({
      generation: 1,
      runtime,
      gateway: { start: async () => undefined, stop: async () => undefined, getStatus: () => ({ state: 'running' }) },
      chat: {
        execute: async input => ({ ...input, acceptedAt: new Date(0).toISOString() }),
        cancel: async () => ({ acknowledged: true }),
        resolvePermission: async () => undefined,
        updateRunConfiguration: async () => undefined,
      },
      control: new FakeKernelDriver('openclaw').control,
    });
    const host = createFakeHost();
    Object.defineProperty(host.store, 'nativeHistoryFallback', { value: true });
    await expect(driver.initialize(host)).rejects.toThrow(/forbids native history fallback/);
    clearOpenClawRuntimeLocation();
  });

  it('detects and purges forbidden history only inside managed roots', async () => {
    const { runtime, root } = runtimeFixture();
    mkdirSync(join(runtime.configRoot, 'agents', 'main', 'sessions'), { recursive: true });
    mkdirSync(join(runtime.configRoot, 'cron', 'runs'), { recursive: true });
    const transcript = join(runtime.configRoot, 'agents', 'main', 'sessions', 'run.jsonl');
    const cronHistory = join(runtime.configRoot, 'cron', 'runs', 'job.jsonl');
    const legacy = join(root, '.openclaw', 'agents', 'main', 'sessions', 'legacy.jsonl');
    mkdirSync(join(root, '.openclaw', 'agents', 'main', 'sessions'), { recursive: true });
    writeFileSync(transcript, '{}');
    writeFileSync(cronHistory, '{}');
    writeFileSync(legacy, '{}');

    expect(await listForbiddenOpenClawHistory(runtime)).toEqual([transcript, cronHistory].sort());
    await purgeForbiddenOpenClawHistory(runtime);
    await expect(assertNoForbiddenOpenClawHistory(runtime)).resolves.toBeUndefined();
    expect(existsSync(legacy)).toBe(true);
  });
});
