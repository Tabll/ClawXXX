// @vitest-environment node

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClawXDataService } from '@electron/data/clawx-data-service';
import {
  asConversationId,
  asRunId,
  asTurnId,
  type AdmitRunInput,
  type CanonicalContentBlock,
} from '@shared/conversations/contracts';
import { KERNEL_CONTRACT_PROTOCOL, type KernelEventEnvelopeV1 } from '@shared/kernels/contracts';
import { testAgentRouting } from '../../helpers/canonical-agent';

const at = (offset: number) => new Date(Date.UTC(2026, 7, 23, 12, 0, offset)).toISOString();

function admission(input: {
  conversation: string;
  turn: string;
  run: string;
  kernelId: 'openclaw' | 'deepseek-harness';
  generation?: number;
  blocks: CanonicalContentBlock[];
}): AdmitRunInput {
  return {
    conversationId: asConversationId(input.conversation),
    turnId: asTurnId(input.turn),
    runId: asRunId(input.run),
    routing: {
      kernelId: input.kernelId,
      kernelVersion: input.kernelId === 'openclaw' ? '2026.7.1-2' : '0.1.1-rc.2',
      generation: input.generation ?? 1,
      ...testAgentRouting(input.kernelId, { providerId: 'fake', modelId: 'fake-model' }),
      contextCompilerVersion: '1.0.0',
    },
    userBlocks: input.blocks,
    createdAt: at(1),
  };
}

function event(input: {
  conversation: string;
  turn: string;
  run: string;
  kernelId: 'openclaw' | 'deepseek-harness';
  seq: number;
  text: string;
}): KernelEventEnvelopeV1<{ text: string }> {
  return {
    protocol: KERNEL_CONTRACT_PROTOCOL,
    conversationId: input.conversation,
    turnId: input.turn,
    runId: input.run,
    kernelId: input.kernelId,
    generation: 1,
    eventSeq: input.seq,
    emittedAt: at(input.seq + 1),
    nativeEventId: `native-${input.kernelId}-${input.seq}`,
    event: { kind: 'assistant.delta', payload: { text: input.text } },
  };
}

describe('single-owner multi-kernel DataService spike', () => {
  it('serializes interleaved kernels, deduplicates events, and preserves run identity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-data-spike-'));
    const service = new ClawXDataService(join(root, 'clawx.sqlite'));
    const main = service.connect({ role: 'main' });
    const openclaw = service.connect({ role: 'kernel', kernelId: 'openclaw', generation: 1 });
    const dsh = service.connect({ role: 'kernel', kernelId: 'deepseek-harness', generation: 1 });

    await Promise.all([
      main.createConversation({ id: asConversationId('conversation-a'), title: 'A', createdAt: at(0) }),
      main.createConversation({ id: asConversationId('conversation-b'), title: 'B', createdAt: at(0) }),
    ]);
    await Promise.all([
      main.admitRun(admission({
        conversation: 'conversation-a', turn: 'turn-a1', run: 'run-a1', kernelId: 'openclaw',
        blocks: [{ id: 'block-a1', type: 'text', visibility: 'portable', text: 'hello openclaw' }],
      })),
      main.admitRun(admission({
        conversation: 'conversation-b', turn: 'turn-b1', run: 'run-b1', kernelId: 'deepseek-harness',
        blocks: [{ id: 'block-b1', type: 'text', visibility: 'portable', text: 'hello dsh' }],
      })),
    ]);
    await Promise.all([
      openclaw.markRunStarted(asRunId('run-a1'), at(2)),
      dsh.markRunStarted(asRunId('run-b1'), at(2)),
    ]);
    const openclawEvent = event({
      conversation: 'conversation-a', turn: 'turn-a1', run: 'run-a1', kernelId: 'openclaw', seq: 1, text: 'A',
    });
    const dshEvent = event({
      conversation: 'conversation-b', turn: 'turn-b1', run: 'run-b1', kernelId: 'deepseek-harness', seq: 1, text: 'B',
    });
    const [aWrite, bWrite] = await Promise.all([
      openclaw.appendEvents([openclawEvent]),
      dsh.appendEvents([dshEvent]),
    ]);
    expect(aWrite).toEqual({ inserted: 1, duplicates: 0 });
    expect(bWrite).toEqual({ inserted: 1, duplicates: 0 });
    expect(await openclaw.appendEvents([openclawEvent])).toEqual({ inserted: 0, duplicates: 1 });
    await expect(dsh.appendEvents([openclawEvent])).rejects.toThrow(/authenticated kernel generation scope/);
    expect(await main.listRunEvents(asRunId('run-a1'))).toEqual([
      { eventSeq: 1, kind: 'assistant.delta', payload: { text: 'A' } },
    ]);
    expect(await main.integrityCheck()).toBe('ok');
    await service.close();
  });

  it('continues one conversation across kernels without leaking private, secret, or other-kernel blocks', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-context-spike-'));
    const service = new ClawXDataService(join(root, 'clawx.sqlite'));
    const main = service.connect({ role: 'main' });
    const openclaw = service.connect({ role: 'kernel', kernelId: 'openclaw', generation: 1 });
    const dsh = service.connect({ role: 'kernel', kernelId: 'deepseek-harness', generation: 1 });
    const conversationId = asConversationId('cross-kernel');
    await main.createConversation({ id: conversationId, title: 'Cross kernel', createdAt: at(0) });
    await main.admitRun(admission({
      conversation: conversationId,
      turn: 'turn-1',
      run: 'run-1',
      kernelId: 'openclaw',
      blocks: [
        { id: 'portable-user', type: 'text', visibility: 'portable', text: 'portable question' },
        { id: 'secret-user', type: 'metadata', visibility: 'secret', json: { credentialRef: 'keychain://never-copy' } },
      ],
    }));
    await openclaw.markRunStarted(asRunId('run-1'), at(2));
    await openclaw.commitTerminalRun({
      conversationId,
      userTurnId: asTurnId('turn-1'),
      assistantTurnId: asTurnId('turn-2'),
      runId: asRunId('run-1'),
      kernelId: 'openclaw',
      generation: 1,
      outcome: 'completed',
      assistantBlocks: [
        { id: 'portable-answer', type: 'text', visibility: 'portable', text: 'portable answer' },
        { id: 'private-reasoning', type: 'metadata', visibility: 'private', json: { thought: 'hidden' } },
        { id: 'openclaw-only', type: 'metadata', visibility: 'kernel', kernelId: 'openclaw', json: { cache: 1 } },
        { id: 'revoked-file', type: 'resource-link', visibility: 'portable', revoked: true, json: { path: '/tmp/no' } },
      ],
      usage: { inputTokens: 10, outputTokens: 5 },
      completedAt: at(3),
    });
    await main.admitRun(admission({
      conversation: conversationId,
      turn: 'turn-3',
      run: 'run-2',
      kernelId: 'deepseek-harness',
      blocks: [{ id: 'next-question', type: 'text', visibility: 'portable', text: 'continue in DSH' }],
    }));
    const context = await dsh.compileContext({ conversationId, runId: asRunId('run-2') });
    expect(context.blocks.map((block) => block.id)).toEqual([
      'portable-user',
      'portable-answer',
      'next-question',
    ]);
    expect(context.omitted).toEqual({
      privateBlocks: 1,
      secretBlocks: 1,
      otherKernelBlocks: 1,
      revokedBlocks: 1,
      budgetBlocks: 0,
    });
    expect(JSON.stringify(context)).not.toContain('never-copy');
    expect(JSON.stringify(context)).not.toContain('hidden');

    await dsh.markRunStarted(asRunId('run-2'), at(4));
    await dsh.commitTerminalRun({
      conversationId,
      userTurnId: asTurnId('turn-3'),
      assistantTurnId: asTurnId('turn-4'),
      runId: asRunId('run-2'),
      kernelId: 'deepseek-harness',
      generation: 1,
      outcome: 'completed',
      assistantBlocks: [
        { id: 'dsh-portable-answer', type: 'text', visibility: 'portable', text: 'portable DSH answer' },
        { id: 'dsh-private-reasoning', type: 'metadata', visibility: 'private', json: { thought: 'dsh-hidden' } },
        { id: 'dsh-only', type: 'metadata', visibility: 'kernel', kernelId: 'deepseek-harness', json: { cache: 2 } },
      ],
      completedAt: at(5),
    });
    await main.admitRun(admission({
      conversation: conversationId,
      turn: 'turn-5',
      run: 'run-3',
      kernelId: 'openclaw',
      blocks: [{ id: 'return-question', type: 'text', visibility: 'portable', text: 'continue in OpenClaw' }],
    }));
    const returnContext = await openclaw.compileContext({ conversationId, runId: asRunId('run-3') });
    expect(returnContext.blocks.map(block => block.id)).toEqual([
      'portable-user',
      'portable-answer',
      'openclaw-only',
      'next-question',
      'dsh-portable-answer',
      'return-question',
    ]);
    expect(JSON.stringify(returnContext)).not.toContain('dsh-hidden');
    expect(JSON.stringify(returnContext)).not.toContain('dsh-only');
    await service.close();
  });

  it('recovers admitted work as interrupted, restores a consistent backup, and fails closed on write faults', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-recovery-spike-'));
    const databasePath = join(root, 'clawx.sqlite');
    const backupPath = join(root, 'backups', 'snapshot.sqlite');
    let service = new ClawXDataService(databasePath);
    let main = service.connect({ role: 'main' });
    await main.createConversation({ id: asConversationId('recovery'), createdAt: at(0) });
    await main.admitRun(admission({
      conversation: 'recovery', turn: 'recovery-turn', run: 'recovery-run', kernelId: 'openclaw',
      blocks: [{ id: 'recovery-block', type: 'text', visibility: 'portable', text: 'persist me' }],
    }));
    await main.backupTo(backupPath);
    await service.close();

    service = new ClawXDataService(databasePath);
    main = service.connect({ role: 'main' });
    expect(await main.getConversation(asConversationId('recovery'))).toEqual(expect.objectContaining({ id: 'recovery' }));
    expect(await main.integrityCheck()).toBe('ok');
    await service.close();

    const restored = new ClawXDataService(backupPath);
    const restoredMain = restored.connect({ role: 'main' });
    expect(await restoredMain.getConversation(asConversationId('recovery'))).toBeDefined();
    expect(await restoredMain.integrityCheck()).toBe('ok');
    await restored.close();

    let failWrites = true;
    const failed = new ClawXDataService(join(root, 'full.sqlite'), {
      beforeWrite(operation) {
        if (failWrites && operation === 'run.admit') {
          const error = new Error('database or disk is full') as Error & { code?: string };
          error.code = 'SQLITE_FULL';
          throw error;
        }
      },
    });
    const failedMain = failed.connect({ role: 'main' });
    await failedMain.createConversation({ id: asConversationId('fail-closed'), createdAt: at(0) });
    await expect(failedMain.admitRun(admission({
      conversation: 'fail-closed', turn: 'fail-turn', run: 'fail-run', kernelId: 'openclaw',
      blocks: [{ id: 'fail-block', type: 'text', visibility: 'portable', text: 'must not dispatch' }],
    }))).rejects.toMatchObject({ code: 'SQLITE_FULL' });
    failWrites = false;
    expect(readFileSync(join(root, 'full.sqlite')).byteLength).toBeGreaterThan(0);
    await failed.close();
  });
});
