// @vitest-environment node

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationRouter } from '@electron/conversations/conversation-router';
import { ClawXDataService, type ClawXDataClient } from '@electron/data/clawx-data-service';
import { KernelSupervisorRegistry } from '@electron/kernels/supervisor-registry';
import { asConversationId, asRunId, asTurnId } from '@shared/conversations/contracts';
import type { KernelId } from '@shared/kernels/contracts';
import type { KernelStdioEvent } from '@shared/kernels/runtime-protocol';
import { createFakeHost } from './driver-contract-kit';
import { FakeKernelDriver } from './fakes/fake-kernel-driver';

type KernelRunRequestWithCheckpoint = FakeKernelDriver['requests'][number] & { checkpoint?: unknown };

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map(cleanup => cleanup()));
});

function remote(client: ClawXDataClient) {
  return {
    call<T>(method: string, ...args: unknown[]): Promise<T> {
      const fn = (client as unknown as Record<string, unknown>)[method];
      if (typeof fn !== 'function') return Promise.reject(new Error(`Unknown method: ${method}`));
      return Reflect.apply(fn, client, args) as Promise<T>;
    },
    disconnect: () => client.disconnect(),
  };
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'clawx-router-'));
  const service = new ClawXDataService(join(root, 'clawx.sqlite'));
  const main = service.connect({ role: 'main' });
  const drivers = new Map<KernelId, FakeKernelDriver>();
  const supervisors = new KernelSupervisorRegistry((kernelId, generation) => {
    const driver = new FakeKernelDriver(kernelId, generation);
    drivers.set(kernelId, driver);
    return { kind: 'driver', driver, host: createFakeHost(), artifactVersion: `test-${generation}` };
  });
  await Promise.all([supervisors.start('openclaw'), supervisors.start('deepseek-harness')]);
  let id = 0;
  const router = new ConversationRouter({
    supervisors,
    mainData: remote(main),
    connectKernelData: async (kernelId, generation) => remote(service.connect({ role: 'kernel', kernelId, generation })),
    resolveProviderDefault: kernelId => main.getProviderDefault(kernelId),
    now: () => new Date(Date.UTC(2026, 7, 23, 0, 0, id)),
    id: () => `generated-${id += 1}`,
  });
  cleanups.push(async () => {
    await router.close();
    await supervisors.stopAll();
    await service.close();
  });
  return { service, main, drivers, supervisors, router };
}

describe('ConversationRouter', () => {
  function stdioEvent(input: {
    conversationId: string;
    turnId: string;
    runId: string;
    kernelId: KernelId;
    eventSeq: number;
    nativeEventId?: string;
    kind: string;
    payload: unknown;
  }): KernelStdioEvent {
    return {
      protocol: 'clawx.kernel-stdio/v1',
      type: 'event',
      kernelId: input.kernelId,
      generation: 1,
      identity: {
        conversationId: input.conversationId,
        turnId: input.turnId,
        runId: input.runId,
      },
      eventSeq: input.eventSeq,
      ...(input.nativeEventId ? { nativeEventId: input.nativeEventId } : {}),
      event: { kind: input.kind, payload: input.payload },
    };
  }

  it('resolves Provider account and model from the selected kernel default', async () => {
    const { main, drivers, router } = await fixture();
    await main.putProvider({
      id: 'deepseek-primary' as never,
      providerId: 'deepseek',
      displayName: 'DeepSeek Primary',
      authMode: 'api_key',
      credentialRef: 'keychain://provider/deepseek-primary' as never,
      metadata: {},
      models: [{
        providerId: 'deepseek',
        modelId: 'deepseek-chat',
        displayName: 'DeepSeek Chat',
        modalities: ['text'],
        supportedKernels: ['openclaw', 'deepseek-harness'],
      }],
      selectedModelId: 'deepseek-chat',
      enabled: true,
      projections: [],
      version: 1,
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z',
    });
    await main.setProviderDefault({
      kernelId: 'deepseek-harness',
      accountId: 'deepseek-primary' as never,
      modelId: 'deepseek-chat',
      updatedAt: '2026-08-24T00:00:00.000Z',
    });

    await router.prompt({
      conversationId: asConversationId('provider-default-conversation'),
      turnId: asTurnId('provider-default-turn'),
      runId: asRunId('provider-default-run'),
      kernelId: 'deepseek-harness',
      agentId: 'main',
      workspaceUri: 'file:///workspace',
      message: 'use kernel default',
    });

    expect(drivers.get('deepseek-harness')?.requests[0]).toMatchObject({
      providerId: 'deepseek-primary',
      modelId: 'deepseek-chat',
    });
    expect((await main.exportConversation(asConversationId('provider-default-conversation'))).runs[0])
      .toMatchObject({ providerId: 'deepseek-primary', modelId: 'deepseek-chat' });
  });

  it('admits before dispatch and persists two simultaneous kernel streams with isolated identities', async () => {
    const { main, router } = await fixture();
    const events: unknown[] = [];
    router.on('event', event => events.push(event));
    const [openclaw, dsh] = await Promise.all([
      router.prompt({
        conversationId: asConversationId('conversation-openclaw'),
        turnId: asTurnId('turn-openclaw'),
        runId: asRunId('run-openclaw'),
        kernelId: 'openclaw',
        agentId: 'same-name',
        workspaceUri: 'file:///workspace/openclaw',
        message: 'OpenClaw prompt',
      }),
      router.prompt({
        conversationId: asConversationId('conversation-dsh'),
        turnId: asTurnId('turn-dsh'),
        runId: asRunId('run-dsh'),
        kernelId: 'deepseek-harness',
        agentId: 'same-name',
        workspaceUri: 'file:///workspace/dsh',
        message: 'DSH prompt',
      }),
    ]);
    expect(openclaw).toMatchObject({ kernelId: 'openclaw', generation: 1 });
    expect(dsh).toMatchObject({ kernelId: 'deepseek-harness', generation: 1 });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ conversationId: 'conversation-openclaw', runId: 'run-openclaw', kernelId: 'openclaw' }),
      expect.objectContaining({ conversationId: 'conversation-dsh', runId: 'run-dsh', kernelId: 'deepseek-harness' }),
    ]));
    expect((await main.exportConversation(asConversationId('conversation-openclaw'))).turns).toHaveLength(2);
    expect((await main.exportConversation(asConversationId('conversation-dsh'))).turns).toHaveLength(2);
  });

  it('publishes Main-owned catalog lifecycle events around one canonical run', async () => {
    const { drivers, router } = await fixture();
    const gate = Promise.withResolvers<void>();
    drivers.get('openclaw')!.executionGate = gate.promise;
    const started: Array<Record<string, unknown>> = [];
    const terminal: Array<Record<string, unknown>> = [];
    router.on('started', event => started.push(event));
    router.on('terminal', event => terminal.push(event));

    const prompt = router.prompt({
      conversationId: asConversationId('conversation-catalog-lifecycle'),
      turnId: asTurnId('turn-catalog-lifecycle'),
      runId: asRunId('run-catalog-lifecycle'),
      kernelId: 'openclaw',
      agentId: 'main',
      workspaceUri: 'file:///workspace',
      message: 'catalog lifecycle',
    });
    await vi.waitFor(() => expect(started).toEqual([
      expect.objectContaining({
        conversationId: 'conversation-catalog-lifecycle',
        kernelId: 'openclaw',
        updatedAt: expect.any(String),
      }),
    ]));
    expect(terminal).toEqual([]);

    gate.resolve();
    await prompt;
    expect(terminal).toEqual([
      expect.objectContaining({
        conversationId: 'conversation-catalog-lifecycle',
        kernelId: 'openclaw',
        outcome: 'completed',
        updatedAt: expect.any(String),
      }),
    ]);
  });

  it.each([
    { snapshot: { text: '' }, suffix: 'recovered', expected: 'recovered' },
    { snapshot: { text: '' }, suffix: '', expected: '' },
    { snapshot: { resources: [] }, suffix: '', expected: 'partial' },
  ])('settles explicit empty answer snapshots without erasing attachment-only finals: $expected', async ({ snapshot, suffix, expected }) => {
    const { main, drivers, supervisors, router } = await fixture();
    const gate = Promise.withResolvers<void>();
    drivers.get('deepseek-harness')!.executionGate = gate.promise;
    const identity = { conversationId: 'retry-conversation', turnId: 'retry-turn', runId: 'retry-run' };
    const prompt = router.prompt({
      conversationId: asConversationId(identity.conversationId),
      turnId: asTurnId(identity.turnId), runId: asRunId(identity.runId),
      kernelId: 'deepseek-harness', agentId: 'main', workspaceUri: 'file:///workspace', message: 'retry',
    });
    await vi.waitFor(() => expect(drivers.get('deepseek-harness')?.requests).toHaveLength(1));
    for (const [index, event] of [
      { kind: 'assistant.final', payload: { text: '' } },
      { kind: 'assistant.delta', payload: { text: 'partial' } },
      { kind: 'assistant.final', payload: snapshot },
      { kind: 'assistant.delta', payload: { text: suffix } },
    ].entries()) {
      supervisors.emit('event', stdioEvent({ ...identity, kernelId: 'deepseek-harness', eventSeq: index + 2, ...event }));
    }
    gate.resolve();
    await prompt;
    const history = await main.exportConversation(asConversationId(identity.conversationId));
    const assistantText = history.turns.filter(turn => turn.role === 'assistant')
      .flatMap(turn => turn.blocks).filter(block => block.type === 'text').map(block => block.text ?? '').join('');
    expect(assistantText).toBe(expected);
  });

  it('persists and deduplicates kernel-scoped workspace resources in unified history', async () => {
    const { main, drivers, supervisors, router } = await fixture();
    const gate = Promise.withResolvers<void>();
    drivers.get('openclaw')!.executionGate = gate.promise;
    const prompt = router.prompt({
      conversationId: asConversationId('conversation-resource'),
      turnId: asTurnId('turn-resource'),
      runId: asRunId('run-resource'),
      kernelId: 'openclaw',
      agentId: 'main',
      workspaceUri: 'file:///workspace',
      message: 'create report',
    });
    await vi.waitFor(() => expect(drivers.get('openclaw')?.requests).toHaveLength(1));
    for (const eventSeq of [2, 3]) {
      supervisors.emit('event', stdioEvent({
        conversationId: 'conversation-resource',
        turnId: 'turn-resource',
        runId: 'run-resource',
        kernelId: 'openclaw',
        eventSeq,
        kind: eventSeq === 2 ? 'assistant.delta' : 'assistant.final',
        payload: {
          text: eventSeq === 2 ? '' : 'report ready',
          resources: [{
            uri: 'file:///workspace/report.txt',
            name: 'report.txt',
            mimeType: 'text/plain',
            size: 12,
          }],
          content: [{
            type: 'image',
            data: 'aW1hZ2U=',
            mimeType: 'image/png',
          }],
        },
      }));
    }
    gate.resolve();
    await prompt;

    const history = await main.exportConversation(asConversationId('conversation-resource'));
    const resourceBlocks = history.turns.flatMap(turn => turn.blocks).filter(block => block.type === 'resource-link');
    expect(resourceBlocks).toEqual([expect.objectContaining({
      visibility: 'kernel',
      kernelId: 'openclaw',
      mimeType: 'text/plain',
      json: {
        uri: 'file:///workspace/report.txt',
        name: 'report.txt',
        size: 12,
      },
    })]);
    const imageBlocks = history.turns.flatMap(turn => turn.blocks).filter(block => block.type === 'image');
    expect(imageBlocks).toEqual([expect.objectContaining({
      visibility: 'kernel',
      kernelId: 'openclaw',
      mimeType: 'image/png',
      json: { data: 'aW1hZ2U=' },
    })]);
  });

  it('continues one Conversation OpenClaw -> DSH -> OpenClaw with portable-only context', async () => {
    const { drivers, router } = await fixture();
    const conversationId = asConversationId('conversation-switch');
    await router.prompt({
      conversationId,
      kernelId: 'openclaw',
      agentId: 'main',
      workspaceUri: 'file:///workspace',
      blocks: [
        { id: 'portable-one', type: 'text', visibility: 'portable', text: 'portable first' },
        { id: 'private-one', type: 'text', visibility: 'private', text: 'private secret reasoning' },
      ],
    });
    await router.prompt({
      conversationId,
      kernelId: 'deepseek-harness',
      agentId: 'main',
      workspaceUri: 'file:///workspace',
      message: 'second prompt',
    });
    await router.prompt({
      conversationId,
      kernelId: 'openclaw',
      agentId: 'main',
      workspaceUri: 'file:///workspace',
      message: 'third prompt',
    });
    const dshContext = JSON.stringify(drivers.get('deepseek-harness')!.requests[0]!.context);
    expect(dshContext).toContain('portable first');
    expect(dshContext).not.toContain('private secret reasoning');
    const openclawContext = JSON.stringify(drivers.get('openclaw')!.requests[1]!.context);
    expect(openclawContext).toContain('second prompt');
  });

  it('rehydrates DSH portable history and its compatible checkpoint after a runtime restart', async () => {
    const { drivers, router, supervisors } = await fixture();
    const conversationId = asConversationId('conversation-dsh-restart');
    const checkpoint = {
      protocol: 'clawx.dsh-acp-bridge/v1',
      codec: 'deepseek-harness-agent',
      schemaVersion: 1,
      conversationId,
      agentId: 'main',
      workspaceUri: 'file:///workspace',
      contextHash: 'checkpoint-context-hash',
      nativeSessionId: 'transient-run-1',
      completedAt: '2026-08-23T00:00:00.000Z',
    };
    drivers.get('deepseek-harness')!.promptCheckpoint = checkpoint;
    await router.prompt({
      conversationId,
      kernelId: 'deepseek-harness',
      agentId: 'main',
      workspaceUri: 'file:///workspace',
      message: 'portable before restart',
    });

    await supervisors.restart('deepseek-harness');
    const restarted = drivers.get('deepseek-harness')!;
    await router.prompt({
      conversationId,
      kernelId: 'deepseek-harness',
      agentId: 'main',
      workspaceUri: 'file:///workspace',
      message: 'continue after restart',
    });

    expect(JSON.stringify(restarted.requests[0]!.context)).toContain('portable before restart');
    expect((restarted.requests[0] as KernelRunRequestWithCheckpoint).checkpoint).toEqual(checkpoint);
    expect(restarted.attemptedNativeHistoryPaths).toEqual([]);
  });

  it('keeps a background run active across selection changes, cancels by full identity, and enforces the lease', async () => {
    const { main, drivers, router } = await fixture();
    const gate = Promise.withResolvers<void>();
    drivers.get('openclaw')!.executionGate = gate.promise;
    const conversationId = asConversationId('conversation-background');
    const prompt = router.prompt({
      conversationId,
      turnId: asTurnId('turn-background'),
      runId: asRunId('run-background'),
      kernelId: 'openclaw',
      agentId: 'main',
      workspaceUri: 'file:///workspace',
      message: 'keep running',
    });
    await vi.waitFor(() => expect(router.activeRun(conversationId)).toBeDefined());
    await expect(router.prompt({
      conversationId,
      kernelId: 'deepseek-harness',
      agentId: 'main',
      workspaceUri: 'file:///workspace',
      message: 'illegal parallel turn',
    })).rejects.toThrow(/active run/);
    const active = router.activeRun(conversationId)!;
    await expect(router.cancel(active)).resolves.toEqual({ acknowledged: true });
    gate.resolve();
    await prompt;
    expect((await main.exportConversation(conversationId)).runs[0]).toMatchObject({ status: 'cancelled' });
  });

  it('deduplicates an identical eventSeq replay and fails closed on conflicting replay', async () => {
    const first = await fixture();
    const gate = Promise.withResolvers<void>();
    first.drivers.get('openclaw')!.executionGate = gate.promise;
    const prompt = first.router.prompt({
      conversationId: asConversationId('conversation-duplicate'),
      turnId: asTurnId('turn-duplicate'),
      runId: asRunId('run-duplicate'),
      kernelId: 'openclaw',
      agentId: 'main',
      workspaceUri: 'file:///workspace',
      message: 'duplicate',
    });
    await vi.waitFor(async () => {
      expect(await first.main.listRunEvents(asRunId('run-duplicate'))).toHaveLength(1);
    });
    first.supervisors.emit('event', stdioEvent({
      conversationId: 'conversation-duplicate',
      turnId: 'turn-duplicate',
      runId: 'run-duplicate',
      kernelId: 'openclaw',
      eventSeq: 1,
      nativeEventId: 'same-native-event-1',
      kind: 'assistant.delta',
      payload: { text: 'openclaw:run-duplicate' },
    }));
    gate.resolve();
    await prompt;
    expect(await first.main.listRunEvents(asRunId('run-duplicate'))).toHaveLength(1);

    const second = await fixture();
    const conflictingGate = Promise.withResolvers<void>();
    second.drivers.get('openclaw')!.executionGate = conflictingGate.promise;
    const conflictingPrompt = second.router.prompt({
      conversationId: asConversationId('conversation-conflict'),
      turnId: asTurnId('turn-conflict'),
      runId: asRunId('run-conflict'),
      kernelId: 'openclaw',
      agentId: 'main',
      workspaceUri: 'file:///workspace',
      message: 'conflict',
    });
    await vi.waitFor(async () => {
      expect(await second.main.listRunEvents(asRunId('run-conflict'))).toHaveLength(1);
    });
    second.supervisors.emit('event', stdioEvent({
      conversationId: 'conversation-conflict',
      turnId: 'turn-conflict',
      runId: 'run-conflict',
      kernelId: 'openclaw',
      eventSeq: 1,
      nativeEventId: 'same-native-event-1',
      kind: 'assistant.delta',
      payload: { text: 'tampered replay' },
    }));
    conflictingGate.resolve();
    await expect(conflictingPrompt).rejects.toThrow(/Conflicting kernel event replay/);
    expect((await second.main.exportConversation(asConversationId('conversation-conflict'))).runs[0])
      .toMatchObject({ status: 'failed' });
  });

  it('persists simultaneous permission streams from two kernels without native-id collisions', async () => {
    const { main, drivers, supervisors, router } = await fixture();
    const openclawGate = Promise.withResolvers<void>();
    const dshGate = Promise.withResolvers<void>();
    drivers.get('openclaw')!.executionGate = openclawGate.promise;
    drivers.get('deepseek-harness')!.executionGate = dshGate.promise;
    const prompts = [
      router.prompt({
        conversationId: asConversationId('permission-openclaw'),
        turnId: asTurnId('permission-turn-openclaw'),
        runId: asRunId('permission-run-openclaw'),
        kernelId: 'openclaw',
        agentId: 'main',
        workspaceUri: 'file:///workspace',
        message: 'permission',
      }),
      router.prompt({
        conversationId: asConversationId('permission-dsh'),
        turnId: asTurnId('permission-turn-dsh'),
        runId: asRunId('permission-run-dsh'),
        kernelId: 'deepseek-harness',
        agentId: 'main',
        workspaceUri: 'file:///workspace',
        message: 'permission',
      }),
    ];
    await vi.waitFor(async () => {
      expect(await main.listRunEvents(asRunId('permission-run-openclaw'))).toHaveLength(1);
      expect(await main.listRunEvents(asRunId('permission-run-dsh'))).toHaveLength(1);
    });
    for (const kernelId of ['openclaw', 'deepseek-harness'] as const) {
      const suffix = kernelId === 'openclaw' ? 'openclaw' : 'dsh';
      supervisors.emit('event', stdioEvent({
        conversationId: `permission-${suffix}`,
        turnId: `permission-turn-${suffix}`,
        runId: `permission-run-${suffix}`,
        kernelId,
        eventSeq: 2,
        kind: 'permission.request',
        payload: {
          requestId: 'same-native-request',
          options: [{ optionId: 'allow_once', name: 'Allow', kind: 'allow_once' }],
        },
      }));
    }
    await vi.waitFor(async () => {
      expect((await main.getRunArtifacts(asRunId('permission-run-openclaw'))).permissions).toHaveLength(1);
      expect((await main.getRunArtifacts(asRunId('permission-run-dsh'))).permissions).toHaveLength(1);
    });
    openclawGate.resolve();
    dshGate.resolve();
    await Promise.all(prompts);
  });
});
