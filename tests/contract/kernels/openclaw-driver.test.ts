// @vitest-environment node

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  OpenClawKernelDriver,
  type OpenClawChatAdapter,
  type OpenClawGatewayAdapter,
} from '@electron/kernels/openclaw/openclaw-driver';
import {
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

function runtimeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'clawx-openclaw-driver-'));
  const packageRoot = join(root, 'kernels');
  const userDataRoot = join(root, 'user-data');
  const artifactVersion = '2026.7.1-2+clawx.test';
  const installRoot = join(packageRoot, 'openclaw', 'installs', artifactVersion);
  const entryPath = join(installRoot, 'runtime', 'kernel', 'clawx-openclaw.mjs');
  const nodePath = join(installRoot, 'runtime', 'node', 'bin', 'node');
  mkdirSync(join(installRoot, 'runtime', 'kernel'), { recursive: true });
  mkdirSync(join(installRoot, 'runtime', 'node', 'bin'), { recursive: true });
  writeFileSync(entryPath, 'export {};');
  writeFileSync(nodePath, 'test');
  const manifest = {
    schemaVersion: 1 as const,
    kernelId: 'openclaw' as const,
    artifactVersion,
    upstreamVersion: '2026.7.1-2',
    patchRevision: 99,
    platform: 'darwin' as const,
    arch: 'arm64' as const,
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
    executablePaths: ['runtime/node/bin/node'],
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
    platform: 'darwin',
  });
  return { root, runtime, userDataRoot };
}

describe('OpenClaw optional runtime driver', () => {
  it('resolves only an active installation record and creates no managed data before start', async () => {
    const { runtime, userDataRoot } = runtimeFixture();
    const roots = getManagedOpenClawDataRoots(userDataRoot);
    expect(runtime.entryPath).toContain('/kernels/openclaw/');
    expect(runtime.entryPath).not.toContain('resources/openclaw');
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
    await driver.execute({ ...identity, context: [], agentId: 'main', workspaceUri: 'file:///workspace' });
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
