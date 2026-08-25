// @vitest-environment node

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClawXDataService } from '@electron/data/clawx-data-service';
import { asConversationId, asRunId, asTurnId } from '@shared/conversations/contracts';
import { KERNEL_CONTRACT_PROTOCOL, type KernelEventEnvelopeV1 } from '@shared/kernels/contracts';
import { testAgentRouting } from '../../helpers/canonical-agent';

describe('batched stream, immediate tool/permission commits and usage identity', () => {
  it('commits durable attention events immediately and deduplicates their replay', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-stream-artifacts-'));
    const service = new ClawXDataService(join(root, 'clawx.sqlite'));
    const main = service.connect({ role: 'main' });
    const kernel = service.connect({ role: 'kernel', kernelId: 'deepseek-harness', generation: 1 });
    const conversationId = asConversationId('stream');
    const runId = asRunId('stream-run');
    await main.createConversation({ id: conversationId, createdAt: '2026-08-23T00:00:00.000Z' });
    await main.admitRun({
      conversationId,
      turnId: asTurnId('stream-turn'),
      runId,
      routing: {
        kernelId: 'deepseek-harness', kernelVersion: 'test', generation: 1,
        ...testAgentRouting('deepseek-harness'), contextCompilerVersion: 'test/v1',
      },
      userBlocks: [{ id: 'prompt', type: 'text', visibility: 'portable', text: 'run tool' }],
      createdAt: '2026-08-23T00:00:00.000Z',
    });
    await kernel.markRunStarted(runId, '2026-08-23T00:00:01.000Z');
    const identity = {
      protocol: KERNEL_CONTRACT_PROTOCOL,
      conversationId,
      turnId: asTurnId('stream-turn'),
      runId,
      kernelId: 'deepseek-harness' as const,
      generation: 1,
    };
    const events: KernelEventEnvelopeV1[] = [
      { ...identity, eventSeq: 1, emittedAt: '2026-08-23T00:00:02.000Z', event: {
        kind: 'tool.start', payload: { toolCallId: 'same-id', name: 'read', input: { path: 'a' } },
      } },
      { ...identity, eventSeq: 2, emittedAt: '2026-08-23T00:00:03.000Z', event: {
        kind: 'permission.request', payload: { requestId: 'same-id', kind: 'filesystem', request: { path: 'a' } },
      } },
      { ...identity, eventSeq: 3, emittedAt: '2026-08-23T00:00:04.000Z', event: {
        kind: 'usage', payload: { eventKey: 'provider-request-one', requestId: 'provider-one', inputTokens: 7 },
      } },
      { ...identity, eventSeq: 4, emittedAt: '2026-08-23T00:00:05.000Z', event: {
        kind: 'tool.result', payload: { toolCallId: 'same-id', status: 'completed', output: { text: 'ok' } },
      } },
      { ...identity, eventSeq: 5, emittedAt: '2026-08-23T00:00:06.000Z', event: {
        kind: 'permission.resolved', payload: { requestId: 'same-id', decision: 'allow-once' },
      } },
    ];
    expect(await kernel.appendEvents(events)).toEqual({ inserted: 5, duplicates: 0 });
    expect(await kernel.appendEvents(events)).toEqual({ inserted: 0, duplicates: 5 });
    const artifacts = await main.getRunArtifacts(runId);
    expect(artifacts.tools).toEqual([expect.objectContaining({ nativeCallId: 'same-id', status: 'completed' })]);
    expect(artifacts.permissions).toEqual([expect.objectContaining({ nativeRequestId: 'same-id', decision: 'allow-once' })]);
    expect(artifacts.usage).toEqual([expect.objectContaining({
      eventKey: 'provider-request-one', requestId: 'provider-one', inputTokens: 7, outputTokens: null,
    })]);
    await service.close();
  });

  it('records deterministic context provenance while applying newest-first text budgets', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-context-budget-'));
    const service = new ClawXDataService(join(root, 'clawx.sqlite'));
    const main = service.connect({ role: 'main' });
    const kernel = service.connect({ role: 'kernel', kernelId: 'openclaw', generation: 1 });
    const conversationId = asConversationId('budget');
    await main.createConversation({ id: conversationId, createdAt: '2026-08-23T00:00:00.000Z' });
    await main.admitRun({
      conversationId, turnId: asTurnId('budget-turn-one'), runId: asRunId('budget-run-one'),
      routing: { kernelId: 'openclaw', kernelVersion: 'test', generation: 1, ...testAgentRouting('openclaw'), contextCompilerVersion: 'compiler/v2' },
      userBlocks: [{ id: 'old', type: 'text', visibility: 'portable', text: '1234567890' }],
      createdAt: '2026-08-23T00:00:00.000Z',
    });
    await kernel.commitTerminalRun({
      conversationId, userTurnId: asTurnId('budget-turn-one'), assistantTurnId: asTurnId('budget-answer-one'),
      runId: asRunId('budget-run-one'), kernelId: 'openclaw', generation: 1, outcome: 'completed',
      assistantBlocks: [{ id: 'answer', type: 'text', visibility: 'portable', text: 'abcdefghij' }],
      completedAt: '2026-08-23T00:00:01.000Z',
    });
    await main.admitRun({
      conversationId, turnId: asTurnId('budget-turn-two'), runId: asRunId('budget-run-two'),
      routing: { kernelId: 'openclaw', kernelVersion: 'test', generation: 1, ...testAgentRouting('openclaw'), contextCompilerVersion: 'compiler/v2' },
      userBlocks: [{ id: 'new', type: 'text', visibility: 'portable', text: 'XYZ' }],
      createdAt: '2026-08-23T00:00:02.000Z',
    });
    const first = await kernel.compileContext({
      conversationId, runId: asRunId('budget-run-two'), maxBlocks: 10, maxTextCharacters: 5,
    });
    const second = await kernel.compileContext({
      conversationId, runId: asRunId('budget-run-two'), maxBlocks: 10, maxTextCharacters: 5,
    });
    expect(first.blocks.map(block => [block.id, block.text])).toEqual([
      ['answer', 'ij'],
      ['new', 'XYZ'],
    ]);
    expect(first.omitted.budgetBlocks).toBe(1);
    expect(first.provenance?.contextHash).toBe(second.provenance?.contextHash);
    expect(first.provenance).toEqual(expect.objectContaining({
      redactionPolicyVersion: 'clawx.visibility/v1', maxBlocks: 10, maxTextCharacters: 5,
    }));
    await service.close();
  });
});
