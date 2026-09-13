// @vitest-environment node

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClawXDataService, type ClawXDataClient } from '@electron/data/clawx-data-service';
import { createOpenClawGatewayControlPlane } from '@electron/kernels/openclaw/gateway-control-plane';
import {
  ClawXScheduler,
  type SchedulerConversationRouter,
  type StoredCronJob,
} from '@electron/scheduler/clawx-scheduler';
import { asConversationId, asTurnId } from '@shared/conversations/contracts';
import { asAgentId, asCronJobId } from '@shared/domains/identity';
import type { CanonicalCronAdmission, CanonicalCronRun } from '@shared/domains/cron';
import type { KernelId, KernelLifecycleState } from '@shared/kernels/contracts';
import { createContractSignal } from '../../fixtures/kernels/contract-signal';
import { awaitArtifactOperations, createArtifactTestTrace } from '../../fixtures/kernels/artifact-test-support.mjs';

const services: ClawXDataService[] = [];
const schedulers: ClawXScheduler[] = [];
const routers: FakeRouter[] = [];
const signals: Array<{ dispose(): void }> = [];
const ownedRoots: string[] = [];
const traces: ReturnType<typeof createArtifactTestTrace>[] = [];

function traceScenario(name: string) {
  const prefix = process.env.CLAWX_SCHEDULER_CONTRACT_REPORT;
  const trace = createArtifactTestTrace(prefix ? `${prefix}-${name}.json` : undefined);
  traces.push(trace);
  return trace;
}

function signal<T>(label: string) {
  const observer = createContractSignal<T>(label);
  signals.push(observer);
  return observer;
}

afterEach(async ({ task }) => {
  vi.useRealTimers();
  let ok = false;
  try {
    for (const router of routers.splice(0)) for (const kernelId of router.gates.keys()) router.release(kernelId);
    await awaitArtifactOperations(schedulers.splice(0).map(scheduler => scheduler.stop()));
    await awaitArtifactOperations(services.splice(0).map(service => service.close()));
    for (const root of ownedRoots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    ok = task.result?.state !== 'fail';
  } finally {
    for (const observer of signals.splice(0)) observer.dispose();
    for (const trace of traces.splice(0)) trace.stop(ok);
    vi.restoreAllMocks();
  }
});

function remote(client: ClawXDataClient, runs?: ReturnType<typeof createContractSignal<CanonicalCronRun>>) {
  return {
    async call<T>(method: string, ...args: unknown[]): Promise<T> {
      const fn = (client as unknown as Record<string, unknown>)[method];
      if (typeof fn !== 'function') return Promise.reject(new Error(`Unknown method: ${method}`));
      const result = await Reflect.apply(fn, client, args) as T;
      // Publish only after the real SQLite operation has durably completed.
      if (method === 'putCronRun') runs?.publish(structuredClone(args[0] as CanonicalCronRun));
      return result;
    },
  };
}

function fixture(path?: string) {
  if (!path) {
    const root = mkdtempSync(join(tmpdir(), 'clawx-scheduler-'));
    ownedRoots.push(root);
    path = join(root, 'clawx.sqlite');
  }
  const service = new ClawXDataService(path);
  services.push(service);
  const main = service.connect({ role: 'main' });
  const runs = signal<CanonicalCronRun>('durable Cron run');
  return { path, service, main, runs, data: remote(main, runs) };
}

function job(input: Partial<StoredCronJob> & Pick<StoredCronJob, 'id' | 'kernelId'>): StoredCronJob {
  return {
    id: input.id,
    name: input.id,
    prompt: `run ${input.id}`,
    schedule: { kind: 'interval', everyMs: 60_000, anchorAt: '2026-08-24T11:59:00.000Z' },
    kernelId: input.kernelId,
    agentId: asAgentId('main'),
    conversationPolicy: 'reuse',
    misfirePolicy: 'run-once',
    overlapPolicy: 'queue',
    timeoutMs: 60_000,
    enabled: true,
    revision: 1,
    nextRunAt: '2026-08-24T12:00:00.000Z',
    createdAt: '2026-08-24T10:00:00.000Z',
    updatedAt: '2026-08-24T10:00:00.000Z',
    ...input,
  };
}

class FakeRouter implements SchedulerConversationRouter {
  readonly started = signal<Parameters<SchedulerConversationRouter['prompt']>[0]>('Cron router started');
  readonly prompts: Array<Parameters<SchedulerConversationRouter['prompt']>[0]> = [];
  readonly states = new Map<KernelId, KernelLifecycleState>();
  readonly active = new Map<string, ReturnType<SchedulerConversationRouter['activeRun']>>();
  readonly gates = new Map<KernelId, { promise: Promise<void>; resolve: () => void }>();
  beforePrompt?: (input: Parameters<SchedulerConversationRouter['prompt']>[0]) => Promise<void>;
  beforeTerminal?: () => Promise<void>;

  constructor(
    private readonly service: ClawXDataService,
    private readonly main: ClawXDataClient,
  ) { routers.push(this); }

  block(kernelId: KernelId): void {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    this.gates.set(kernelId, { promise, resolve });
  }

  release(kernelId: KernelId): void {
    this.gates.get(kernelId)?.resolve();
  }

  runtimeSnapshot(kernelId: KernelId) {
    return { kernelId, state: this.states.get(kernelId) ?? 'ready', generation: 1 };
  }

  async prompt(input: Parameters<SchedulerConversationRouter['prompt']>[0]) {
    this.prompts.push(input);
    if (!await this.main.getConversation(input.conversationId)) {
      await this.main.createConversation({
        id: input.conversationId,
        title: input.message,
        createdAt: '2026-08-24T12:00:00.000Z',
      });
    }
    await this.main.admitRun({
      conversationId: input.conversationId,
      turnId: input.turnId,
      runId: input.runId,
      routing: {
        kernelId: input.kernelId,
        kernelVersion: 'test',
        generation: 1,
        agentId: asAgentId(input.agentId),
        agentSnapshot: {
          agentId: asAgentId(input.agentId),
          displayName: input.agentId,
          kernelId: input.kernelId,
          workspaceUri: 'file:///',
          canonicalVersion: 1,
        },
        workspaceUri: 'file:///',
        contextCompilerVersion: 'test',
      },
      userBlocks: [{ id: `block:${input.runId}`, type: 'text', visibility: 'portable', text: input.message }],
      createdAt: '2026-08-24T12:00:00.000Z',
    });
    const kernel = this.service.connect({ role: 'kernel', kernelId: input.kernelId, generation: 1 });
    await kernel.markRunStarted(input.runId, '2026-08-24T12:00:00.001Z');
    await this.beforePrompt?.(input);
    const identity = {
      conversationId: input.conversationId,
      turnId: input.turnId,
      runId: input.runId,
      kernelId: input.kernelId,
      generation: 1,
    };
    this.active.set(input.conversationId, identity);
    this.started.publish(input);
    await this.gates.get(input.kernelId)?.promise;
    this.active.delete(input.conversationId);
    await this.beforeTerminal?.();
    await kernel.commitTerminalRun({
      conversationId: input.conversationId,
      userTurnId: input.turnId,
      assistantTurnId: asTurnId(`assistant:${input.runId}`),
      runId: input.runId,
      kernelId: input.kernelId,
      generation: 1,
      outcome: 'completed',
      assistantBlocks: [{
        id: `answer:${input.runId}`,
        type: 'text',
        visibility: 'portable',
        text: 'done',
      }],
      completedAt: '2026-08-24T12:00:00.100Z',
    });
    return { ...identity, acceptedAt: '2026-08-24T12:00:00.000Z' };
  }

  activeRun(conversationId: Parameters<SchedulerConversationRouter['activeRun']>[0]) {
    return this.active.get(conversationId);
  }

  async cancel(input: NonNullable<ReturnType<SchedulerConversationRouter['activeRun']>>) {
    this.release(input.kernelId);
    this.active.delete(input.conversationId);
    return { acknowledged: true };
  }
}

async function waitFor(assertion: () => void | Promise<void>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      last = error;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
  throw last;
}

describe('ClawXScheduler contract', () => {
  it('fails closed instead of projecting canonical jobs into the OpenClaw native scheduler', async () => {
    const rpc = vi.fn(async () => undefined);
    const cron = createOpenClawGatewayControlPlane({ rpc }).cron;
    await expect(cron.list()).resolves.toEqual([]);
    await expect(cron.upsert(job({ id: asCronJobId('native-forbidden'), kernelId: 'openclaw' }), 'operation'))
      .rejects.toThrow(/Main-owned/);
    await expect(cron.remove(asCronJobId('native-forbidden'), 'operation')).rejects.toThrow(/Main-owned/);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('atomically persists immutable admission/run identity and recovers interrupted runs', async () => {
    const { path, service, main } = fixture();
    const stored = job({ id: asCronJobId('atomic'), kernelId: 'openclaw' });
    await main.putCronJob(stored);
    const admission: CanonicalCronAdmission = {
      id: 'admission-atomic',
      jobId: stored.id,
      scheduledFor: '2026-08-24T12:00:00.000Z',
      triggerKind: 'scheduled',
      snapshot: {
        jobUpdatedAt: stored.updatedAt,
        kernelId: stored.kernelId,
        agentId: stored.agentId,
        prompt: stored.prompt,
        conversationPolicy: 'reuse',
        conversationId: asConversationId('cron:atomic:reuse'),
        timeoutMs: stored.timeoutMs,
      },
      admittedAt: '2026-08-24T12:00:00.001Z',
    };
    const run: CanonicalCronRun = {
      id: 'cron-run-atomic',
      admissionId: admission.id,
      status: 'running',
      startedAt: '2026-08-24T12:00:00.002Z',
    };
    expect(await main.admitCronExecution({ admission, run })).toMatchObject({ inserted: true, admission, run });
    const duplicate = await main.admitCronExecution({
      admission: { ...admission, id: 'duplicate', snapshot: { ...admission.snapshot, prompt: 'mutated' } },
      run: { ...run, id: 'duplicate-run', admissionId: 'duplicate' },
    });
    expect(duplicate).toMatchObject({ inserted: false, admission, run });

    services.splice(services.indexOf(service), 1);
    await service.close();
    const reopened = new ClawXDataService(path);
    services.push(reopened);
    const recovered = await reopened.connect({ role: 'main' }).getCronRun(run.id);
    expect(recovered).toMatchObject({
      status: 'failed',
      diagnostic: { code: 'SCHEDULER_RESTARTED', retryable: true },
    });
  });

  it('dispatches simultaneous OpenClaw and DSH jobs only after durable admission and uses shared conversation policies', async () => {
    const { service, main, data } = fixture();
    const openclaw = job({ id: asCronJobId('openclaw-due'), kernelId: 'openclaw' });
    const dsh = job({
      id: asCronJobId('dsh-due'),
      kernelId: 'deepseek-harness',
      conversationPolicy: 'new-per-day',
      delivery: { accountId: 'telegram:default', targetId: 'team' },
    });
    await main.putCronJob(openclaw);
    await main.putCronJob(dsh);
    const router = new FakeRouter(service, main);
    router.beforePrompt = async input => {
      const matching = input.kernelId === 'openclaw'
        ? (await main.listCronRuns(openclaw.id))[0]
        : (await main.listCronRuns(dsh.id))[0];
      expect(matching?.status).toBe('running');
    };
    const deliveries: unknown[] = [];
    const scheduler = new ClawXScheduler(data, router, {
      async deliverScheduledRun(input) {
        deliveries.push(input);
        return undefined;
      },
    }, {
      now: () => new Date('2026-08-24T12:00:00.000Z'),
      ownerId: 'scheduler-a',
    });
    schedulers.push(scheduler);
    await scheduler.start();
    await waitFor(() => expect(router.prompts).toHaveLength(2));
    await waitFor(async () => {
      expect((await main.listCronRuns(openclaw.id))[0]?.status).toBe('completed');
      expect((await main.listCronRuns(dsh.id))[0]?.status).toBe('completed');
    });
    expect(router.prompts.map(prompt => prompt.kernelId).sort()).toEqual(['deepseek-harness', 'openclaw']);
    expect(router.prompts.find(prompt => prompt.kernelId === 'openclaw')?.conversationId)
      .toBe('cron:openclaw-due:reuse');
    expect(router.prompts.find(prompt => prompt.kernelId === 'deepseek-harness')?.conversationId)
      .toBe('cron:dsh-due:day:2026-08-24');
    expect(deliveries).toHaveLength(1);
  });

  it('uses one SQLite leader lease and unique (jobId, scheduledFor) admission across schedulers', async () => {
    const { service, main, data } = fixture();
    const stored = job({ id: asCronJobId('single-leader'), kernelId: 'openclaw' });
    await main.putCronJob(stored);
    const router = new FakeRouter(service, main);
    router.block('openclaw');
    const options = { now: () => new Date('2026-08-24T12:00:00.000Z') };
    const first = new ClawXScheduler(data, router, undefined, { ...options, ownerId: 'leader-one' });
    const second = new ClawXScheduler(data, router, undefined, { ...options, ownerId: 'leader-two' });
    schedulers.push(first, second);
    await first.start();
    await second.start();
    await waitFor(() => expect(router.prompts).toHaveLength(1));
    expect(first.isLeader()).toBe(true);
    expect(second.isLeader()).toBe(false);
    expect(await main.listCronRuns(stored.id)).toHaveLength(1);
    router.release('openclaw');
  });

  it('records missing/updating kernels as diagnostic failures without dispatch', async () => {
    const { service, main, data } = fixture();
    const missing = job({ id: asCronJobId('missing'), kernelId: 'missing-kernel' });
    const updating = job({ id: asCronJobId('updating'), kernelId: 'updating-kernel' });
    await main.putCronJob(missing);
    await main.putCronJob(updating);
    const router = new FakeRouter(service, main);
    router.states.set('missing-kernel', 'not-installed');
    router.states.set('updating-kernel', 'starting');
    const scheduler = new ClawXScheduler(data, router, undefined, {
      now: () => new Date('2026-08-24T12:00:00.000Z'),
      ownerId: 'diagnostics',
    });
    schedulers.push(scheduler);
    await scheduler.start();
    await waitFor(async () => {
      expect((await main.listCronRuns(missing.id))[0]?.diagnostic?.code).toBe('KERNEL_MISSING');
      expect((await main.listCronRuns(updating.id))[0]?.diagnostic?.code).toBe('KERNEL_NOT_READY');
    });
    expect(router.prompts).toHaveLength(0);
  });

  it.each(['openclaw', 'deepseek-harness'] as const)('persists timeout at the exact deadline after real admission (%s)', async kernelId => {
    const trace = traceScenario(`deadline-${kernelId}`);
    trace.phase('sqlite-open');
    const { path, service, main, data, runs } = fixture();
    const stored = job({
      id: asCronJobId('timeout'),
      kernelId,
      nextRunAt: '2026-08-24T13:00:00.000Z',
      timeoutMs: 1_000,
    });
    await main.putCronJob(stored);
    const router = new FakeRouter(service, main);
    router.block(kernelId);
    const cancel = vi.spyOn(router, 'cancel');
    const scheduler = new ClawXScheduler(data, router, undefined, {
      now: () => new Date('2026-08-24T12:00:00.000Z'),
      ownerId: 'timeouts',
    });
    schedulers.push(scheduler);
    // Control timer APIs only. Date, SQLite, FULL fsync, router work and the
    // already-created event observers' two-second wall-clock watchdogs stay real.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await scheduler.start();
    await scheduler.trigger(stored, '2026-08-24T12:00:00.500Z');
    const prompt = await router.started.waitFor();
    const running = await runs.waitFor(run => run.status === 'running');
    trace.phase('router-admitted');
    await vi.advanceTimersByTimeAsync(999);
    expect((await main.getCronRun(running.id))?.status).toBe('running');
    expect(cancel).not.toHaveBeenCalled();
    trace.phase('before-deadline');
    await vi.advanceTimersByTimeAsync(1);
    const terminal = await runs.waitFor(run => run.id === running.id && run.status === 'timed-out');
    trace.phase('terminal-persisted');
    expect(cancel).toHaveBeenCalledExactlyOnceWith({
      conversationId: prompt.conversationId, turnId: prompt.turnId, runId: prompt.runId, kernelId, generation: 1,
    });
    expect(terminal.diagnostic).toMatchObject({ code: 'RUN_TIMEOUT', retryable: true });
    expect(await main.getCronRun(running.id)).toMatchObject({
      id: terminal.id, admissionId: running.admissionId, status: 'timed-out', diagnostic: { code: 'RUN_TIMEOUT' },
    });
    await scheduler.stop();
    await service.close();
    services.splice(services.indexOf(service), 1);
    trace.phase('sqlite-reopen');
    const reopened = fixture(path);
    expect(await reopened.main.getCronRun(running.id)).toMatchObject({
      status: 'timed-out', diagnostic: { code: 'RUN_TIMEOUT', retryable: true },
    });
    trace.phase('durable-readback');
  });

  it.each(['openclaw', 'deepseek-harness'] as const)('persists manual cancellation of the exact admitted run (%s)', async kernelId => {
    const { path, service, main, data, runs } = fixture();
    const stored = job({ id: asCronJobId('manual-cancel'), kernelId, nextRunAt: '2026-08-24T13:00:00.000Z' });
    await main.putCronJob(stored);
    const router = new FakeRouter(service, main);
    router.block(kernelId);
    const cancel = vi.spyOn(router, 'cancel');
    const scheduler = new ClawXScheduler(data, router, undefined, {
      now: () => new Date('2026-08-24T12:00:00.000Z'), ownerId: 'manual-cancel',
    });
    schedulers.push(scheduler);
    await scheduler.start();
    await scheduler.trigger(stored, '2026-08-24T12:00:00.500Z');
    const prompt = await router.started.waitFor();
    const active = await runs.waitFor(run => run.status === 'running');
    await expect(scheduler.cancel(active.id)).resolves.toBe(true);
    expect(cancel).toHaveBeenCalledExactlyOnceWith({
      conversationId: prompt.conversationId, turnId: prompt.turnId, runId: prompt.runId, kernelId, generation: 1,
    });
    expect(await main.getCronRun(active.id)).toMatchObject({
      status: 'cancelled', diagnostic: { code: 'RUN_CANCELLED' },
    });
    await scheduler.stop();
    await service.close();
    services.splice(services.indexOf(service), 1);
    expect(await fixture(path).main.getCronRun(active.id)).toMatchObject({
      status: 'cancelled', diagnostic: { code: 'RUN_CANCELLED' },
    });
  });

  it.each(['openclaw', 'deepseek-harness'] as const)('drains delayed terminal persistence before recording a timeout (%s)', async kernelId => {
    const trace = traceScenario(`terminal-drain-${kernelId}`);
    const { service, main, data, runs } = fixture();
    const stored = job({ id: asCronJobId('drain'), kernelId, nextRunAt: '2026-08-24T13:00:00.000Z', timeoutMs: 1_000 });
    await main.putCronJob(stored);
    const router = new FakeRouter(service, main);
    router.block(kernelId);
    const terminalEntered = signal<void>('terminal persistence entered');
    let releaseTerminal!: () => void;
    const terminalGate = new Promise<void>(resolve => { releaseTerminal = resolve; });
    router.beforeTerminal = () => { terminalEntered.publish(); return terminalGate; };
    const scheduler = new ClawXScheduler(data, router, undefined, {
      now: () => new Date('2026-08-24T12:00:00.000Z'), ownerId: 'terminal-drain',
    });
    schedulers.push(scheduler);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await scheduler.start();
      await scheduler.trigger(stored, '2026-08-24T12:00:00.500Z');
      await router.started.waitFor();
      const running = await runs.waitFor(run => run.status === 'running');
      trace.phase('router-admitted');
      await vi.advanceTimersByTimeAsync(1_000);
      await terminalEntered.waitFor();
      trace.phase('terminal-write-held');
      // Model a slow terminal operation explicitly. Elapsed scheduler time is
      // not proof that canonical terminal state or Cron state has committed.
      await vi.advanceTimersByTimeAsync(2_000);
      expect((await main.getCronRun(running.id))?.status).toBe('running');
      releaseTerminal();
      await runs.waitFor(run => run.id === running.id && run.status === 'timed-out');
      expect(await main.getCronRun(running.id)).toMatchObject({
        status: 'timed-out', diagnostic: { code: 'RUN_TIMEOUT' },
      });
      trace.phase('terminal-persisted');
    } finally {
      releaseTerminal();
    }
  });

  it.each(['skip', 'replace'] as const)('enforces %s overlap without dispatching parallel turns for one job', async policy => {
    const test = fixture();
    const kernelId = policy === 'skip' ? 'openclaw' : 'deepseek-harness';
    const stored = job({
      id: asCronJobId(`overlap-${policy}`),
      kernelId,
      overlapPolicy: policy,
      nextRunAt: '2026-08-24T13:00:00.000Z',
    });
    await test.main.putCronJob(stored);
    const router = new FakeRouter(test.service, test.main);
    router.block(kernelId);
    const scheduler = new ClawXScheduler(test.data, router, undefined, {
      now: () => new Date('2026-08-24T12:00:00.000Z'),
      ownerId: `overlap-${policy}`,
    });
    schedulers.push(scheduler);
    await scheduler.start();
    await scheduler.trigger(stored, '2026-08-24T12:00:00.100Z');
    const first = await router.started.waitFor();
    expect(router.prompts).toHaveLength(1);
    await scheduler.trigger(stored, '2026-08-24T12:00:00.200Z');
    if (policy === 'skip') {
      expect((await test.main.listCronRuns(stored.id)).some(
        run => run.status === 'missed' && run.diagnostic?.code === 'OVERLAP_SKIPPED',
      )).toBe(true);
      expect(router.prompts).toHaveLength(1);
      router.release(kernelId);
    } else {
      await router.started.waitFor(input => input.runId !== first.runId);
      expect(router.prompts).toHaveLength(2);
      await test.runs.waitFor(run => run.status === 'cancelled');
    }
    await test.runs.waitFor(run => run.status === 'completed');
    const runs = await test.main.listCronRuns(stored.id);
    expect(runs).toHaveLength(2);
    expect(runs.filter(run => run.status === 'completed')).toHaveLength(1);
    expect(runs.filter(run => run.status === (policy === 'skip' ? 'missed' : 'cancelled'))).toHaveLength(1);
  });

  it('creates a distinct canonical Conversation for every new-per-run admission', async () => {
    const { service, main, data } = fixture();
    const stored = job({
      id: asCronJobId('new-per-run'),
      kernelId: 'openclaw',
      conversationPolicy: 'new-per-run',
      nextRunAt: '2026-08-24T13:00:00.000Z',
    });
    await main.putCronJob(stored);
    const router = new FakeRouter(service, main);
    const scheduler = new ClawXScheduler(data, router, undefined, {
      now: () => new Date('2026-08-24T12:00:00.000Z'),
      ownerId: 'new-per-run',
    });
    schedulers.push(scheduler);
    await scheduler.start();
    await scheduler.trigger(stored, '2026-08-24T12:00:00.100Z');
    await scheduler.trigger(stored, '2026-08-24T12:00:00.200Z');
    await waitFor(() => expect(router.prompts).toHaveLength(2));
    expect(new Set(router.prompts.map(prompt => prompt.conversationId)).size).toBe(2);
    expect(router.prompts.every(prompt => prompt.conversationId.startsWith('cron:new-per-run:run:'))).toBe(true);
  });

  it('applies restart misfire policy and never replays the same due instants into second runs', async () => {
    const initial = fixture();
    const stored = job({
      id: asCronJobId('restart-misfire'),
      kernelId: 'openclaw',
      misfirePolicy: 'run-once',
      schedule: { kind: 'interval', everyMs: 60_000, anchorAt: '2026-08-24T11:58:00.000Z' },
      nextRunAt: '2026-08-24T11:58:00.000Z',
    });
    await initial.main.putCronJob(stored);
    services.splice(services.indexOf(initial.service), 1);
    await initial.service.close();

    const reopened = new ClawXDataService(initial.path);
    services.push(reopened);
    const main = reopened.connect({ role: 'main' });
    const router = new FakeRouter(reopened, main);
    const persistedRuns = signal<CanonicalCronRun>('reopened durable Cron run');
    const first = new ClawXScheduler(remote(main, persistedRuns), router, undefined, {
      now: () => new Date('2026-08-24T12:00:00.000Z'),
      ownerId: 'restart-first',
    });
    schedulers.push(first);
    await first.start();
    await persistedRuns.waitFor(run => run.status === 'completed');
    const runs = await main.listCronRuns(stored.id);
    expect(runs).toHaveLength(3);
    expect(runs.filter(run => run.status === 'completed')).toHaveLength(1);
    expect(runs.filter(run => run.status === 'missed')).toHaveLength(2);
    expect(router.prompts).toHaveLength(1);
    await first.stop();

    const persisted = (await main.getCronJob(stored.id))!;
    await main.putCronJob({
      ...persisted,
      nextRunAt: '2026-08-24T11:58:00.000Z',
      updatedAt: '2026-08-24T12:00:01.000Z',
    });
    const second = new ClawXScheduler(remote(main), router, undefined, {
      now: () => new Date('2026-08-24T12:00:00.000Z'),
      ownerId: 'restart-second',
    });
    schedulers.push(second);
    await second.start();
    await second.tickNow();
    expect(await main.listCronRuns(stored.id)).toHaveLength(3);
    expect(router.prompts).toHaveLength(1);
  });

  it('applies bounded catch-up and records skipped misfires durably', async () => {
    const { service, main, data } = fixture();
    const catchUp = job({
      id: asCronJobId('catch-up'),
      kernelId: 'openclaw',
      misfirePolicy: 'catch-up',
      schedule: { kind: 'interval', everyMs: 60_000, anchorAt: '2026-08-24T11:57:00.000Z' },
      nextRunAt: '2026-08-24T11:57:00.000Z',
    });
    const skipped = job({
      id: asCronJobId('skip-misfire'),
      kernelId: 'deepseek-harness',
      misfirePolicy: 'skip',
      schedule: { kind: 'interval', everyMs: 60_000, anchorAt: '2026-08-24T11:58:00.000Z' },
      nextRunAt: '2026-08-24T11:58:00.000Z',
    });
    await main.putCronJob(catchUp);
    await main.putCronJob(skipped);
    const router = new FakeRouter(service, main);
    const scheduler = new ClawXScheduler(data, router, undefined, {
      now: () => new Date('2026-08-24T12:00:00.000Z'),
      ownerId: 'misfires',
      catchUpLimit: 10,
    });
    schedulers.push(scheduler);
    await scheduler.start();
    await waitFor(async () => expect((await main.listCronRuns(catchUp.id))).toHaveLength(4));
    await waitFor(async () => {
      expect((await main.listCronRuns(catchUp.id)).every(run => run.status === 'completed')).toBe(true);
    });
    expect((await main.listCronRuns(skipped.id))).toHaveLength(3);
    expect((await main.listCronRuns(skipped.id)).every(run => run.status === 'missed')).toBe(true);
    expect(router.prompts.filter(prompt => prompt.kernelId === 'deepseek-harness')).toHaveLength(0);
  });
});
