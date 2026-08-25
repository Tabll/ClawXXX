import type { ConversationStoreProtocolClient } from '@shared/conversations/store-protocol';
import type { CanonicalAgent } from '@shared/domains/agents';
import type { CanonicalChannelAccount, CanonicalChannelBinding } from '@shared/domains/channels';
import type { CanonicalCronJob } from '@shared/domains/cron';
import type { CanonicalProviderAccount } from '@shared/domains/providers';
import type { CanonicalSkill } from '@shared/domains/skills';
import type { CanonicalUsage, UsageQuery } from '@shared/domains/usage';
import {
  KERNEL_CONTRACT_PROTOCOL,
  type CanonicalEntityController,
  type KernelDefinition,
  type KernelDriver,
  type KernelDriverHost,
  type KernelEventEnvelopeV1,
  type KernelId,
  type KernelPermissionResolution,
  type KernelRunAcceptance,
  type KernelRunConfiguration,
  type KernelRunIdentity,
  type KernelRunRequest,
  type KernelRuntimeSnapshot,
} from '@shared/kernels/contracts';

class MemoryController<T extends { id: string }> implements CanonicalEntityController<T> {
  private readonly entities = new Map<string, T>();

  list(): Promise<T[]> {
    return Promise.resolve([...this.entities.values()].map(entity => structuredClone(entity)));
  }

  upsert(entity: T, _operationId: string): Promise<T> {
    const copy = structuredClone(entity);
    this.entities.set(entity.id, copy);
    return Promise.resolve(structuredClone(copy));
  }

  remove(id: T['id'], _operationId: string): Promise<void> {
    this.entities.delete(id);
    return Promise.resolve();
  }
}

export class FakeKernelDriver implements KernelDriver {
  readonly definition: KernelDefinition;
  readonly attemptedNativeHistoryPaths: string[] = [];
  readonly configurations: KernelRunConfiguration[] = [];
  readonly permissions: KernelPermissionResolution[] = [];
  readonly requests: KernelRunRequest[] = [];
  executionGate?: Promise<void>;
  promptCheckpoint?: unknown;
  private host?: KernelDriverHost;
  private state: KernelRuntimeSnapshot['state'] = 'stopped';
  private readonly generation: number;
  private eventSeq = new Map<string, number>();
  private readonly usageRows: CanonicalUsage[] = [];

  readonly control = {
    agents: new MemoryController<CanonicalAgent>(),
    providers: new MemoryController<CanonicalProviderAccount>(),
    skills: new MemoryController<CanonicalSkill>(),
    channels: {
      accounts: new MemoryController<CanonicalChannelAccount>(),
      bindings: new MemoryController<CanonicalChannelBinding>(),
    },
    cron: new MemoryController<CanonicalCronJob>(),
    usage: {
      query: (_input: UsageQuery) => Promise.resolve(this.usageRows.map(row => structuredClone(row))),
    },
    diagnostics: () => Promise.resolve({ kernelId: this.definition.id, persistence: 'clawx-only' }),
  };

  constructor(kernelId: KernelId, generation = 1) {
    this.generation = generation;
    this.definition = {
      id: kernelId,
      displayName: kernelId === 'openclaw' ? 'OpenClaw' : 'DeepSeek Harness',
      contractVersion: 1,
      storeProtocolRange: '1.x',
      capabilities: {
        chat: true,
        cancel: true,
        permissions: true,
        resume: true,
        configuration: true,
        agents: true,
        providers: true,
        skills: true,
        channels: true,
        cron: true,
        usage: true,
        checkpointCodecs: [`clawx.${kernelId}.fake/v1`],
      },
    };
  }

  initialize(host: KernelDriverHost): Promise<void> {
    if (host.store.nativeHistoryFallback !== false) {
      return Promise.reject(new Error('Native history fallback is forbidden'));
    }
    this.host = host;
    return Promise.resolve();
  }

  start(): Promise<KernelRuntimeSnapshot> {
    this.requireHost();
    this.state = 'ready';
    return Promise.resolve(this.snapshot());
  }

  stop(): Promise<void> {
    this.state = 'stopped';
    return Promise.resolve();
  }

  health(): Promise<KernelRuntimeSnapshot> {
    return Promise.resolve(this.snapshot());
  }

  async execute(input: KernelRunRequest): Promise<KernelRunAcceptance> {
    const host = this.requireHost();
    this.assertIdentity(input);
    if (this.state !== 'ready') throw new Error('Kernel is not ready');
    this.requests.push(structuredClone(input));
    const event = this.event(input, 'assistant.delta', { text: `${this.definition.id}:${input.runId}` });
    await host.emit(event);
    await this.executionGate;
    return {
      ...input,
      acceptedAt: new Date(0).toISOString(),
      ...(this.promptCheckpoint === undefined ? {} : { checkpoint: structuredClone(this.promptCheckpoint) }),
    };
  }

  async cancel(input: KernelRunIdentity): Promise<{ acknowledged: boolean }> {
    const host = this.requireHost();
    this.assertIdentity(input);
    await host.emit(this.event(input, 'cancel.acknowledged', {}));
    return { acknowledged: true };
  }

  resolvePermission(input: KernelPermissionResolution): Promise<void> {
    this.assertIdentity(input);
    this.permissions.push(structuredClone(input));
    return Promise.resolve();
  }

  updateRunConfiguration(input: KernelRunConfiguration): Promise<void> {
    this.assertIdentity(input);
    this.configurations.push(structuredClone(input));
    return Promise.resolve();
  }

  attemptNativeHistoryWrite(path: string): never {
    this.attemptedNativeHistoryPaths.push(path);
    throw new Error('Kernel drivers cannot open native durable history');
  }

  private requireHost(): KernelDriverHost {
    if (!this.host) throw new Error('Kernel driver is not initialized');
    return this.host;
  }

  private assertIdentity(input: KernelRunIdentity): void {
    if (input.kernelId !== this.definition.id || input.generation !== this.generation) {
      throw new Error('Run identity is outside this kernel generation');
    }
  }

  private event(input: KernelRunIdentity, kind: KernelEventEnvelopeV1['event']['kind'], payload: unknown): KernelEventEnvelopeV1 {
    const eventSeq = (this.eventSeq.get(input.runId) ?? 0) + 1;
    this.eventSeq.set(input.runId, eventSeq);
    return {
      protocol: KERNEL_CONTRACT_PROTOCOL,
      conversationId: input.conversationId,
      turnId: input.turnId,
      runId: input.runId,
      kernelId: this.definition.id,
      generation: this.generation,
      eventSeq,
      emittedAt: new Date(eventSeq * 1_000).toISOString(),
      nativeEventId: `same-native-event-${eventSeq}`,
      event: { kind, payload },
    };
  }

  private snapshot(): KernelRuntimeSnapshot {
    return {
      kernelId: this.definition.id,
      state: this.state,
      generation: this.generation,
      version: 'fake.clawx.1',
      diagnostics: [],
    };
  }
}

export type FakeConversationStore = ConversationStoreProtocolClient & {
  writes: KernelEventEnvelopeV1[];
};
