// @vitest-environment node

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClawXDataService } from '@electron/data/clawx-data-service';
import { assertNoForbiddenOpenClawHistory } from '@electron/kernels/openclaw/managed-history-guard';
import { getManagedOpenClawDataRoots } from '@electron/kernels/openclaw/runtime-location';
import { asConversationId, asRunId, asTurnId } from '@shared/conversations/contracts';
import { asAgentId, asCronJobId } from '@shared/domains/identity';
import { testAgentRouting } from '../../helpers/canonical-agent';

describe('managed OpenClaw runtime directory regression', () => {
  it('keeps prompt/cancel/compact/restart/Cron/Channel durable history in DataService only', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-openclaw-runtime-dir-'));
    const managed = getManagedOpenClawDataRoots(join(root, 'user-data'));
    mkdirSync(managed.configRoot, { recursive: true });
    mkdirSync(managed.cacheRoot, { recursive: true });
    writeFileSync(join(managed.configRoot, 'openclaw.json'), '{"managed":true}');
    mkdirSync(join(managed.configRoot, 'channels', 'fixture'), { recursive: true });
    writeFileSync(join(managed.configRoot, 'channels', 'fixture', 'connection.json'), '{"status":"connected"}');

    const databasePath = join(root, 'user-data', 'state', 'clawx.sqlite');
    let service = new ClawXDataService(databasePath);
    let main = service.connect({ role: 'main' });
    let kernel = service.connect({ role: 'kernel', kernelId: 'openclaw', generation: 1 });
    const conversationId = asConversationId('managed-history');
    await main.createConversation({ id: conversationId, createdAt: '2026-08-23T00:00:00.000Z' });

    const completeRun = async (suffix: string, outcome: 'completed' | 'cancelled') => {
      const runId = asRunId(`run-${suffix}`);
      const userTurnId = asTurnId(`user-${suffix}`);
      await main.admitRun({
        conversationId,
        turnId: userTurnId,
        runId,
        routing: {
          kernelId: 'openclaw', kernelVersion: 'test', generation: 1,
          ...testAgentRouting('openclaw'), contextCompilerVersion: 'v1',
        },
        userBlocks: [{ id: `prompt-${suffix}`, type: 'text', visibility: 'portable', text: suffix }],
        createdAt: `2026-08-23T00:00:0${suffix === 'prompt' ? 1 : 3}.000Z`,
      });
      await kernel.markRunStarted(runId, '2026-08-23T00:00:04.000Z');
      await kernel.putCheckpoint({
        runId,
        codec: 'clawx.openclaw.session-manager/v1',
        schemaVersion: 1,
        checkpoint: { compacted: suffix === 'prompt', entries: [] },
        createdAt: '2026-08-23T00:00:05.000Z',
      });
      await kernel.commitTerminalRun({
        conversationId,
        userTurnId,
        assistantTurnId: asTurnId(`assistant-${suffix}`),
        runId,
        kernelId: 'openclaw',
        generation: 1,
        outcome,
        assistantBlocks: [{ id: `answer-${suffix}`, type: 'text', visibility: 'portable', text: outcome }],
        completedAt: '2026-08-23T00:00:06.000Z',
      });
      await assertNoForbiddenOpenClawHistory(managed);
    };

    await completeRun('prompt', 'completed');
    await completeRun('cancel', 'cancelled');
    await main.putCronJob({
      id: asCronJobId('cron-managed'),
      name: 'Managed',
      prompt: 'scheduled prompt',
      schedule: { kind: 'cron', expression: '0 * * * *', timezone: 'UTC' },
      kernelId: 'openclaw',
      agentId: asAgentId('main'),
      conversationPolicy: 'reuse',
      conversationId,
      misfirePolicy: 'run-once',
      overlapPolicy: 'skip',
      timeoutMs: 30 * 60 * 1_000,
      enabled: true,
      revision: 1,
      createdAt: '2026-08-23T00:00:07.000Z',
      updatedAt: '2026-08-23T00:00:07.000Z',
    });
    const admission = {
      id: 'cron-admission',
      jobId: asCronJobId('cron-managed'),
      scheduledFor: '2026-08-23T01:00:00.000Z',
      triggerKind: 'scheduled' as const,
      snapshot: {
        jobUpdatedAt: '2026-08-23T00:00:07.000Z',
        kernelId: 'openclaw',
        agentId: asAgentId('main'),
        prompt: 'scheduled prompt',
        conversationPolicy: 'reuse' as const,
        conversationId,
        timeoutMs: 30 * 60 * 1_000,
      },
      admittedAt: '2026-08-23T01:00:00.001Z',
    };
    await main.admitCron(admission);
    await main.putCronRun({ id: 'cron-run', admissionId: admission.id, status: 'completed' });
    await assertNoForbiddenOpenClawHistory(managed);

    await service.close();
    service = new ClawXDataService(databasePath);
    main = service.connect({ role: 'main' });
    kernel = service.connect({ role: 'kernel', kernelId: 'openclaw', generation: 1 });
    expect((await main.exportConversation(conversationId)).turns).toHaveLength(4);
    expect(await main.listCronJobs()).toHaveLength(1);
    await assertNoForbiddenOpenClawHistory(managed);
    await service.close();
  });
});
