import { randomUUID } from 'node:crypto';
import type {
  ConversationId,
  RunId,
  TurnId,
} from '@shared/conversations/contracts';
import { asConversationId, asRunId, asTurnId } from '@shared/conversations/contracts';
import type {
  CanonicalCronAdmission,
  CanonicalCronJob,
  CanonicalCronRun,
  CronTriggerKind,
} from '@shared/domains/cron';
import type { KernelRuntimeSnapshot } from '@shared/kernels/contracts';
import {
  calendarDayAt,
  enumerateDueScheduleTimes,
  nextScheduleAt,
  scheduleTimezone,
} from './schedule';

export type StoredCronJob = CanonicalCronJob & { nextRunAt?: string };

export type SchedulerDataClient = {
  call<T = unknown>(method: string, ...args: unknown[]): Promise<T>;
};

export type SchedulerConversationRouter = {
  prompt(input: {
    conversationId: ConversationId;
    turnId: TurnId;
    runId: RunId;
    kernelId: CanonicalCronJob['kernelId'];
    agentId: string;
    workspaceUri: string;
    permissionMode: 'deny';
    message: string;
  }): Promise<{
    conversationId: ConversationId;
    turnId: TurnId;
    runId: RunId;
    kernelId: CanonicalCronJob['kernelId'];
    generation: number;
    acceptedAt: string;
  }>;
  activeRun(conversationId: ConversationId): {
    conversationId: ConversationId;
    turnId: TurnId;
    runId: RunId;
    kernelId: CanonicalCronJob['kernelId'];
    generation: number;
  } | undefined;
  cancel(input: {
    conversationId: ConversationId;
    turnId: TurnId;
    runId: RunId;
    kernelId: CanonicalCronJob['kernelId'];
    generation: number;
  }): Promise<{ acknowledged: boolean }>;
  runtimeSnapshot(kernelId: CanonicalCronJob['kernelId']): KernelRuntimeSnapshot;
};

export type SchedulerChannelDelivery = {
  deliverScheduledRun(input: {
    jobId: string;
    admissionId: string;
    scheduledFor: string;
    delivery: NonNullable<CanonicalCronJob['delivery']>;
    conversationId: ConversationId;
    runId: RunId;
    turnId: TurnId;
  }): Promise<string | undefined>;
};

export type ClawXSchedulerOptions = {
  now?: () => Date;
  id?: () => string;
  ownerId?: string;
  leaseDurationMs?: number;
  leaseRenewMs?: number;
  catchUpLimit?: number;
  maxTimerMs?: number;
};

type Execution = {
  jobId: string;
  cronRunId: string;
  conversationId: ConversationId;
  admitted: AdmittedExecution;
  startedAt: string;
  promise: Promise<void>;
  cancelRequested: boolean;
  dispatched: boolean;
  settled: boolean;
};

type AdmittedExecution = {
  job: StoredCronJob;
  admission: CanonicalCronAdmission;
  run: CanonicalCronRun;
  conversationId: ConversationId;
  turnId: TurnId;
  runId: RunId;
};

const LEASE_NAME = 'clawx-scheduler' as const;

/**
 * Main-owned durable scheduler. Kernel schedulers are deliberately outside
 * this path: every due turn is admitted to ClawX SQLite before dispatch.
 */
export class ClawXScheduler {
  private readonly ownerId: string;
  private wakeTimer?: ReturnType<typeof setTimeout>;
  private leaseTimer?: ReturnType<typeof setTimeout>;
  private tickPromise?: Promise<void>;
  private leader = false;
  private stopped = true;
  private manualCursor = 0;
  private readonly activeByJob = new Map<string, Execution>();
  private readonly activeByRun = new Map<string, Execution>();
  private readonly jobTails = new Map<string, Promise<void>>();

  constructor(
    private readonly data: SchedulerDataClient,
    private readonly router: SchedulerConversationRouter,
    private readonly channels?: SchedulerChannelDelivery,
    private readonly options: ClawXSchedulerOptions = {},
  ) {
    this.ownerId = options.ownerId ?? randomUUID();
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    await this.acquireLeadership();
    this.armLeaseRenewal();
    if (this.leader) await this.tickNow();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.clearTimers();
    const activeRunIds = [...this.activeByRun.keys()];
    await Promise.allSettled(activeRunIds.map(cronRunId => this.cancel(cronRunId)));
    await Promise.allSettled([...this.jobTails.values()]);
    if (this.leader) {
      await this.data.call('releaseSchedulerLease', { name: LEASE_NAME, ownerId: this.ownerId })
        .catch(() => false);
    }
    this.leader = false;
  }

  /** Wake after a canonical job mutation without coupling the API to timers. */
  notifyChanged(): void {
    if (!this.stopped && this.leader) this.armWake(this.now());
  }

  /** Deterministic entry point used by the timer and contract tests. */
  async tickNow(): Promise<void> {
    if (this.stopped || !this.leader) return;
    if (this.tickPromise) return this.tickPromise;
    this.tickPromise = this.reconcileDueJobs().finally(() => {
      this.tickPromise = undefined;
    });
    return this.tickPromise;
  }

  async trigger(job: StoredCronJob, scheduledFor?: string): Promise<void> {
    if (this.stopped) throw new Error('ClawXScheduler is stopped');
    if (!this.leader) throw new Error('ClawXScheduler is not the leader');
    const instant = scheduledFor ?? this.nextManualInstant();
    await this.admitAndQueue(job, instant, 'manual');
  }

  async cancel(cronRunId: string): Promise<boolean> {
    const active = this.activeByRun.get(cronRunId);
    if (!active) return false;
    await this.cancelExecution(active);
    await this.data.call('putCronRun', {
      ...active.admitted.run,
      status: 'cancelled',
      startedAt: active.startedAt,
      completedAt: this.now().toISOString(),
      diagnostic: {
        code: 'RUN_CANCELLED',
        message: 'Scheduled turn was cancelled by the user',
        retryable: false,
      },
    });
    return true;
  }

  isLeader(): boolean {
    return this.leader;
  }

  private async acquireLeadership(): Promise<void> {
    if (this.stopped) return;
    const now = this.now();
    const leaseExpiresAt = new Date(now.getTime() + this.leaseDurationMs()).toISOString();
    const result = await this.data.call<{ acquired: boolean }>('acquireSchedulerLease', {
      name: LEASE_NAME,
      ownerId: this.ownerId,
      leaseExpiresAt,
      updatedAt: now.toISOString(),
      now: now.toISOString(),
    });
    this.leader = result.acquired;
  }

  private armLeaseRenewal(): void {
    if (this.stopped) return;
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    this.leaseTimer = setTimeout(() => {
      void this.renewOrAcquire().finally(() => this.armLeaseRenewal());
    }, this.leaseRenewMs());
    this.leaseTimer.unref?.();
  }

  private async renewOrAcquire(): Promise<void> {
    if (this.stopped) return;
    const now = this.now();
    if (this.leader) {
      this.leader = await this.data.call<boolean>('renewSchedulerLease', {
        name: LEASE_NAME,
        ownerId: this.ownerId,
        leaseExpiresAt: new Date(now.getTime() + this.leaseDurationMs()).toISOString(),
        updatedAt: now.toISOString(),
        now: now.toISOString(),
      }).catch(() => false);
    } else {
      await this.acquireLeadership().catch(() => undefined);
    }
    if (this.leader) await this.tickNow();
    else if (this.wakeTimer) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = undefined;
    }
  }

  private async reconcileDueJobs(): Promise<void> {
    const jobs = await this.data.call<StoredCronJob[]>('listCronJobs');
    const horizon = this.now();
    for (const job of jobs) {
      if (!job.enabled) continue;
      let next = job.nextRunAt ? new Date(job.nextRunAt) : undefined;
      if (!next || !Number.isFinite(next.getTime())) {
        next = nextScheduleAt(job.schedule, horizon);
        await this.persistNextRun(job, next);
        continue;
      }
      if (next.getTime() > horizon.getTime()) continue;
      const due = enumerateDueScheduleTimes(job.schedule, next, horizon, this.catchUpLimit());
      const selected = this.selectMisfires(job, due);
      for (const skipped of selected.skipped) {
        await this.admitMissed(job, skipped.toISOString(), due.length > 1 ? 'misfire' : 'scheduled', 'MISFIRE_SKIPPED');
      }
      for (const instant of selected.execute) {
        await this.admitAndQueue(
          job,
          instant.toISOString(),
          due.length > 1 || instant.getTime() < horizon.getTime() ? 'misfire' : 'scheduled',
        );
      }
      const afterBatch = due.length >= this.catchUpLimit()
        ? nextScheduleAt(job.schedule, due.at(-1)!)
        : undefined;
      const following = afterBatch && afterBatch.getTime() <= horizon.getTime()
        ? afterBatch
        : nextScheduleAt(job.schedule, horizon);
      await this.persistNextRun(job, following);
    }
    await this.armNextFromStore();
  }

  private selectMisfires(job: StoredCronJob, due: Date[]): { execute: Date[]; skipped: Date[] } {
    if (due.length === 0) return { execute: [], skipped: [] };
    if (job.misfirePolicy === 'catch-up') return { execute: due, skipped: [] };
    if (job.misfirePolicy === 'skip') return { execute: [], skipped: due };
    return { execute: [due.at(-1)!], skipped: due.slice(0, -1) };
  }

  private async persistNextRun(job: StoredCronJob, next: Date | undefined): Promise<void> {
    await this.data.call('putCronJob', {
      ...job,
      enabled: job.schedule.kind === 'at' && !next ? false : job.enabled,
      nextRunAt: next?.toISOString(),
      updatedAt: this.now().toISOString(),
    });
  }

  private async armNextFromStore(): Promise<void> {
    if (this.stopped || !this.leader) return;
    const jobs = await this.data.call<StoredCronJob[]>('listCronJobs');
    const next = jobs
      .filter(job => job.enabled && job.nextRunAt)
      .map(job => new Date(job.nextRunAt!))
      .filter(date => Number.isFinite(date.getTime()))
      .sort((left, right) => left.getTime() - right.getTime())[0];
    if (next) this.armWake(next);
    else if (this.wakeTimer) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = undefined;
    }
  }

  private armWake(at: Date): void {
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    const delay = Math.max(0, Math.min(at.getTime() - this.now().getTime(), this.maxTimerMs()));
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined;
      void this.tickNow().catch(() => {
        if (!this.stopped && this.leader) {
          this.armWake(new Date(this.now().getTime() + this.leaseRenewMs()));
        }
      });
    }, delay);
    this.wakeTimer.unref?.();
  }

  private async admitAndQueue(job: StoredCronJob, scheduledFor: string, triggerKind: CronTriggerKind): Promise<void> {
    const admitted = await this.admit(job, scheduledFor, triggerKind, 'admitted');
    if (!admitted) return;
    const existing = this.activeByJob.get(job.id);
    const queued = this.jobTails.has(job.id);
    if (job.overlapPolicy === 'skip' && (existing || queued)) {
      await this.finishRun(admitted, 'missed', {
        code: 'OVERLAP_SKIPPED',
        message: 'A previous execution of this job is still active',
        retryable: false,
      });
      return;
    }
    if (job.overlapPolicy === 'replace' && existing) await this.cancelExecution(existing);
    const previous = this.jobTails.get(job.id) ?? Promise.resolve();
    const execution = previous.catch(() => undefined).then(() => this.execute(admitted));
    const tail = execution.then(() => undefined, () => undefined);
    this.jobTails.set(job.id, tail);
    void tail.finally(() => {
      if (this.jobTails.get(job.id) === tail) this.jobTails.delete(job.id);
    });
  }

  private async admitMissed(
    job: StoredCronJob,
    scheduledFor: string,
    triggerKind: CronTriggerKind,
    code: string,
  ): Promise<void> {
    const admitted = await this.admit(job, scheduledFor, triggerKind, 'missed');
    if (!admitted) return;
    await this.finishRun(admitted, 'missed', {
      code,
      message: 'The scheduled instant was skipped by policy',
      retryable: false,
    });
  }

  private async admit(
    job: StoredCronJob,
    scheduledFor: string,
    triggerKind: CronTriggerKind,
    status: CanonicalCronRun['status'],
  ): Promise<AdmittedExecution | undefined> {
    const admissionId = this.id();
    const cronRunId = this.id();
    const runId = asRunId(this.id());
    const turnId = asTurnId(this.id());
    const conversationId = conversationIdFor(job, scheduledFor, admissionId);
    const now = this.now().toISOString();
    const admission: CanonicalCronAdmission = {
      id: admissionId,
      jobId: job.id,
      scheduledFor,
      triggerKind,
      snapshot: {
        jobUpdatedAt: job.updatedAt,
        kernelId: job.kernelId,
        agentId: job.agentId,
        prompt: job.prompt,
        conversationPolicy: job.conversationPolicy,
        conversationId,
        ...(job.delivery ? { delivery: job.delivery } : {}),
        timeoutMs: job.timeoutMs,
      },
      admittedAt: now,
    };
    const run: CanonicalCronRun = {
      id: cronRunId,
      admissionId,
      status,
    };
    const result = await this.data.call<{ inserted: boolean }>('admitCronExecution', { admission, run });
    if (!result.inserted) return undefined;
    return { job, admission, run, conversationId, turnId, runId };
  }

  private async execute(input: AdmittedExecution): Promise<void> {
    if (this.stopped) {
      await this.finishRun(input, 'cancelled', {
        code: 'SCHEDULER_STOPPED',
        message: 'ClawXScheduler stopped before kernel dispatch',
        retryable: true,
      });
      return;
    }
    const runtime = this.router.runtimeSnapshot(input.job.kernelId);
    if (runtime.state !== 'ready') {
      const missing = runtime.state === 'not-installed' || runtime.state === 'incompatible';
      await this.finishRun(input, 'failed', {
        code: missing ? 'KERNEL_MISSING' : 'KERNEL_NOT_READY',
        message: `Kernel ${input.job.kernelId} is ${runtime.state}`,
        retryable: !missing,
      });
      return;
    }
    const startedAt = this.now().toISOString();
    const active: Execution = {
      jobId: input.job.id,
      cronRunId: input.run.id,
      conversationId: input.conversationId,
      admitted: input,
      startedAt,
      promise: Promise.resolve(),
      cancelRequested: false,
      dispatched: false,
      settled: false,
    };
    this.activeByJob.set(input.job.id, active);
    this.activeByRun.set(input.run.id, active);
    await this.data.call('putCronRun', { ...input.run, status: 'running', startedAt });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      if (active.cancelRequested) {
        await this.finishRun(input, 'cancelled', {
          code: 'RUN_CANCELLED',
          message: 'Scheduled turn was cancelled before kernel dispatch',
          retryable: false,
        }, startedAt);
        return;
      }
      const prompt = this.router.prompt({
        conversationId: input.conversationId,
        turnId: input.turnId,
        runId: input.runId,
        kernelId: input.job.kernelId,
        agentId: input.job.agentId,
        workspaceUri: 'file:///',
        permissionMode: 'deny',
        message: input.admission.snapshot.prompt,
      });
      active.dispatched = true;
      active.promise = prompt.then(() => undefined, () => undefined).finally(() => {
        active.settled = true;
      });
      const outcome = await Promise.race([
        prompt.then(acceptance => ({ kind: 'completed' as const, acceptance })),
        new Promise<{ kind: 'timeout' }>(resolve => {
          timeout = setTimeout(() => resolve({ kind: 'timeout' }), input.admission.snapshot.timeoutMs);
          timeout.unref?.();
        }),
      ]);
      if (outcome.kind === 'timeout') {
        await this.cancelExecution(active);
        await prompt.catch(() => undefined);
        await this.finishRun(input, 'timed-out', {
          code: 'RUN_TIMEOUT',
          message: `Scheduled turn exceeded ${input.admission.snapshot.timeoutMs}ms`,
          retryable: true,
        });
        return;
      }
      let deliveryMessageId: string | undefined;
      if (input.admission.snapshot.delivery) {
        if (!this.channels) throw new Error('Channel Orchestrator is unavailable');
        deliveryMessageId = await this.channels.deliverScheduledRun({
          jobId: input.job.id,
          admissionId: input.admission.id,
          scheduledFor: input.admission.scheduledFor,
          delivery: input.admission.snapshot.delivery,
          conversationId: input.conversationId,
          runId: input.runId,
          turnId: outcome.acceptance.turnId,
        });
      }
      await this.data.call('putCronRun', {
        ...input.run,
        runId: input.runId,
        status: active.cancelRequested ? 'cancelled' : 'completed',
        startedAt,
        completedAt: this.now().toISOString(),
        ...(deliveryMessageId ? { deliveryMessageId } : {}),
      });
    } catch (error) {
      await this.finishRun(input, active.cancelRequested ? 'cancelled' : 'failed', {
        code: active.cancelRequested ? 'RUN_CANCELLED' : 'RUN_FAILED',
        message: safeError(error),
        retryable: !active.cancelRequested,
      }, startedAt);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (this.activeByJob.get(input.job.id) === active) this.activeByJob.delete(input.job.id);
      this.activeByRun.delete(input.run.id);
    }
  }

  private async cancelExecution(execution: Execution): Promise<void> {
    execution.cancelRequested = true;
    for (let attempt = 0; attempt < 100 && !execution.settled; attempt += 1) {
      const identity = this.router.activeRun(execution.conversationId);
      if (identity) {
        await this.router.cancel(identity).catch(() => ({ acknowledged: false }));
        break;
      }
      if (!execution.dispatched) await Promise.resolve();
      else await new Promise(resolve => setTimeout(resolve, 5));
    }
    await execution.promise;
  }

  private async finishRun(
    input: AdmittedExecution,
    status: CanonicalCronRun['status'],
    diagnostic: NonNullable<CanonicalCronRun['diagnostic']>,
    startedAt?: string,
  ): Promise<void> {
    await this.data.call('putCronRun', {
      ...input.run,
      status,
      ...(startedAt ? { startedAt } : {}),
      completedAt: this.now().toISOString(),
      ...(status === 'failed' || status === 'timed-out' ? { error: diagnostic.message } : {}),
      diagnostic,
    });
  }

  private nextManualInstant(): string {
    const now = this.now().getTime();
    this.manualCursor = Math.max(now, this.manualCursor + 1);
    return new Date(this.manualCursor).toISOString();
  }

  private clearTimers(): void {
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    this.wakeTimer = undefined;
    this.leaseTimer = undefined;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private id(): string {
    return this.options.id?.() ?? randomUUID();
  }

  private leaseDurationMs(): number {
    return Math.max(this.options.leaseDurationMs ?? 30_000, 3_000);
  }

  private leaseRenewMs(): number {
    return Math.max(this.options.leaseRenewMs ?? 10_000, 1_000);
  }

  private catchUpLimit(): number {
    return Math.min(Math.max(this.options.catchUpLimit ?? 100, 1), 10_000);
  }

  private maxTimerMs(): number {
    return Math.min(Math.max(this.options.maxTimerMs ?? 2_147_000_000, 1_000), 2_147_000_000);
  }
}

function conversationIdFor(job: StoredCronJob, scheduledFor: string, admissionId: string): ConversationId {
  if (job.conversationPolicy === 'reuse') {
    return job.conversationId ?? asConversationId(`cron:${job.id}:reuse`);
  }
  if (job.conversationPolicy === 'new-per-day') {
    const day = calendarDayAt(new Date(scheduledFor), scheduleTimezone(job.schedule));
    return asConversationId(`cron:${job.id}:day:${day}`);
  }
  return asConversationId(`cron:${job.id}:run:${admissionId}`);
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/((?:token|secret|password|authorization)\s*[=:]\s*)\S+/gi, '$1[redacted]')
    .slice(0, 500);
}
