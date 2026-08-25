// @vitest-environment node

import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { KernelSupervisorRegistry } from '@electron/kernels/supervisor-registry';
import { createKernelsApi } from '@electron/services/kernels-api';
import { RuntimeLifecycleCoordinator } from '@electron/kernels/runtime-lifecycle-coordinator';
import { asConversationId, asRunId, asTurnId } from '@shared/conversations/contracts';
import type { KernelStdioEvent } from '@shared/kernels/runtime-protocol';

const fixture = fileURLToPath(new URL('../../fixtures/kernels/stdio-runtime.mjs', import.meta.url));

async function waitFor<T>(
  read: () => T | undefined,
  timeoutMs = 4_000,
): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Condition did not become true within ${timeoutMs} ms`);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

describe('KernelSupervisorRegistry', () => {
  it('keeps PID, generation, live prompt, restart, log, and health state isolated per kernel', async () => {
    const registry = new KernelSupervisorRegistry(kernelId => ({
      command: process.execPath,
      args: [fixture],
      env: kernelId === 'openclaw' ? { CLAWX_FIXTURE_DELAY_MULTIPLIER: '8' } : {},
      startupTimeoutMs: 2_000,
      shutdownTimeoutMs: 500,
    }));
    const events: KernelStdioEvent[] = [];
    registry.on('event', event => events.push(event as KernelStdioEvent));
    try {
      const [openclaw, dsh] = await Promise.all([
        registry.start('openclaw'),
        registry.start('deepseek-harness'),
      ]);
      await registry.request('openclaw', 'fixture.stderr', { message: 'openclaw-only-log' });
      await registry.request(
        'openclaw',
        'session.prompt',
        { text: 'continue while the other runtime restarts' },
        { conversationId: 'c-openclaw', turnId: 't-openclaw', runId: 'r-openclaw' },
      );

      const restarted = await registry.restart('deepseek-harness');
      expect(restarted.generation).toBe(2);
      expect(restarted.pid).not.toBe(dsh.pid);
      expect(registry.status('openclaw')).toMatchObject({
        state: 'ready',
        generation: 1,
        pid: openclaw.pid,
      });
      expect(await registry.request('deepseek-harness', 'runtime.health')).toEqual(
        expect.objectContaining({ ready: true }),
      );

      const terminal = await waitFor(() => events.find(event => (
        event.kernelId === 'openclaw'
        && event.identity.runId === 'r-openclaw'
        && event.event.kind === 'run.terminal'
      )));
      expect(terminal.event.payload).toEqual({ outcome: 'completed' });
      expect(registry.logs('openclaw').some(entry => entry.message.includes('openclaw-only-log'))).toBe(true);
      expect(registry.logs('deepseek-harness').some(entry => entry.message.includes('openclaw-only-log'))).toBe(false);
      expect(registry.logs('deepseek-harness').some(entry => entry.message.includes('generation 2'))).toBe(true);
      expect(registry.diagnostics('openclaw').snapshot.pid).toBe(openclaw.pid);
      expect(registry.diagnostics('deepseek-harness').snapshot.pid).toBe(restarted.pid);
    } finally {
      await registry.stopAll();
    }
  });

  it('persists and exports redacted logs in separate per-kernel directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clawx-kernel-logs-'));
    const registry = new KernelSupervisorRegistry(() => ({ command: process.execPath, args: [fixture] }));
    registry.configureLogRoot(root);
    try {
      await Promise.all([registry.start('openclaw'), registry.start('deepseek-harness')]);
      registry.recordLog(
        'openclaw',
        1,
        'warn',
        'openclaw-private api_key=sk-openclaw1234567890 path=/Users/private/work/project',
      );
      registry.recordLog(
        'deepseek-harness',
        1,
        'info',
        'dsh-private https://example.test/?token=dsh-secret-token',
        { access_token: 'structured-secret-value' },
      );
      await registry.flushLogs();

      const openClawDirectory = registry.logDirectory('openclaw')!;
      const dshDirectory = registry.logDirectory('deepseek-harness')!;
      expect(openClawDirectory).not.toBe(dshDirectory);
      const openClawLog = await readFile(join(openClawDirectory, 'runtime.jsonl'), 'utf8');
      const dshLog = await readFile(join(dshDirectory, 'runtime.jsonl'), 'utf8');
      expect(openClawLog).toContain('openclaw-private');
      expect(openClawLog).not.toContain('sk-openclaw1234567890');
      expect(openClawLog).not.toContain('/Users/private/work/project');
      expect(openClawLog).not.toContain('dsh-private');
      expect(dshLog).toContain('dsh-private');
      expect(dshLog).not.toContain('dsh-secret-token');
      expect(dshLog).not.toContain('structured-secret-value');
      expect(dshLog).toContain('access_token');
      expect(dshLog).toContain('[redacted]');
      expect(dshLog).not.toContain('openclaw-private');
      expect((await stat(join(openClawDirectory, 'runtime.jsonl'))).mode & 0o777).toBe(0o600);

      const exported = registry.exportLogs('openclaw');
      expect(exported.fileName).toBe('clawx-openclaw-logs.jsonl');
      expect(exported.content).toContain('api_key=[redacted]');
      expect(exported.content).not.toContain('sk-openclaw1234567890');
    } finally {
      await registry.stopAll();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('applies restart budgets and rollback suggestions to only the crashing kernel', async () => {
    const registry = new KernelSupervisorRegistry(kernelId => ({
      command: process.execPath,
      args: [fixture],
      env: kernelId === 'deepseek-harness'
        ? { CLAWX_FIXTURE_CRASH_AFTER_READY_MS: '20' }
        : {},
      startupTimeoutMs: 2_000,
      shutdownTimeoutMs: 300,
    }), {
      restartPolicy: {
        maxRestarts: 1,
        windowMs: 2_000,
        baseDelayMs: 10,
        maxDelayMs: 20,
      },
    });
    try {
      await Promise.all([registry.start('openclaw'), registry.start('deepseek-harness')]);
      const crashLoop = await waitFor(() => {
        const snapshot = registry.status('deepseek-harness');
        return snapshot.state === 'crash-loop' ? snapshot : undefined;
      });
      expect(crashLoop).toMatchObject({
        generation: 2,
        restartCount: 2,
        restartBudget: 1,
        rollbackSuggested: {
          reason: 'crash-loop',
          crashCount: 2,
        },
      });
      expect(registry.diagnostics('deepseek-harness').crashes).toHaveLength(2);
      expect(registry.status('openclaw')).toMatchObject({ state: 'ready', generation: 1 });
      await expect(registry.request('openclaw', 'runtime.health')).resolves.toEqual(
        expect.objectContaining({ ready: true }),
      );
      expect(registry.diagnostics('openclaw').crashes).toHaveLength(0);
    } finally {
      await registry.stopAll();
    }
  });

  it('protects the exact immutable version used by a live generation', async () => {
    const registry = new KernelSupervisorRegistry(kernelId => ({
      command: process.execPath,
      args: [fixture],
      artifactVersion: kernelId === 'openclaw' ? 'openclaw-artifact-v7' : 'dsh-artifact-v3',
    }));
    try {
      const snapshot = await registry.start('openclaw');
      expect(snapshot).toMatchObject({
        version: 'openclaw-artifact-v7',
        artifactVersion: 'openclaw-artifact-v7',
      });
      expect(registry.isVersionInUse('openclaw', 'openclaw-artifact-v7')).toBe(true);
      expect(registry.isVersionInUse('openclaw', 'openclaw-artifact-v6')).toBe(false);
      expect(registry.isKernelBusy('openclaw')).toBe(true);
      await registry.stop('openclaw');
      expect(registry.isVersionInUse('openclaw', 'openclaw-artifact-v7')).toBe(false);
      expect(registry.isKernelBusy('openclaw')).toBe(false);
    } finally {
      await registry.stopAll();
    }
  });

  it('kills owned child and grandchild process trees within the quit deadline', async () => {
    const registry = new KernelSupervisorRegistry(() => ({
      command: process.execPath,
      args: [fixture],
      env: { CLAWX_FIXTURE_SPAWN_GRANDCHILD: '1' },
      shutdownTimeoutMs: 300,
    }));
    const root = await registry.start('openclaw');
    const child = await registry.request<{ pid?: number }>('openclaw', 'fixture.grandchild');
    expect(root.pid).toBeTypeOf('number');
    expect(child.pid).toBeTypeOf('number');
    expect(isPidAlive(root.pid!)).toBe(true);
    expect(isPidAlive(child.pid!)).toBe(true);

    await registry.stopAllForQuit(1_500);
    await waitFor(() => !isPidAlive(root.pid!) && !isPidAlive(child.pid!) ? true : undefined);
    expect(registry.status('openclaw').state).toBe('stopped');
  });

  it('exposes lifecycle, logs, diagnostics, policy, and generation checks through the typed Host API', async () => {
    const registry = new KernelSupervisorRegistry(() => ({ command: process.execPath, args: [fixture] }));
    const persistAutoStart = vi.fn(async () => {});
    const api = createKernelsApi({ supervisors: registry, persistAutoStart });
    try {
      const ready = await api.start({ kernelId: 'deepseek-harness' });
      expect(await api.status({ kernelId: 'deepseek-harness' })).toMatchObject({
        state: 'ready',
        generation: ready.generation,
      });
      await api.setAutoStart({ kernelId: 'deepseek-harness', enabled: true });
      expect(persistAutoStart).toHaveBeenCalledWith('deepseek-harness', true);

      const run = {
        conversationId: asConversationId('host-conversation'),
        turnId: asTurnId('host-turn'),
        runId: asRunId('host-run'),
        kernelId: 'deepseek-harness' as const,
        generation: ready.generation,
        context: [],
        agentId: 'default',
        workspaceUri: 'file:///workspace',
      };
      await expect(api.execute(run)).resolves.toMatchObject({
        conversationId: run.conversationId,
        runId: run.runId,
        kernelId: run.kernelId,
        generation: ready.generation,
      });
      await expect(api.execute({ ...run, generation: ready.generation + 1 })).rejects.toThrow('stale');
      expect((await api.logs({ kernelId: 'deepseek-harness', limit: 20 })).length).toBeGreaterThan(0);
      expect(await api.logDirectory({ kernelId: 'deepseek-harness' })).toEqual({ path: undefined });
      expect((await api.exportLogs({ kernelId: 'deepseek-harness' })).entryCount).toBeGreaterThan(0);
      expect((await api.diagnostics({ kernelId: 'deepseek-harness' })).snapshot.state).toBe('ready');
      expect(await api.health({ kernelId: 'deepseek-harness' })).toMatchObject({ state: 'ready' });
      await api.stop({ kernelId: 'deepseek-harness' });
      expect(await api.status({ kernelId: 'deepseek-harness' })).toMatchObject({ state: 'stopped' });
    } finally {
      await registry.stopAll();
    }
  });

  it('coordinates participant auto-start and forces all owned runtimes after a bounded parallel quit', async () => {
    const coordinator = new RuntimeLifecycleCoordinator();
    const calls: string[] = [];
    coordinator.register({
      id: 'openclaw-participant',
      autoStart: async policies => {
        if (policies.openclaw) calls.push('openclaw:start');
      },
      stop: async () => new Promise<void>(() => {}),
      forceTerminate: async () => { calls.push('openclaw:force'); },
    });
    coordinator.register({
      id: 'dsh-participant',
      autoStart: async policies => {
        if (policies['deepseek-harness']) calls.push('dsh:start');
      },
      stop: async () => { calls.push('dsh:stop'); },
      forceTerminate: async () => { calls.push('dsh:force'); },
    });

    await expect(coordinator.autoStart({ openclaw: true, 'deepseek-harness': true })).resolves.toEqual([]);
    await expect(coordinator.stopAllForQuit(20)).resolves.toEqual({ timedOut: true });
    expect(calls).toEqual(expect.arrayContaining([
      'openclaw:start',
      'dsh:start',
      'dsh:stop',
      'openclaw:force',
      'dsh:force',
    ]));
  });
});
