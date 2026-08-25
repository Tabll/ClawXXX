// @vitest-environment node

import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClawXDataService } from '@electron/data/clawx-data-service';
import {
  UsageAdapterRegistry,
  deepSeekHarnessUsageAdapter,
  openClawUsageAdapter,
} from '@electron/domains/usage/usage-adapters';
import { createUsageApi } from '@electron/services/usage-api';
import { asConversationId, asRunId, asTurnId } from '@shared/conversations/contracts';
import type { KernelEventEnvelopeV1 } from '@shared/kernels/contracts';
import { testAgentRouting } from '../../helpers/canonical-agent';

const at = (second: number) => new Date(Date.UTC(2026, 7, 24, 0, 0, second)).toISOString();

describe('canonical Usage adapters and repository', () => {
  it('normalizes OpenClaw live provider usage without inventing unknown token fields', () => {
    const normalized = openClawUsageAdapter.normalize({
      sessionUpdate: 'usage_update',
      used: 17,
      size: 17,
      _meta: {
        clawx: {
          input_tokens: 12,
          output_tokens: 5,
          requestId: 'provider-request-1',
          cost: { amount: 0.0025, currency: 'USD' },
        },
      },
    }, {
      kernelId: 'openclaw',
      runId: asRunId('run-openclaw'),
      eventSeq: 4,
      providerId: 'openai-primary',
      modelId: 'gpt-5',
    });

    expect(normalized).toEqual({
      eventKey: 'provider-request-1',
      source: 'provider-response',
      providerId: 'openai-primary',
      modelId: 'gpt-5',
      requestId: 'provider-request-1',
      inputTokens: 12,
      outputTokens: 5,
      cost: 0.0025,
      currency: 'USD',
    });
    expect(normalized).not.toHaveProperty('cacheReadTokens');
    expect(normalized).not.toHaveProperty('cacheWriteTokens');
    expect(normalized).not.toHaveProperty('totalTokens');
  });

  it('normalizes DSH SessionEvent token meters and provides an extensible fallback adapter', () => {
    const dsh = deepSeekHarnessUsageAdapter.normalize({
      eventKey: 'dsh-usage-2-3',
      inputTokens: 7,
      outputTokens: 4,
      source: 'runtime-event',
    }, {
      kernelId: 'deepseek-harness',
      runId: asRunId('run-dsh'),
      eventSeq: 9,
    });
    expect(dsh).toMatchObject({ eventKey: 'dsh-usage-2-3', inputTokens: 7, outputTokens: 4 });
    expect(dsh).not.toHaveProperty('cacheReadTokens');

    const fallback = new UsageAdapterRegistry([]).normalize({ totalTokens: 3 }, {
      kernelId: 'future-kernel',
      runId: asRunId('run-future'),
      eventSeq: 1,
    });
    expect(fallback).toMatchObject({
      eventKey: 'future-kernel:run-future:1',
      totalTokens: 3,
      source: 'runtime-event',
    });
  });

  it('deduplicates provider retries/multi-delivery and never adds a terminal double charge', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-usage-contract-'));
    const service = new ClawXDataService(join(root, 'clawx.sqlite'));
    const main = service.connect({ role: 'main' });
    const kernel = service.connect({ role: 'kernel', kernelId: 'openclaw', generation: 1 });
    const conversationId = asConversationId('usage-conversation');
    const turnId = asTurnId('usage-turn');
    const runId = asRunId('usage-run');
    try {
      await main.createConversation({ id: conversationId, createdAt: at(0) });
      await main.admitRun({
        conversationId,
        turnId,
        runId,
        routing: {
          kernelId: 'openclaw',
          kernelVersion: '2026.7.1-2+clawx.6',
          generation: 1,
          ...testAgentRouting('openclaw', { providerId: 'openai-primary', modelId: 'gpt-5' }),
          contextCompilerVersion: 'clawx.portable-context/v1',
        },
        userBlocks: [{ id: 'usage-user', type: 'text', visibility: 'portable', text: 'measure this' }],
        createdAt: at(1),
      });
      await kernel.markRunStarted(runId, at(2));
      const usageEvent = (
        eventSeq: number,
        eventKey: string,
        inputTokens: number,
        outputTokens: number,
      ): KernelEventEnvelopeV1 => ({
        protocol: 'clawx.kernel/v1',
        conversationId,
        turnId,
        runId,
        kernelId: 'openclaw',
        generation: 1,
        eventSeq,
        emittedAt: at(eventSeq + 2),
        nativeEventId: `retry-delivery-${eventSeq}`,
        event: {
          kind: 'usage',
          payload: {
            eventKey,
            requestId: eventKey,
            inputTokens,
            outputTokens,
            source: 'provider-response',
          },
        },
      });
      await kernel.appendEvents([
        usageEvent(1, 'provider-request-stable', 10, 2),
        usageEvent(2, 'provider-request-stable', 10, 2),
        usageEvent(3, 'provider-request-second', 5, 1),
      ]);
      await kernel.commitTerminalRun({
        conversationId,
        userTurnId: turnId,
        assistantTurnId: asTurnId('usage-assistant'),
        runId,
        kernelId: 'openclaw',
        generation: 1,
        outcome: 'completed',
        assistantBlocks: [{ id: 'usage-answer', type: 'text', visibility: 'portable', text: 'done' }],
        usage: { inputTokens: 10, outputTokens: 2, source: 'provider-response' },
        completedAt: at(9),
      });

      const rows = await main.listUsage({ from: at(0), to: at(20) });
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        eventKey: 'provider-request-stable',
        requestId: 'provider-request-stable',
        kernelId: 'openclaw',
        agentId: 'main',
        inputTokens: 10,
        outputTokens: 2,
        source: 'provider-response',
      });
      expect(rows[1]).toMatchObject({
        eventKey: 'provider-request-second',
        requestId: 'provider-request-second',
        inputTokens: 5,
        outputTokens: 1,
      });
      expect(rows.reduce((sum, row) => sum + Number(row.inputTokens ?? 0), 0)).toBe(15);
    } finally {
      await service.close();
    }
  });

  it('maps SQLite rows to the Dashboard without converting missing values to zero', async () => {
    const call = async () => [{
      id: 'usage-unknown',
      eventKey: 'unknown-call',
      runId: 'run-unknown',
      kernelId: 'deepseek-harness',
      conversationId: 'conversation-unknown',
      agentId: 'main',
      source: 'runtime-event',
      recordedAt: at(1),
    }];
    const api = createUsageApi({ dataClient: { call } as never });
    const [entry] = await api.query({ from: at(0), to: at(2) });
    expect(entry).toMatchObject({
      kernelId: 'deepseek-harness',
      usageStatus: 'missing',
      source: 'runtime-event',
    });
    expect(entry).not.toHaveProperty('inputTokens');
    expect(entry).not.toHaveProperty('outputTokens');
    expect(entry).not.toHaveProperty('totalTokens');
    expect(entry).not.toHaveProperty('costUsd');
  });

  it('has no transcript/runtime-directory Usage fallback and carries the reviewed OpenClaw live patch', () => {
    const repositoryRoot = process.cwd();
    for (const legacyPath of [
      'electron/utils/token-usage.ts',
      'electron/utils/token-usage-core.ts',
    ]) {
      expect(existsSync(join(repositoryRoot, legacyPath))).toBe(false);
    }
    const apiSource = readFileSync(join(repositoryRoot, 'electron/services/usage-api.ts'), 'utf8');
    expect(apiSource).toContain("call<Array<Record<string, unknown>>>('listUsage'");
    expect(apiSource).not.toMatch(/node:fs|sessions\.json|\.jsonl|OPENCLAW_STATE_DIR|DSH_HOME/);

    const openClawPatch = readFileSync(
      join(repositoryRoot, 'patches/openclaw@2026.7.1-2.patch'),
      'utf8',
    );
    expect(openClawPatch).toContain('buildLiveUsageUpdate');
    expect(openClawPatch).toContain('source: "provider-response"');
  });
});
