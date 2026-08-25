// @vitest-environment node

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClawXDataService, type ClawXDataClient } from '@electron/data/clawx-data-service';
import {
  AgentProjectionReconciler,
  type AgentKernelProjectionAdapter,
} from '@electron/domains/agents/agent-projection-reconciler';
import { CanonicalAgentService } from '@electron/domains/agents/agent-service';
import { asConversationId, asRunId, asTurnId } from '@shared/conversations/contracts';
import type { KernelId } from '@shared/kernels/contracts';

function callClient(client: ClawXDataClient) {
  return {
    call<T>(method: string, ...args: unknown[]): Promise<T> {
      const operation = (client as unknown as Record<string, unknown>)[method];
      if (typeof operation !== 'function') return Promise.reject(new Error(`Unknown DataService method: ${method}`));
      return Reflect.apply(operation, client, args) as Promise<T>;
    },
  };
}

function projection(input: {
  entityId: string;
  kernelId: KernelId;
  nativeId: string;
  version?: number;
}) {
  return {
    entityType: 'agent',
    entityId: input.entityId,
    kernelId: input.kernelId,
    desiredVersion: input.version ?? 1,
    appliedVersion: input.version ?? 1,
    status: 'ready',
    nativeId: input.nativeId,
    updatedAt: '2026-08-24T00:00:00.000Z',
  };
}

describe('canonical multi-kernel Agents domain', () => {
  it('persists one canonical index, per-kernel defaults, and kernel-scoped native identities', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-agents-index-'));
    const dataService = new ClawXDataService(join(root, 'state', 'clawx.sqlite'));
    const main = dataService.connect({ role: 'main' });
    const agents = new CanonicalAgentService(
      callClient(main),
      id => `file://${join(root, 'workspaces', id)}`,
      () => new Date('2026-08-24T00:00:00.000Z'),
    );
    try {
      const first = await agents.create({
        displayName: 'Shared Name',
        supportedKernels: ['openclaw', 'deepseek-harness'],
      });
      const second = await agents.create({
        displayName: 'Shared Name',
        supportedKernels: ['openclaw', 'deepseek-harness'],
      });
      expect([first.id, second.id]).toEqual(['shared-name', 'shared-name-2']);

      await main.upsertProjection(projection({
        entityId: first.id,
        kernelId: 'openclaw',
        nativeId: 'same-native-id',
      }));
      await main.upsertProjection(projection({
        entityId: second.id,
        kernelId: 'deepseek-harness',
        nativeId: 'same-native-id',
      }));
      await expect(main.upsertProjection(projection({
        entityId: second.id,
        kernelId: 'openclaw',
        nativeId: 'same-native-id',
      }))).rejects.toThrow(/UNIQUE constraint failed/);

      await agents.setDefault('openclaw', first.id);
      await agents.setDefault('deepseek-harness', second.id);
      expect(await agents.defaults()).toEqual([
        expect.objectContaining({ kernelId: 'deepseek-harness', agentId: second.id }),
        expect.objectContaining({ kernelId: 'openclaw', agentId: first.id }),
      ]);
      expect((await agents.get(first.id))?.defaultForKernels).toEqual(['openclaw']);
      expect((await agents.get(second.id))?.defaultForKernels).toEqual(['deepseek-harness']);
    } finally {
      await dataService.close();
    }
  });

  it('reconciles each kernel independently and records partial/failed state without rollback', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-agents-reconcile-'));
    const dataService = new ClawXDataService(join(root, 'state', 'clawx.sqlite'));
    const main = dataService.connect({ role: 'main' });
    const data = callClient(main);
    const agents = new CanonicalAgentService(data, id => `file://${join(root, id)}`);
    let deepSeekFails = true;
    const adapters: AgentKernelProjectionAdapter[] = [
      {
        kernelId: 'openclaw',
        available: () => true,
        upsert: async agent => ({ nativeId: `oc-${agent.id}`, partial: true }),
        remove: async () => undefined,
      },
      {
        kernelId: 'deepseek-harness',
        available: () => true,
        upsert: async agent => {
          if (deepSeekFails) throw new Error('bridge unavailable');
          return { nativeId: `dsh-${agent.id}` };
        },
        remove: async () => undefined,
      },
    ];
    const reconciler = new AgentProjectionReconciler(data, adapters);
    try {
      const agent = await agents.create({
        displayName: 'Independent Projection',
        persona: 'Answer tersely',
        presetId: 'coding',
        modelRef: 'deepseek/deepseek-chat',
        supportedKernels: ['openclaw', 'deepseek-harness'],
      });
      expect(await reconciler.reconcileAgent(agent.id)).toEqual([
        expect.objectContaining({ kernelId: 'openclaw', status: 'partial', nativeId: `oc-${agent.id}` }),
        expect.objectContaining({ kernelId: 'deepseek-harness', status: 'failed', error: 'bridge unavailable' }),
      ]);
      expect((await agents.get(agent.id))?.projections.map(value => [value.kernelId, value.state])).toEqual([
        ['deepseek-harness', 'failed'],
        ['openclaw', 'partial'],
      ]);

      deepSeekFails = false;
      await reconciler.reconcileAgent(agent.id, ['deepseek-harness']);
      expect((await agents.get(agent.id))?.projections.map(value => [value.kernelId, value.state])).toEqual([
        ['deepseek-harness', 'ready'],
        ['openclaw', 'partial'],
      ]);
    } finally {
      await dataService.close();
    }
  });

  it('retains an offline native-removal tombstone and clears it only after kernel replay succeeds', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-agents-delete-replay-'));
    const dataService = new ClawXDataService(join(root, 'state', 'clawx.sqlite'));
    const main = dataService.connect({ role: 'main' });
    const data = callClient(main);
    const agents = new CanonicalAgentService(data, id => `file://${join(root, id)}`);
    let available = false;
    const removed: string[] = [];
    const reconciler = new AgentProjectionReconciler(data, [{
      kernelId: 'deepseek-harness',
      available: () => available,
      upsert: async agent => ({ nativeId: `dsh-${agent.id}` }),
      remove: async nativeId => { removed.push(nativeId); },
    }]);
    try {
      const created = await agents.create({
        displayName: 'Deferred Delete',
        supportedKernels: ['deepseek-harness'],
      });
      await main.upsertProjection(projection({
        entityId: created.id,
        kernelId: 'deepseek-harness',
        nativeId: 'native-deferred-delete',
      }));
      const projected = await agents.get(created.id);
      expect(projected).toBeDefined();

      expect(await reconciler.removeAgent(projected!)).toEqual([
        expect.objectContaining({ status: 'pending', kernelId: 'deepseek-harness' }),
      ]);
      await agents.delete(created.id);
      expect((await agents.get(created.id, true))?.projections).toEqual([
        expect.objectContaining({
          kernelId: 'deepseek-harness',
          nativeId: 'native-deferred-delete',
          state: 'pending',
        }),
      ]);

      available = true;
      expect(await reconciler.reconcileDeleted('deepseek-harness')).toEqual([
        expect.objectContaining({
          status: 'ready',
          kernelId: 'deepseek-harness',
          nativeId: 'native-deferred-delete',
        }),
      ]);
      expect(removed).toEqual(['native-deferred-delete']);
      expect((await agents.get(created.id, true))?.projections).toEqual([]);
      expect(await reconciler.reconcileDeleted('deepseek-harness')).toEqual([]);
    } finally {
      await dataService.close();
    }
  });

  it('freezes model/persona/workspace/version into a run and preserves it after update and soft deletion', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-agents-history-'));
    const dataService = new ClawXDataService(join(root, 'state', 'clawx.sqlite'));
    const main = dataService.connect({ role: 'main' });
    const data = callClient(main);
    let clock = 0;
    const agents = new CanonicalAgentService(
      data,
      id => `file://${join(root, 'workspaces', id)}`,
      () => new Date(Date.UTC(2026, 7, 24, 0, 0, clock++)),
    );
    try {
      const agent = await agents.create({
        displayName: 'Run Snapshot',
        persona: 'Original persona',
        presetId: 'original-preset',
        workspaceUri: 'file:///tmp/original-workspace',
        modelRef: 'deepseek-account/deepseek-chat',
        supportedKernels: ['deepseek-harness'],
      });
      await main.upsertProjection(projection({
        entityId: agent.id,
        kernelId: 'deepseek-harness',
        nativeId: 'run-snapshot',
      }));
      await agents.setDefault('deepseek-harness', agent.id);
      const snapshot = await agents.resolveRunSnapshot({ kernelId: 'deepseek-harness' });
      expect(snapshot).toEqual(expect.objectContaining({
        persona: 'Original persona',
        presetId: 'original-preset',
        workspaceUri: 'file:///tmp/original-workspace',
        canonicalVersion: 1,
        model: expect.objectContaining({ modelId: 'deepseek-chat' }),
      }));

      const conversationId = asConversationId('agent-history');
      const runId = asRunId('agent-history-run');
      await main.createConversation({
        id: conversationId,
        createdAt: '2026-08-24T00:00:00.000Z',
      });
      await main.admitRun({
        conversationId,
        turnId: asTurnId('agent-history-turn'),
        runId,
        routing: {
          kernelId: 'deepseek-harness',
          kernelVersion: 'test',
          generation: 1,
          agentId: agent.id,
          agentSnapshot: snapshot,
          workspaceUri: snapshot.workspaceUri,
          providerId: snapshot.model?.providerAccountId ?? snapshot.model?.providerId,
          modelId: snapshot.model?.modelId,
          contextCompilerVersion: 'test/v1',
        },
        userBlocks: [{ id: 'prompt', type: 'text', visibility: 'portable', text: 'preserve me' }],
        createdAt: '2026-08-24T00:00:01.000Z',
      });

      await agents.update(agent.id, {
        persona: 'Changed persona',
        presetId: 'changed-preset',
        workspaceUri: 'file:///tmp/changed-workspace',
        modelRef: 'deepseek-account/deepseek-reasoner',
      });
      await expect(agents.delete(agent.id)).rejects.toThrow(/still the default/);
      await main.clearAgentDefault('deepseek-harness');
      await agents.delete(agent.id);

      const exported = await main.exportConversation(conversationId);
      expect(exported?.runs).toHaveLength(1);
      expect(exported?.runs[0]?.agentSnapshot).toEqual(expect.objectContaining({
        displayName: 'Run Snapshot',
        persona: 'Original persona',
        presetId: 'original-preset',
        workspaceUri: 'file:///tmp/original-workspace',
        canonicalVersion: 1,
        deletedReference: true,
        model: expect.objectContaining({ modelId: 'deepseek-chat' }),
      }));
      expect(await main.getConversation(conversationId)).toBeDefined();
      expect(await agents.get(agent.id)).toBeUndefined();
      expect(await agents.get(agent.id, true)).toEqual(expect.objectContaining({
        id: agent.id,
        enabled: false,
        deletedAt: expect.any(String),
      }));
    } finally {
      await dataService.close();
    }
  });
});
