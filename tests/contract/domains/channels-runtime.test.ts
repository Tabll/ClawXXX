// @vitest-environment node

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChannelAdapterRegistry } from '@electron/channels/channel-adapter-registry';
import { CanonicalChannelAccountService } from '@electron/channels/channel-account-service';
import { ChannelBindingService } from '@electron/channels/channel-binding-service';
import { ChannelConnectorRegistry } from '@electron/channels/channel-connector-registry';
import { registerBuiltinChannelConnectors } from '@electron/channels/connectors';
import { ChannelOrchestrator } from '@electron/channels/channel-orchestrator';
import { ChannelOwnerCoordinator } from '@electron/channels/channel-owner-coordinator';
import { MemoryChannelSecretStore } from '@electron/channels/channel-secret-store';
import { OpenClawChannelAdapter, type OpenClawNativeChannelBackend } from '@electron/channels/openclaw-channel-adapter';
import { RelayChannelAdapter } from '@electron/channels/relay-channel-adapter';
import type {
  ChannelAdapterActivation,
  ChannelConnectorContext,
  ChannelConnectorFactory,
  ChannelConnectorSession,
  ChannelInboundEnvelope,
  ChannelKernelAdapter,
  ChannelOutboundEnvelope,
} from '@electron/channels/channel-runtime-contracts';
import { ConversationRouter } from '@electron/conversations/conversation-router';
import { ClawXDataService, type ClawXDataClient } from '@electron/data/clawx-data-service';
import { CanonicalAgentService } from '@electron/domains/agents/agent-service';
import { KernelSupervisorRegistry } from '@electron/kernels/supervisor-registry';
import { channelBindingKey, type CanonicalChannelAccount } from '@shared/domains/channels';
import { SUPPORTED_CHANNEL_TYPES } from '@shared/types/channel';
import type { KernelId } from '@shared/kernels/contracts';
import { createFakeHost } from '../kernels/driver-contract-kit';
import { FakeKernelDriver } from '../kernels/fakes/fake-kernel-driver';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map(cleanup => cleanup()));
});

function remote(client: ClawXDataClient) {
  return {
    call<T>(method: string, ...args: unknown[]): Promise<T> {
      const operation = (client as unknown as Record<string, unknown>)[method];
      if (typeof operation !== 'function') return Promise.reject(new Error(`Unknown DataService method: ${method}`));
      return Reflect.apply(operation, client, args) as Promise<T>;
    },
    disconnect: () => client.disconnect(),
  };
}

class FakeConnector implements ChannelConnectorFactory {
  context?: ChannelConnectorContext;
  sends: ChannelOutboundEnvelope[] = [];
  sendFailures = 0;
  stopped = 0;

  constructor(readonly channelType: string) {}

  validate(): Promise<{ valid: true }> {
    return Promise.resolve({ valid: true });
  }

  async connect(context: ChannelConnectorContext): Promise<ChannelConnectorSession> {
    this.context = context;
    await context.onStatus({ state: 'connected', changedAt: new Date().toISOString() });
    return {
      stop: async () => { this.stopped += 1; },
      send: async message => {
        this.sends.push(structuredClone(message));
        if (this.sendFailures > 0) {
          this.sendFailures -= 1;
          throw new Error('connector network unavailable token=must-redact');
        }
      },
      targets: async () => [{ id: 'room-1', displayName: 'Room 1', kind: 'room' }],
      status: async () => ({ state: 'connected', changedAt: new Date().toISOString() }),
    };
  }

  emit(message: Omit<ChannelInboundEnvelope, 'accountId' | 'channelType'>): Promise<void> {
    if (!this.context) return Promise.reject(new Error('Connector is not active'));
    return this.context.onInbound({
      ...message,
      accountId: this.context.account.id,
      channelType: this.context.account.channelType,
    });
  }
}

function account(channelType: string): CanonicalChannelAccount {
  const timestamp = '2026-08-24T00:00:00.000Z';
  return {
    id: `${channelType}:default` as CanonicalChannelAccount['id'],
    channelType,
    nativeAccountId: 'default',
    displayName: channelType,
    status: 'disconnected',
    config: {},
    form: [],
    targets: [],
    enabled: true,
    isDefault: true,
    supportedKernels: ['openclaw', 'deepseek-harness'],
    projections: [],
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

describe('Channel adapter contract matrix', () => {
  it('registers a concrete Relay connector for every Channel exposed by the shared UI', () => {
    const registry = new ChannelConnectorRegistry();
    registerBuiltinChannelConnectors(registry, {
      projectionRoot: join(mkdtempSync(join(tmpdir(), 'clawx-relay-connectors-')), 'auth'),
      persistCredential: async () => undefined,
    });
    expect(registry.missingBuiltins()).toEqual([]);
    expect(registry.list().map(factory => factory.channelType).sort()).toEqual(
      [...SUPPORTED_CHANNEL_TYPES].sort(),
    );
  });

  it('gives every supported Channel the same Relay and OpenClaw lifecycle contract', async () => {
    const connectors = new ChannelConnectorRegistry();
    const factories = new Map<string, FakeConnector>();
    for (const channelType of SUPPORTED_CHANNEL_TYPES) {
      const factory = new FakeConnector(channelType);
      factories.set(channelType, factory);
      connectors.register(factory);
    }
    expect(connectors.missingBuiltins()).toEqual([]);
    const relay = new RelayChannelAdapter(connectors);

    const nativeAccounts = new Map<string, CanonicalChannelAccount>();
    const nativeSends: ChannelOutboundEnvelope[] = [];
    const backend: OpenClawNativeChannelBackend = {
      validate: async () => ({ valid: true }),
      projectAccount: async value => { nativeAccounts.set(value.id, value); },
      removeAccount: async value => { nativeAccounts.delete(value.id); },
      enableAccount: async () => undefined,
      disableAccount: async () => undefined,
      send: async message => { nativeSends.push(structuredClone(message)); },
      targets: async () => [{ id: 'room-1', displayName: 'Room 1', kind: 'room' }],
      status: async () => ({ state: 'connected', changedAt: new Date().toISOString() }),
      subscribeInbound: async () => async () => undefined,
    };
    const openclaw = new OpenClawChannelAdapter(backend);

    for (const channelType of SUPPORTED_CHANNEL_TYPES) {
      const canonical = account(channelType);
      const activation: ChannelAdapterActivation = {
        account: canonical,
        connectionConfig: {},
        onInbound: async () => undefined,
        onStatus: async () => undefined,
      };
      for (const adapter of [relay, openclaw]) {
        await expect(adapter.validate(channelType, {})).resolves.toEqual({ valid: true });
        await adapter.activate(activation);
        await expect(adapter.status(canonical.id)).resolves.toEqual(expect.objectContaining({ state: 'connected' }));
        await expect(adapter.targets(canonical.id)).resolves.toEqual([
          expect.objectContaining({ id: 'room-1', kind: 'room' }),
        ]);
        await adapter.send({
          accountId: canonical.id,
          channelType,
          externalConversationId: 'external-conversation',
          externalMessageId: 'external-message',
          targetId: 'room-1',
          text: 'reply',
          attachments: [],
        });
        await adapter.deactivate(canonical.id);
        await expect(adapter.status(canonical.id)).resolves.toEqual(expect.objectContaining({ state: 'disconnected' }));
      }
    }
    expect([...factories.values()].every(factory => factory.sends.length === 1 && factory.stopped === 1)).toBe(true);
    expect(nativeSends).toHaveLength(SUPPORTED_CHANNEL_TYPES.length);
  });
});

describe('Channel owner concurrency', () => {
  it('keeps OpenClaw and DeepSeek Harness active concurrently on different external accounts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-channel-dual-owner-'));
    const dataService = new ClawXDataService(join(root, 'clawx.sqlite'));
    const main = dataService.connect({ role: 'main' });
    const data = remote(main);
    const accounts = new CanonicalChannelAccountService(data, new MemoryChannelSecretStore());
    const openClawAccount = await accounts.upsert({
      channelType: 'telegram',
      nativeAccountId: 'openclaw-account',
      config: { botToken: 'openclaw-secret' },
    });
    const dshAccount = await accounts.upsert({
      channelType: 'discord',
      nativeAccountId: 'dsh-account',
      config: { token: 'dsh-secret' },
    });
    const active = new Map<KernelId, Set<string>>();
    const adapter = (kernelId: KernelId): ChannelKernelAdapter => ({
      kernelId,
      ownerId: `${kernelId}-owner`,
      supportedChannels: SUPPORTED_CHANNEL_TYPES,
      validate: async () => ({ valid: true }),
      activate: async activation => {
        const accountsForKernel = active.get(kernelId) ?? new Set<string>();
        accountsForKernel.add(activation.account.id);
        active.set(kernelId, accountsForKernel);
        await activation.onStatus({ state: 'connected', changedAt: new Date().toISOString() });
      },
      deactivate: async accountId => { active.get(kernelId)?.delete(accountId); },
      send: async () => undefined,
      targets: async () => [],
      status: async () => ({ state: 'connected', changedAt: new Date().toISOString() }),
    });
    const registry = new ChannelAdapterRegistry();
    registry.register(adapter('openclaw'));
    registry.register(adapter('deepseek-harness'));
    const owners = new ChannelOwnerCoordinator(data, accounts, registry, async () => undefined, {
      instanceId: 'dual-owner-test',
      leaseDurationMs: 60_000,
      renewIntervalMs: 20_000,
    });
    cleanups.push(async () => {
      await owners.stop();
      await dataService.close();
    });

    await Promise.all([
      owners.activate(openClawAccount.id, 'openclaw'),
      owners.activate(dshAccount.id, 'deepseek-harness'),
    ]);

    expect(active.get('openclaw')).toEqual(new Set([openClawAccount.id]));
    expect(active.get('deepseek-harness')).toEqual(new Set([dshAccount.id]));
    expect(await main.getChannelOwnerLease(openClawAccount.id, new Date().toISOString())).toEqual(
      expect.objectContaining({ kernelId: 'openclaw' }),
    );
    expect(await main.getChannelOwnerLease(dshAccount.id, new Date().toISOString())).toEqual(
      expect.objectContaining({ kernelId: 'deepseek-harness' }),
    );
  });
});

async function runtimeFixture(options: { maxDeliveryAttempts?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'clawx-channel-runtime-'));
  const dataService = new ClawXDataService(join(root, 'state', 'clawx.sqlite'));
  const main = dataService.connect({ role: 'main' });
  const data = remote(main);
  const accounts = new CanonicalChannelAccountService(data, new MemoryChannelSecretStore());
  const agents = new CanonicalAgentService(data, id => `file://${join(root, 'workspaces', id)}`);
  const agent = await agents.create({
    displayName: 'Channel Agent',
    supportedKernels: ['openclaw', 'deepseek-harness'],
  });
  const canonical = await accounts.upsert({
    channelType: 'telegram',
    nativeAccountId: 'main',
    config: { botToken: 'secret', allowedUsers: '*' },
  });
  await main.putChannelBinding({
    id: channelBindingKey(canonical.id),
    accountId: canonical.id,
    targetId: '*',
    kernelId: 'deepseek-harness',
    agentId: agent.id,
    conversationPolicy: 'per-thread',
    revision: 1,
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
  });

  const drivers = new Map<KernelId, FakeKernelDriver>();
  const supervisors = new KernelSupervisorRegistry((kernelId, generation) => {
    const driver = new FakeKernelDriver(kernelId, generation);
    drivers.set(kernelId, driver);
    return { kind: 'driver', driver, host: createFakeHost(), artifactVersion: `test-${generation}` };
  });
  await supervisors.start('deepseek-harness');
  let routerId = 0;
  const router = new ConversationRouter({
    supervisors,
    mainData: data,
    connectKernelData: async (kernelId, generation) => remote(dataService.connect({ role: 'kernel', kernelId, generation })),
    id: () => `router-${routerId += 1}`,
  });

  const connectors = new ChannelConnectorRegistry();
  const connector = new FakeConnector('telegram');
  connectors.register(connector);
  const adapters = new ChannelAdapterRegistry();
  const relay = new RelayChannelAdapter(connectors);
  adapters.register(relay);
  let orchestrator: ChannelOrchestrator;
  const owners = new ChannelOwnerCoordinator(
    data,
    accounts,
    adapters,
    message => orchestrator.admitInbound(message).then(() => undefined),
    { instanceId: 'test-instance', leaseDurationMs: 60_000, renewIntervalMs: 20_000 },
  );
  let orchestratorId = 0;
  orchestrator = new ChannelOrchestrator(data, router, owners, {
    id: () => `channel-${orchestratorId += 1}`,
    retryBaseMs: 60_000,
    ...(options.maxDeliveryAttempts ? { maxDeliveryAttempts: options.maxDeliveryAttempts } : {}),
  });
  await owners.activate(canonical.id, 'deepseek-harness');

  cleanups.push(async () => {
    orchestrator.stop();
    await owners.stop();
    await relay.stop();
    await router.close();
    await supervisors.stopAll();
    await dataService.close();
  });
  return { main, canonical, connector, drivers, orchestrator };
}

describe('Channel Orchestrator', () => {
  it('deduplicates ingress, serializes a Conversation, denies permissions, stages attachments, and retries delivery', async () => {
    const { main, canonical, connector, drivers, orchestrator } = await runtimeFixture();
    connector.sendFailures = 1;
    const first = {
      externalConversationId: 'chat-1',
      externalMessageId: 'message-1',
      targetId: 'chat-1',
      senderId: 'user-1',
      text: 'first',
      attachments: [{
        data: new TextEncoder().encode('attachment'),
        mimeType: 'text/plain',
        fileName: '../unsafe.txt',
      }],
      receivedAt: '2026-08-24T00:00:00.000Z',
    };
    await Promise.all([connector.emit(first), connector.emit(first)]);

    const driver = drivers.get('deepseek-harness')!;
    expect(driver.requests).toHaveLength(1);
    expect(driver.requests[0]).toEqual(expect.objectContaining({ permissionMode: 'deny' }));
    expect(driver.requests[0]?.attachments).toEqual([
      expect.objectContaining({ name: 'unsafe.txt', mimeType: 'text/plain' }),
    ]);
    expect((await main.listConversations()).items).toHaveLength(1);
    const messages = await main.listChannelMessages({ accountId: canonical.id });
    expect(messages.filter(message => message.direction === 'inbound')).toHaveLength(1);
    const outbound = messages.find(message => message.direction === 'outbound')!;
    expect(outbound).toEqual(expect.objectContaining({ status: 'retrying' }));
    expect(await main.listChannelDeliveryAttempts(outbound.id)).toEqual([
      expect.objectContaining({ attempt: 1, status: 'retry', error: expect.not.stringContaining('must-redact') }),
    ]);

    await orchestrator.retryMessage(outbound.id);
    expect(await main.getChannelMessage(outbound.id)).toEqual(expect.objectContaining({ status: 'delivered' }));
    expect(await main.listChannelDeliveryAttempts(outbound.id)).toEqual([
      expect.objectContaining({ attempt: 1, status: 'retry' }),
      expect.objectContaining({ attempt: 2, status: 'sent' }),
    ]);
    expect(connector.sends).toHaveLength(2);
  });

  it('queues simultaneous messages for one external thread instead of opening parallel runs', async () => {
    const { main, connector, drivers } = await runtimeFixture();
    const gate = Promise.withResolvers<void>();
    drivers.get('deepseek-harness')!.executionGate = gate.promise;
    const one = connector.emit({
      externalConversationId: 'same-thread',
      externalMessageId: 'one',
      targetId: 'same-thread',
      text: 'one',
      receivedAt: '2026-08-24T00:00:00.000Z',
    });
    const two = connector.emit({
      externalConversationId: 'same-thread',
      externalMessageId: 'two',
      targetId: 'same-thread',
      text: 'two',
      receivedAt: '2026-08-24T00:00:01.000Z',
    });
    await vi.waitFor(() => expect(drivers.get('deepseek-harness')!.requests).toHaveLength(1));
    gate.resolve();
    await Promise.all([one, two]);
    expect(drivers.get('deepseek-harness')!.requests).toHaveLength(2);
    const conversations = await main.listConversations();
    expect(conversations.items).toHaveLength(1);
    expect((await main.exportConversation(conversations.items[0]!.id)).turns).toHaveLength(4);
  });

  it('persists a terminal dead letter when the canonical retry budget is exhausted', async () => {
    const { main, canonical, connector, orchestrator } = await runtimeFixture({ maxDeliveryAttempts: 2 });
    connector.sendFailures = 2;
    await connector.emit({
      externalConversationId: 'dead-letter-thread',
      externalMessageId: 'dead-letter-message',
      targetId: 'dead-letter-thread',
      text: 'reply must fail',
      receivedAt: '2026-08-24T00:00:00.000Z',
    });
    const outbound = (await main.listChannelMessages({ accountId: canonical.id }))
      .find(message => message.direction === 'outbound')!;
    expect(outbound.status).toBe('retrying');

    await orchestrator.retryMessage(outbound.id);

    expect(await main.getChannelMessage(outbound.id)).toEqual(expect.objectContaining({ status: 'dead-letter' }));
    expect(await main.listChannelDeliveryAttempts(outbound.id)).toEqual([
      expect.objectContaining({ attempt: 1, status: 'retry' }),
      expect.objectContaining({ attempt: 2, status: 'dead-letter' }),
    ]);
    expect(connector.sends).toHaveLength(2);
  });

  it('delivers a scheduled canonical run through the shared retry pipeline exactly once', async () => {
    const { main, canonical, connector, orchestrator } = await runtimeFixture();
    await connector.emit({
      externalConversationId: 'cron-source-thread',
      externalMessageId: 'cron-source-message',
      targetId: 'cron-source-thread',
      text: 'produce a durable answer',
      receivedAt: '2026-08-24T00:00:00.000Z',
    });
    const conversation = (await main.listConversations()).items[0]!;
    const exported = await main.exportConversation(conversation.id);
    const run = exported.runs[0]!;
    expect(run.assistantTurnId).toBeTruthy();
    const input = {
      jobId: 'scheduled-delivery',
      admissionId: 'scheduled-admission',
      scheduledFor: '2026-08-24T01:00:00.000Z',
      delivery: { accountId: canonical.id, targetId: 'cron-target', mode: 'announce' as const },
      conversationId: conversation.id,
      runId: run.id,
      turnId: run.assistantTurnId!,
    };

    const messageId = await orchestrator.deliverScheduledRun(input);
    await expect(orchestrator.deliverScheduledRun(input)).resolves.toBe(messageId);

    expect(connector.sends).toHaveLength(2);
    const scheduled = (await main.listChannelMessages({ accountId: canonical.id }))
      .filter(message => message.payload.source === 'cron');
    expect(scheduled).toEqual([
      expect.objectContaining({
        id: messageId,
        externalConversationId: 'cron-target',
        status: 'delivered',
        runId: run.id,
      }),
    ]);
    expect(await main.listChannelDeliveryAttempts(messageId!)).toEqual([
      expect.objectContaining({ attempt: 1, status: 'sent' }),
    ]);
  });
});

describe('Channel binding rollback', () => {
  it('stops old admission and restores the old owner when the new adapter fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-channel-rebind-'));
    const dataService = new ClawXDataService(join(root, 'clawx.sqlite'));
    const main = dataService.connect({ role: 'main' });
    const data = remote(main);
    const accounts = new CanonicalChannelAccountService(data, new MemoryChannelSecretStore());
    const agents = new CanonicalAgentService(data, id => `file://${join(root, id)}`);
    const agent = await agents.create({ displayName: 'Agent', supportedKernels: ['openclaw', 'deepseek-harness'] });
    const canonical = await accounts.upsert({
      channelType: 'telegram',
      nativeAccountId: 'main',
      config: { botToken: 'secret', allowedUsers: '*' },
    });
    const activationCounts = new Map<KernelId, number>();
    const adapter = (kernelId: KernelId, fails: boolean): ChannelKernelAdapter => ({
      kernelId,
      ownerId: `${kernelId}-owner`,
      supportedChannels: SUPPORTED_CHANNEL_TYPES,
      validate: async () => ({ valid: true }),
      activate: async () => {
        activationCounts.set(kernelId, (activationCounts.get(kernelId) ?? 0) + 1);
        if (fails) throw new Error('new owner activation failed');
      },
      deactivate: async () => undefined,
      send: async () => undefined,
      targets: async () => [],
      status: async () => ({ state: 'connected', changedAt: new Date().toISOString() }),
    });
    const registry = new ChannelAdapterRegistry();
    registry.register(adapter('openclaw', false));
    registry.register(adapter('deepseek-harness', true));
    const owners = new ChannelOwnerCoordinator(data, accounts, registry, async () => undefined, {
      instanceId: 'rebind-test',
      leaseDurationMs: 60_000,
      renewIntervalMs: 20_000,
    });
    const bindings = new ChannelBindingService(data, owners);
    cleanups.push(async () => {
      await owners.stop();
      await dataService.close();
    });

    expect(await bindings.rebind({
      accountId: canonical.id,
      kernelId: 'openclaw',
      agentId: agent.id,
    })).toEqual(expect.objectContaining({ ok: true }));
    const failed = await bindings.rebind({
      accountId: canonical.id,
      kernelId: 'deepseek-harness',
      agentId: agent.id,
    });
    expect(failed).toEqual(expect.objectContaining({ ok: false, rolledBack: true }));
    expect(await main.getChannelBinding(canonical.id)).toEqual(expect.objectContaining({ kernelId: 'openclaw' }));
    expect(await main.getChannelOwnerLease(canonical.id, new Date().toISOString())).toEqual(
      expect.objectContaining({ kernelId: 'openclaw' }),
    );
    expect(activationCounts.get('openclaw')).toBe(2);
  });
});
