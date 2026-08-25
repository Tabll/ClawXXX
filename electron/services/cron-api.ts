import { randomUUID } from 'node:crypto';
import type { CompleteHostServiceRegistry } from '../main/ipc/host-contract';
import type { RemoteDataServiceClient } from '../data/data-service-utility-host';
import type { CanonicalCronJob, CanonicalCronRun, CanonicalSchedule } from '@shared/domains/cron';
import { asAgentId, asCronJobId } from '@shared/domains/identity';
import type { CronJob, CronJobCreateInput, CronJobDelivery, CronSchedule } from '@shared/types/cron';
import { nextScheduleAt, normalizeCanonicalSchedule } from '../scheduler/schedule';

type StoredCronJob = CanonicalCronJob & { nextRunAt?: string };
type CanonicalDataClient = Pick<RemoteDataServiceClient, 'call'>;

const MAX_TIMEOUT_MS = 2_147_000_000;

type ExtendedCreateInput = CronJobCreateInput & {
  kernelId?: string;
  conversationPolicy?: CanonicalCronJob['conversationPolicy'];
  conversationId?: CanonicalCronJob['conversationId'];
  misfirePolicy?: CanonicalCronJob['misfirePolicy'];
  overlapPolicy?: CanonicalCronJob['overlapPolicy'];
  timeoutMs?: number;
};

function requireClient(client?: CanonicalDataClient): CanonicalDataClient {
  if (!client) throw new Error('Canonical Cron DataService is unavailable');
  return client;
}

function uiSchedule(value: CanonicalSchedule): CronSchedule {
  if (value.kind === 'at') return { kind: 'at', at: value.at };
  if (value.kind === 'interval') {
    return {
      kind: 'every',
      everyMs: value.everyMs,
      ...(value.anchorAt ? { anchorMs: Date.parse(value.anchorAt) } : {}),
    };
  }
  return { kind: 'cron', expr: value.expression, tz: value.timezone };
}

function nextJobRun(schedule: CanonicalSchedule, after: Date): string | undefined {
  if (schedule.kind === 'at') return schedule.at;
  return nextScheduleAt(schedule, after)?.toISOString();
}

function canonicalDelivery(value?: CronJobDelivery): CanonicalCronJob['delivery'] {
  if (!value || value.mode === 'none') return undefined;
  if (!value.to?.trim()) throw new Error('Cron delivery target is required');
  return {
    accountId: value.accountId ?? 'default',
    targetId: value.to.trim(),
    mode: value.mode,
    ...(value.channel ? { channel: value.channel } : {}),
  };
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
  label: string,
): T {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`Invalid ${label}: ${String(value)}`);
  }
  return value as T;
}

function normalizedTimeout(value: unknown, fallback: number): number {
  const timeout = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(timeout) || Number(timeout) < 1_000 || Number(timeout) > MAX_TIMEOUT_MS) {
    throw new Error(`Cron timeout must be an integer between 1000 and ${MAX_TIMEOUT_MS} milliseconds`);
  }
  return Number(timeout);
}

function uiDelivery(value?: CanonicalCronJob['delivery']): CronJobDelivery | undefined {
  if (!value) return { mode: 'none' };
  return {
    mode: value.mode ?? 'announce',
    accountId: value.accountId,
    to: value.targetId,
    ...(value.channel ? { channel: value.channel } : {}),
  };
}

function toUiJob(job: StoredCronJob, runs: Array<CanonicalCronRun & { scheduledFor: string }> = []): CronJob {
  const latest = runs[0];
  return {
    id: job.id,
    name: job.name,
    message: job.prompt,
    schedule: uiSchedule(job.schedule),
    delivery: uiDelivery(job.delivery),
    enabled: job.enabled,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    agentId: job.agentId,
    kernelId: job.kernelId,
    conversationPolicy: job.conversationPolicy,
    misfirePolicy: job.misfirePolicy,
    overlapPolicy: job.overlapPolicy,
    timeoutMs: job.timeoutMs,
    ...(job.nextRunAt ? { nextRun: job.nextRunAt } : {}),
    ...(latest ? {
      lastRun: {
        time: latest.completedAt ?? latest.startedAt ?? latest.scheduledFor,
        success: latest.status === 'completed',
        ...(latest.error ? { error: latest.error } : {}),
        ...(latest.startedAt && latest.completedAt
          ? { duration: Math.max(0, Date.parse(latest.completedAt) - Date.parse(latest.startedAt)) }
          : {}),
      },
    } : {}),
  };
}

function jobIdFromSessionKey(value: string): string | null {
  if (value.startsWith('cron:')) return value.slice('cron:'.length).trim() || null;
  const match = value.match(/^agent:[^:]+:cron:([^:]+)(?::run:[^:]+)?$/);
  return match?.[1] ?? null;
}

function eventText(event: { kind: string; payload: unknown }): string | undefined {
  if (typeof event.payload === 'string') return event.payload;
  if (!event.payload || typeof event.payload !== 'object') return undefined;
  const payload = event.payload as Record<string, unknown>;
  for (const key of ['text', 'content', 'message', 'summary']) {
    if (typeof payload[key] === 'string' && payload[key]) return payload[key];
  }
  return undefined;
}

/** Canonical Cron compatibility API. OpenClaw/DSH native schedulers are not queried. */
export function createCronApi(options: {
  dataClient?: CanonicalDataClient;
  trigger?: (job: StoredCronJob) => Promise<void>;
  cancel?: (cronRunId: string) => Promise<boolean>;
  changed?: () => void;
} = {}): CompleteHostServiceRegistry['cron'] {
  return {
    list: async () => {
      const client = requireClient(options.dataClient);
      const jobs = await client.call<StoredCronJob[]>('listCronJobs');
      return Promise.all(jobs.map(async job => toUiJob(
        job,
        await client.call<Array<CanonicalCronRun & { scheduledFor: string }>>('listCronRuns', job.id, 1),
      )));
    },
    create: async payload => {
      const client = requireClient(options.dataClient);
      const input = payload as ExtendedCreateInput;
      const nowDate = new Date();
      const now = nowDate.toISOString();
      const schedule = normalizeCanonicalSchedule(input.schedule, { now: nowDate });
      const delivery = canonicalDelivery(input.delivery);
      const enabled = input.enabled !== false;
      const nextRunAt = enabled ? nextJobRun(schedule, nowDate) : undefined;
      const job: StoredCronJob = {
        id: asCronJobId(randomUUID()),
        name: requiredText(input.name, 'Cron job name'),
        prompt: requiredText(input.message, 'Cron prompt'),
        schedule,
        kernelId: requiredText(input.kernelId ?? 'openclaw', 'Cron kernel'),
        agentId: asAgentId(requiredText(input.agentId ?? 'main', 'Cron agent')),
        conversationPolicy: enumValue(
          input.conversationPolicy,
          ['reuse', 'new-per-run', 'new-per-day'] as const,
          'new-per-run',
          'Cron conversation policy',
        ),
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        ...(delivery ? { delivery } : {}),
        misfirePolicy: enumValue(
          input.misfirePolicy,
          ['skip', 'run-once', 'catch-up'] as const,
          'run-once',
          'Cron misfire policy',
        ),
        overlapPolicy: enumValue(
          input.overlapPolicy,
          ['skip', 'queue', 'replace'] as const,
          'skip',
          'Cron overlap policy',
        ),
        timeoutMs: normalizedTimeout(input.timeoutMs, 30 * 60 * 1_000),
        enabled,
        revision: 1,
        ...(nextRunAt ? { nextRunAt } : {}),
        createdAt: now,
        updatedAt: now,
      };
      await client.call('putCronJob', job);
      options.changed?.();
      return toUiJob(job);
    },
    update: async payload => {
      const client = requireClient(options.dataClient);
      const existing = await client.call<StoredCronJob | undefined>('getCronJob', payload.id);
      if (!existing) throw new Error(`Cron job not found: ${payload.id}`);
      const input = payload.input as Partial<ExtendedCreateInput>;
      const updatedAt = new Date();
      const schedule = input.schedule !== undefined
        ? normalizeCanonicalSchedule(input.schedule, { now: updatedAt })
        : existing.schedule;
      const delivery = input.delivery !== undefined ? canonicalDelivery(input.delivery) : existing.delivery;
      const enabled = typeof input.enabled === 'boolean' ? input.enabled : existing.enabled;
      const nextRunAt = enabled ? nextJobRun(schedule, updatedAt) : undefined;
      const updated: StoredCronJob = {
        ...existing,
        ...(input.name !== undefined ? { name: requiredText(input.name, 'Cron job name') } : {}),
        ...(input.message !== undefined ? { prompt: requiredText(input.message, 'Cron prompt') } : {}),
        schedule,
        ...(input.agentId !== undefined
          ? { agentId: asAgentId(requiredText(input.agentId, 'Cron agent')) }
          : {}),
        ...(input.kernelId !== undefined ? { kernelId: requiredText(input.kernelId, 'Cron kernel') } : {}),
        delivery,
        enabled,
        conversationPolicy: enumValue(
          input.conversationPolicy,
          ['reuse', 'new-per-run', 'new-per-day'] as const,
          existing.conversationPolicy,
          'Cron conversation policy',
        ),
        misfirePolicy: enumValue(
          input.misfirePolicy,
          ['skip', 'run-once', 'catch-up'] as const,
          existing.misfirePolicy,
          'Cron misfire policy',
        ),
        overlapPolicy: enumValue(
          input.overlapPolicy,
          ['skip', 'queue', 'replace'] as const,
          existing.overlapPolicy,
          'Cron overlap policy',
        ),
        timeoutMs: normalizedTimeout(input.timeoutMs, existing.timeoutMs),
        revision: existing.revision + 1,
        nextRunAt,
        updatedAt: updatedAt.toISOString(),
      };
      await client.call('putCronJob', updated);
      options.changed?.();
      return toUiJob(updated);
    },
    delete: async payload => {
      const client = requireClient(options.dataClient);
      const deleted = await client.call<boolean>('deleteCronJob', payload.id);
      if (deleted) options.changed?.();
      return deleted ? { success: true } : { success: false, error: 'Cron job not found' };
    },
    toggle: async payload => {
      const client = requireClient(options.dataClient);
      const existing = await client.call<StoredCronJob | undefined>('getCronJob', payload.id);
      if (!existing) return { success: false, error: 'Cron job not found' };
      const updatedAt = new Date();
      await client.call('putCronJob', {
        ...existing,
        enabled: payload.enabled,
        revision: existing.revision + 1,
        nextRunAt: payload.enabled ? nextJobRun(existing.schedule, updatedAt) : undefined,
        updatedAt: updatedAt.toISOString(),
      });
      options.changed?.();
      return { success: true };
    },
    trigger: async payload => {
      const client = requireClient(options.dataClient);
      const job = await client.call<StoredCronJob | undefined>('getCronJob', payload.id);
      if (!job) return { success: false, error: 'Cron job not found' };
      if (!options.trigger) throw new Error('ClawX Scheduler is unavailable');
      await options.trigger(job);
      return { success: true };
    },
    cancel: async payload => {
      if (!options.cancel) throw new Error('ClawX Scheduler is unavailable');
      const cancelled = await options.cancel(payload.id);
      return cancelled ? { success: true } : { success: false, error: 'Active Cron run not found' };
    },
    sessionHistory: async payload => {
      const client = requireClient(options.dataClient);
      const jobId = jobIdFromSessionKey(payload.sessionKey);
      if (!jobId) return { success: false, error: 'Invalid canonical Cron session key' };
      const runs = await client.call<Array<CanonicalCronRun & { scheduledFor: string }>>(
        'listCronRuns',
        jobId,
        Math.min(Math.max(payload.limit ?? 200, 1), 1_000),
      );
      const messages = await Promise.all(runs.slice().reverse().map(async run => {
        const events = run.runId
          ? await client.call<Array<{ eventSeq: number; kind: string; payload: unknown }>>('listRunEvents', run.runId)
          : [];
        const text = events.slice().reverse().map(eventText).find(Boolean)
          ?? run.error
          ?? `Scheduled task ${run.status}.`;
        return {
          id: run.id,
          role: 'assistant' as const,
          content: text,
          timestamp: Date.parse(run.completedAt ?? run.startedAt ?? run.scheduledFor),
          ...(run.status === 'failed' ? { isError: true } : {}),
        };
      }));
      return { messages };
    },
    deliveryTargets: async () => ({ success: true, targets: [] }),
  };
}
