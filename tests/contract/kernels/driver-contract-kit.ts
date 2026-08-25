import { expect } from 'vitest';
import {
  CONVERSATION_STORE_PROTOCOL,
  type ConversationStoreProtocolClient,
} from '@shared/conversations/store-protocol';
import { asConversationId, asRunId, asTurnId } from '@shared/conversations/contracts';
import { asAgentId } from '@shared/domains/identity';
import type { KernelDriver, KernelDriverHost, KernelEventEnvelopeV1, KernelId } from '@shared/kernels/contracts';
import type { FakeConversationStore } from './fakes/fake-kernel-driver';

export function createFakeStore(): FakeConversationStore {
  const writes: KernelEventEnvelopeV1[] = [];
  const store: ConversationStoreProtocolClient = {
    protocol: CONVERSATION_STORE_PROTOCOL,
    nativeHistoryFallback: false,
    compileContext: input => Promise.resolve({
      protocol: CONVERSATION_STORE_PROTOCOL,
      conversationId: input.conversationId,
      runId: input.runId,
      kernelId: input.kernelId,
      compilerVersion: 'test/v1',
      blocks: [],
      omitted: { privateBlocks: 0, secretBlocks: 0, otherKernelBlocks: 0, revokedBlocks: 0, budgetBlocks: 0 },
    }),
    appendEvents: events => {
      writes.push(...structuredClone(events));
      return Promise.resolve({ inserted: events.length, duplicates: 0 });
    },
    readAttachment: () => Promise.resolve(new Uint8Array()),
    putCheckpoint: () => Promise.resolve(),
    getLatestCheckpoint: () => Promise.resolve(undefined),
  };
  return Object.assign(store, { writes });
}

export function createFakeHost(store = createFakeStore()): KernelDriverHost & { events: KernelEventEnvelopeV1[] } {
  const events: KernelEventEnvelopeV1[] = [];
  return {
    store,
    events,
    emit: async event => {
      events.push(structuredClone(event));
      await store.appendEvents([event]);
    },
    log: () => undefined,
    requestCredential: () => Promise.resolve('test-only-credential'),
  };
}

export async function verifyKernelDriverContract(
  kernelId: KernelId,
  create: () => KernelDriver,
): Promise<void> {
  const store = createFakeStore();
  const host = createFakeHost(store);
  const driver = create();
  expect(driver.definition.id).toBe(kernelId);
  expect(driver.definition.contractVersion).toBe(1);
  await driver.initialize(host);
  expect((await driver.start()).state).toBe('ready');

  const identity = {
    conversationId: asConversationId(`conversation-${kernelId}`),
    turnId: asTurnId(`turn-${kernelId}`),
    runId: asRunId(`run-${kernelId}`),
    kernelId,
    generation: 1,
  };
  const accepted = await driver.execute({
    ...identity,
    context: [],
    agentId: 'agent',
    workspaceUri: 'file:///workspace',
  });
  expect(accepted).toEqual(expect.objectContaining(identity));
  expect(host.events).toHaveLength(1);
  expect(store.writes).toHaveLength(1);
  expect(store.writes[0]).toEqual(expect.objectContaining(identity));

  await driver.cancel(identity);
  await driver.updateRunConfiguration({ ...identity, modelId: 'model-two' });
  await driver.resolvePermission({ ...identity, requestId: 'permission-one', decision: 'reject-once' });

  const agent = {
    id: asAgentId(`agent-${kernelId}`),
    displayName: 'Same display name',
    workspaceUri: 'file:///workspace',
    enabled: true,
    supportedKernels: [kernelId],
    defaultForKernels: [kernelId],
    projections: [],
    version: 1,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
  await driver.control.agents.upsert(agent, `operation-${kernelId}`);
  expect(await driver.control.agents.list()).toEqual([agent]);
  expect(await driver.control.diagnostics()).toEqual(expect.objectContaining({
    kernelId,
    persistence: 'clawx-only',
  }));

  await driver.stop();
  expect((await driver.health()).state).toBe('stopped');
}
