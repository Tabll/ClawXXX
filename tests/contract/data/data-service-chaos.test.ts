// @vitest-environment node

import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { ClawXDataService } from '@electron/data/clawx-data-service';
import { asConversationId, asRunId, asTurnId } from '@shared/conversations/contracts';
import { KERNEL_CONTRACT_PROTOCOL } from '@shared/kernels/contracts';
import { testAgentRouting } from '../../helpers/canonical-agent';

function admission(conversation: string, turn: string, run: string) {
  return {
    conversationId: asConversationId(conversation),
    turnId: asTurnId(turn),
    runId: asRunId(run),
    routing: {
      kernelId: 'openclaw' as const,
      kernelVersion: 'test',
      generation: 1,
      ...testAgentRouting('openclaw'),
      contextCompilerVersion: 'test/v1',
    },
    userBlocks: [{ id: `block-${run}`, type: 'text' as const, visibility: 'portable' as const, text: run }],
    createdAt: '2026-08-23T00:00:00.000Z',
  };
}

describe('DataService fail-closed and recovery contracts', () => {
  it('enforces one active run, recovers partial streams as interrupted, and isolates checkpoint codecs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-data-chaos-'));
    const path = join(root, 'state', 'clawx.sqlite');
    let service = new ClawXDataService(path);
    let main = service.connect({ role: 'main' });
    let kernel = service.connect({ role: 'kernel', kernelId: 'openclaw', generation: 1 });
    await main.createConversation({ id: asConversationId('chaos'), createdAt: '2026-08-23T00:00:00.000Z' });
    await main.admitRun(admission('chaos', 'turn-one', 'run-one'));
    await expect(main.admitRun(admission('chaos', 'turn-two', 'run-two'))).rejects.toThrow(/UNIQUE constraint failed/);
    await kernel.markRunStarted(asRunId('run-one'), '2026-08-23T00:00:01.000Z');
    await kernel.appendEvents([{
      protocol: KERNEL_CONTRACT_PROTOCOL,
      conversationId: 'chaos', turnId: 'turn-one', runId: 'run-one', kernelId: 'openclaw', generation: 1,
      eventSeq: 1, emittedAt: '2026-08-23T00:00:02.000Z', event: { kind: 'assistant.delta', payload: { text: 'partial' } },
    }]);
    await kernel.putCheckpoint({
      runId: asRunId('run-one'), codec: 'openclaw/v1', schemaVersion: 1,
      checkpoint: { native: true }, createdAt: '2026-08-23T00:00:02.000Z',
    });
    expect(await kernel.getCheckpoint({ runId: asRunId('run-one'), codec: 'openclaw/v1', schemaVersion: 2 })).toBeUndefined();
    await service.close();

    service = new ClawXDataService(path);
    main = service.connect({ role: 'main' });
    kernel = service.connect({ role: 'kernel', kernelId: 'openclaw', generation: 2 });
    const exported = await main.exportConversation(asConversationId('chaos'));
    expect(exported.runs).toEqual([expect.objectContaining({ id: 'run-one', status: 'interrupted' })]);
    await expect(kernel.getCheckpoint({ runId: asRunId('run-one'), codec: 'openclaw/v1', schemaVersion: 1 }))
      .resolves.toEqual({ native: true });
    await service.close();
  });

  it('preserves independent projection failures and rejects a future schema without mutation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-schema-chaos-'));
    const service = new ClawXDataService(join(root, 'state', 'clawx.sqlite'));
    const main = service.connect({ role: 'main' });
    await main.upsertProjection({
      entityType: 'agent', entityId: 'shared', kernelId: 'openclaw', desiredVersion: 2,
      appliedVersion: 2, status: 'ready', nativeId: 'same-native-id', updatedAt: '2026-08-23T00:00:00.000Z',
    });
    await main.upsertProjection({
      entityType: 'agent', entityId: 'shared', kernelId: 'deepseek-harness', desiredVersion: 2,
      status: 'failed', nativeId: 'same-native-id', error: 'retry me', updatedAt: '2026-08-23T00:00:00.000Z',
    });
    expect(await main.listProjections('agent', 'shared')).toEqual([
      expect.objectContaining({ kernelId: 'deepseek-harness', status: 'failed', error: 'retry me' }),
      expect.objectContaining({ kernelId: 'openclaw', status: 'ready', appliedVersion: 2 }),
    ]);
    await service.close();

    const futurePath = join(root, 'future.sqlite');
    const future = new DatabaseSync(futurePath);
    future.exec('PRAGMA user_version = 999');
    future.close();
    expect(() => new ClawXDataService(futurePath)).toThrow(/newer than supported/);
  });

  it('applies owner-only POSIX modes to state and blob files', async () => {
    if (process.platform === 'win32') return;
    const root = mkdtempSync(join(tmpdir(), 'clawx-owner-mode-'));
    const path = join(root, 'state', 'clawx.sqlite');
    const service = new ClawXDataService(path);
    const main = service.connect({ role: 'main' });
    const blob = await main.putBlob({
      data: new TextEncoder().encode('mode'), mimeType: 'text/plain', createdAt: '2026-08-23T00:00:00.000Z',
    });
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(blob.path).mode & 0o777).toBe(0o600);
    await service.close();
  });
});
