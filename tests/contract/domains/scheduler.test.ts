// @vitest-environment node

import { mkdtempSync } from 'node:fs';
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

const services: ClawXDataService[] = [];
const schedulers: ClawXScheduler[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.allSettled(schedulers.splice(0).map(scheduler => scheduler.stop()));
  await Promise.all(services.splice(0).map(service => service.close()));
});

function remote(client: ClawXDataClient) {
  return {
    call<T>(method: string, ...args: unknown[]): Promise<T> {
      const fn = (client as unknown as Record<string, unknown>)[method];
      if (typeof fn !== 'function') return Promise.reject(new Error(`Unknown method: ${method}`));
      return Reflect.apply(fn, client, args) as Promise<T>;
    },
  };
}

function fixture(path = join(mkdtempSync(join(tmpdir(), 'clawx-scheduler-')), 'clawx.sqlite')) {
  const service = new ClawXDataService(path);
  services.push(service);
  const main = service.connect({ role: 'main' });
  return { path, service, main, data: remote(main) };
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
  readonly prompts: Array<Parameters<SchedulerConversationRouter['prompt']>[0]> = [];
  readonly states = new Map<KernelId, KernelLifecycleState>();
  readonly active = new Map<string, ReturnType<SchedulerConversationRouter['activeRun']>>();
  readonly gates = new Map<KernelId, { promise: Promise<void>; resolve: () => void }>();
  beforePrompt?: (input: Parameters<SchedulerConversationRouter['prompt']>[0]) => Promise<void>;

  constructor(
    private readonly service: ClawXDataService,
    private readonly main: ClawXDataClient,
  ) {}

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
    await this.gates.get(input.kernelId)?.promise;
    this.active.delete(input.conversationId);
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

async function waitForMicrotasks(assertion: () => void | Promise<void>, attempts = 200): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await assertion();
      return;
    } catch (error) {
      last = error;
      await Promise.resolve();
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

  it('supports manual cancellation and writes timeout diagnostics', async () => {
    const { service, main, data } = fixture();
    const stored = job({
      id: asCronJobId('timeout'),
      kernelId: 'openclaw',
      nextRunAt: '2026-08-24T13:00:00.000Z',
      timeoutMs: 1_000,
    });
    await main.putCronJob(stored);
    const router = new FakeRouter(service, main);
    router.block('openclaw');
    const scheduler = new ClawXScheduler(data, router, undefined, {
      now: () => new Date('2026-08-24T12:00:00.000Z'),
      ownerId: 'timeouts',
    });
    schedulers.push(scheduler);
    await scheduler.start();
    await scheduler.trigger(stored, '2026-08-24T12:00:00.500Z');
    await waitForMicrotasks(() => expect(router.prompts).toHaveLength(1));
    await waitFor(async () => {
      const runs = await main.listCronRuns(stored.id);
      expect(runs[0]?.status).toBe('timed-out');
      expect(runs[0]?.diagnostic?.code).toBe('RUN_TIMEOUT');
    }, 2_000);

    router.block('openclaw');
    await scheduler.trigger(stored, '2026-08-24T12:00:02.000Z');
    await waitFor(async () => expect((await main.listCronRuns(stored.id))[0]?.status).toBe('running'));
    const active = (await main.listCronRuns(stored.id))[0]!;
    await expect(scheduler.cancel(active.id)).resolves.toBe(true);
    expect((await main.listCronRuns(stored.id)).some(run => run.id === active.id && run.status === 'cancelled'))
      .toBe(true);
  });

  it('enforces skip and replace overlap policies without dispatching parallel turns for one job', async () => {
    const skipFixture = fixture();
    const skipJob = job({
      id: asCronJobId('overlap-skip'),
      kernelId: 'openclaw',
      overlapPolicy: 'skip',
      nextRunAt: '2026-08-24T13:00:00.000Z',
    });
    await skipFixture.main.putCronJob(skipJob);
    const skipRouter = new FakeRouter(skipFixture.service, skipFixture.main);
    skipRouter.block('openclaw');
    const skipScheduler = new ClawXScheduler(skipFixture.data, skipRouter, undefined, {
      now: () => new Date('2026-08-24T12:00:00.000Z'),
      ownerId: 'overlap-skip',
    });
    schedulers.push(skipScheduler);
    await skipScheduler.start();
    await skipScheduler.trigger(skipJob, '2026-08-24T12:00:00.100Z');
    await waitFor(() => expect(skipRouter.prompts).toHaveLength(1));
    await skipScheduler.trigger(skipJob, '2026-08-24T12:00:00.200Z');
    await waitFor(async () => {
      expect((await skipFixture.main.listCronRuns(skipJob.id)).some(
        run => run.status === 'missed' && run.diagnostic?.code === 'OVERLAP_SKIPPED',
      )).toBe(true);
    });
    expect(skipRouter.prompts).toHaveLength(1);
    skipRouter.release('openclaw');
    await waitFor(async () => {
      expect((await skipFixture.main.listCronRuns(skipJob.id)).some(run => run.status === 'completed')).toBe(true);
    });

    const replaceFixture = fixture();
    const replaceJob = job({
      id: asCronJobId('overlap-replace'),
      kernelId: 'deepseek-harness',
      overlapPolicy: 'replace',
      nextRunAt: '2026-08-24T13:00:00.000Z',
    });
    await replaceFixture.main.putCronJob(replaceJob);
    const replaceRouter = new FakeRouter(replaceFixture.service, replaceFixture.main);
    replaceRouter.block('deepseek-harness');
    const replaceScheduler = new ClawXScheduler(replaceFixture.data, replaceRouter, undefined, {
      now: () => new Date('2026-08-24T12:00:00.000Z'),
      ownerId: 'overlap-replace',
    });
    schedulers.push(replaceScheduler);
    await replaceScheduler.start();
    await replaceScheduler.trigger(replaceJob, '2026-08-24T12:00:00.100Z');
    await waitFor(() => expect(replaceRouter.prompts).toHaveLength(1));
    await replaceScheduler.trigger(replaceJob, '2026-08-24T12:00:00.200Z');
    await waitFor(() => expect(replaceRouter.prompts).toHaveLength(2));
    await waitFor(async () => {
      const runs = await replaceFixture.main.listCronRuns(replaceJob.id);
      expect(runs.some(run => run.status === 'cancelled')).toBe(true);
      expect(runs.some(run => run.status === 'completed')).toBe(true);
    });
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
    const first = new ClawXScheduler(remote(main), router, undefined, {
      now: () => new Date('2026-08-24T12:00:00.000Z'),
      ownerId: 'restart-first',
    });
    schedulers.push(first);
    await first.start();
    await waitFor(async () => {
      const runs = await main.listCronRuns(stored.id);
      expect(runs).toHaveLength(3);
      expect(runs.filter(run => run.status === 'completed')).toHaveLength(1);
      expect(runs.filter(run => run.status === 'missed')).toHaveLength(2);
    });
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
