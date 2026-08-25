// @vitest-environment node

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClawXDataService, type ClawXDataClient } from '@electron/data/clawx-data-service';
import { createCronApi } from '@electron/services/cron-api';
import { asConversationId } from '@shared/conversations/contracts';
import { asAgentId, asCronJobId } from '@shared/domains/identity';

const services: ClawXDataService[] = [];

afterEach(async () => {
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

function fixture(trigger?: Parameters<typeof createCronApi>[0]['trigger']) {
  const root = mkdtempSync(join(tmpdir(), 'clawx-canonical-cron-'));
  const service = new ClawXDataService(join(root, 'clawx.sqlite'));
  services.push(service);
  const main = service.connect({ role: 'main' });
  return { main, api: createCronApi({ dataClient: remote(main), trigger }) };
}

describe('canonical Cron repository API', () => {
  it('normalizes cron/at/interval schedules and preserves kernel routing', async () => {
    const { api } = fixture();
    const cron = await api.create({
      name: 'Cron',
      message: 'run cron',
      schedule: '0 * * * *',
      kernelId: 'deepseek-harness',
      agentId: 'analyst',
    });
    expect(cron).toMatchObject({
      schedule: { kind: 'cron', expr: '0 * * * *', tz: 'UTC' },
      kernelId: 'deepseek-harness',
      agentId: 'analyst',
      conversationPolicy: 'new-per-run',
    });
    const at = await api.create({
      name: 'Once', message: 'once', schedule: { kind: 'at', at: '2026-08-24T00:00:00Z' },
    });
    expect(at.schedule).toEqual({ kind: 'at', at: '2026-08-24T00:00:00.000Z' });
    const interval = await api.update({
      id: at.id,
      input: { schedule: { kind: 'every', everyMs: 60_000, anchorMs: Date.parse('2026-08-24T00:00:00Z') } },
    });
    expect(interval.schedule).toEqual({
      kind: 'every', everyMs: 60_000, anchorMs: Date.parse('2026-08-24T00:00:00Z'),
    });
  });

  it('persists idempotent admissions/run history in SQLite and never queries runtime history', async () => {
    const { main, api } = fixture();
    const job = await api.create({ name: 'Stored', message: 'do it', schedule: '0 0 * * *' });
    const admission = {
      id: 'admission-one',
      jobId: asCronJobId(job.id),
      scheduledFor: '2026-08-24T00:00:00.000Z',
      triggerKind: 'scheduled' as const,
      snapshot: {
        jobUpdatedAt: job.updatedAt,
        kernelId: job.kernelId,
        agentId: asAgentId(job.agentId),
        prompt: job.message,
        conversationPolicy: job.conversationPolicy,
        conversationId: asConversationId(`cron:${job.id}:reuse`),
        timeoutMs: job.timeoutMs,
      },
      admittedAt: '2026-08-24T00:00:00.010Z',
    };
    expect(await main.admitCron(admission)).toEqual({ inserted: true, admission });
    expect(await main.admitCron({ ...admission, id: 'duplicate' })).toEqual({ inserted: false, admission });
    await main.putCronRun({
      id: 'cron-run-one',
      admissionId: admission.id,
      status: 'failed',
      startedAt: '2026-08-24T00:00:01.000Z',
      completedAt: '2026-08-24T00:00:02.000Z',
      error: 'canonical failure',
    });
    await expect(api.sessionHistory({ sessionKey: `cron:${job.id}` })).resolves.toEqual({
      messages: [{
        id: 'cron-run-one',
        role: 'assistant',
        content: 'canonical failure',
        timestamp: Date.parse('2026-08-24T00:00:02.000Z'),
        isError: true,
      }],
    });
    expect((await api.list())[0]).toMatchObject({
      id: job.id,
      lastRun: { success: false, error: 'canonical failure', duration: 1_000 },
    });
  });

  it('delegates manual trigger to the ClawX Scheduler and fails closed if it is absent', async () => {
    const trigger = vi.fn(async () => undefined);
    const withScheduler = fixture(trigger);
    const job = await withScheduler.api.create({ name: 'Manual', message: 'go', schedule: '0 * * * *' });
    await expect(withScheduler.api.trigger({ id: job.id })).resolves.toEqual({ success: true });
    expect(trigger).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }));

    const withoutScheduler = fixture();
    const unavailable = await withoutScheduler.api.create({ name: 'No scheduler', message: 'go', schedule: '0 * * * *' });
    await expect(withoutScheduler.api.trigger({ id: unavailable.id })).rejects.toThrow(/Scheduler is unavailable/);
  });

  it('rejects invalid canonical schedules, policies, timeouts and delivery targets at the Main boundary', async () => {
    const { api } = fixture();
    const base = { name: 'Validated', message: 'run', schedule: '0 * * * *' };

    await expect(api.create({ ...base, schedule: '0 0 * * * *' })).rejects.toThrow(/exactly five fields/);
    await expect(api.create({
      ...base,
      schedule: { kind: 'cron', expr: '0 * * * *', tz: 'Not/A-Timezone' },
    })).rejects.toThrow(/Invalid IANA timezone/);
    await expect(api.create({ ...base, timeoutMs: 999 })).rejects.toThrow(/Cron timeout/);
    await expect(api.create({
      ...base,
      overlapPolicy: 'parallel' as never,
    })).rejects.toThrow(/Invalid Cron overlap policy/);
    await expect(api.create({
      ...base,
      delivery: { mode: 'announce', channel: 'telegram', accountId: 'telegram:default' },
    })).rejects.toThrow(/delivery target is required/);
  });
});
