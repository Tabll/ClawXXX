import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type {
  CanonicalContentBlock,
  CommitTerminalRunInput,
  ConversationId,
  KernelContextSnapshotV1,
  RunId,
  TurnId,
} from '@shared/conversations/contracts';
import { asConversationId, asRunId, asTurnId } from '@shared/conversations/contracts';
import { KERNEL_CONTRACT_PROTOCOL, type KernelEventEnvelopeV1, type KernelId } from '@shared/kernels/contracts';
import type { KernelStdioEvent } from '@shared/kernels/runtime-protocol';
import type { KernelSupervisorRegistry } from '../kernels/supervisor-registry';
import type { KernelProviderDefault } from '@shared/domains/providers';
import type { AgentRunSnapshot } from '@shared/domains/agents';
import { UsageAdapterRegistry } from '../domains/usage/usage-adapters';

export type ConversationRouterDataClient = {
  call<T = unknown>(method: string, ...args: unknown[]): Promise<T>;
  disconnect?(): Promise<void> | void;
};

export type ConversationPromptInput = {
  conversationId?: ConversationId;
  turnId?: TurnId;
  runId?: RunId;
  kernelId: KernelId;
  generation?: number;
  agentId: string;
  workspaceUri: string;
  providerId?: string;
  modelId?: string;
  permissionMode?: 'default' | 'ask' | 'deny';
  message?: string;
  blocks?: CanonicalContentBlock[];
  attachments?: Array<{ blockId: string; blobHash: string; accessGrantId: string }>;
  attachmentInputs?: Array<{
    data: Uint8Array;
    mimeType: string;
    fileName?: string;
  }>;
};

export type ConversationPromptAcceptance = {
  conversationId: ConversationId;
  turnId: TurnId;
  runId: RunId;
  kernelId: KernelId;
  generation: number;
  acceptedAt: string;
};

type KernelPromptResult = {
  checkpoint?: unknown;
  outputAttachments?: Array<{
    blockId: string;
    mimeType: string;
    data: string;
    name?: string;
  }>;
};

const DSH_CHECKPOINT_CODEC = 'deepseek-harness-agent';
const DSH_CHECKPOINT_SCHEMA_VERSION = 1;
const KERNEL_PROMPT_TIMEOUT_MS = 24 * 60 * 60 * 1_000;

export type ConversationRouteIdentity = Omit<ConversationPromptAcceptance, 'acceptedAt'>;

type RunState = ConversationPromptAcceptance & {
  providerId?: string;
  modelId?: string;
  kernelClient: ConversationRouterDataClient;
  eventTail: Promise<void>;
  pendingEvents: KernelStdioEvent[];
  flushScheduled: boolean;
  seenEventSeq: Map<number, string>;
  seenNativeIds: Map<string, { eventSeq: number; fingerprint: string }>;
  assistantText: string;
  assistantBlocks: CanonicalContentBlock[];
  assistantResourceKeys: Set<string>;
  usage?: CommitTerminalRunInput['usage'];
  terminal?: CommitTerminalRunInput['outcome'];
  completed: boolean;
  committing?: Promise<void>;
};

export type ConversationRouterOptions = {
  supervisors: KernelSupervisorRegistry;
  mainData: ConversationRouterDataClient;
  connectKernelData(kernelId: KernelId, generation: number): Promise<ConversationRouterDataClient>;
  /** Main-owned resolver backed by the unified Provider defaults table. */
  resolveProviderDefault?(kernelId: KernelId): Promise<KernelProviderDefault | undefined>;
  /** Main-owned canonical Agent resolver; runtimes never select mutable Agent metadata. */
  resolveAgentSnapshot?(input: {
    kernelId: KernelId;
    agentId: string;
    providerId?: string;
    modelId?: string;
  }): Promise<AgentRunSnapshot>;
  usageAdapters?: UsageAdapterRegistry;
  now?: () => Date;
  id?: () => string;
};

function textPayload(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (!payload || typeof payload !== 'object') return '';
  const record = payload as Record<string, unknown>;
  for (const key of ['text', 'content', 'message', 'delta']) {
    if (typeof record[key] === 'string') return record[key];
  }
  return '';
}

function numberField(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  }
  return undefined;
}

function outcomeOf(payload: unknown): CommitTerminalRunInput['outcome'] {
  const value = payload && typeof payload === 'object'
    ? (payload as Record<string, unknown>).outcome ?? (payload as Record<string, unknown>).status
    : payload;
  return value === 'cancelled' || value === 'failed' || value === 'interrupted' ? value : 'completed';
}

/**
 * Single admission/routing boundary for every kernel. It owns canonical run
 * leases and terminal commits; runtimes only receive compiled portable context
 * and emit generation-scoped events.
 */
export class ConversationRouter extends EventEmitter {
  private readonly runs = new Map<RunId, RunState>();
  private readonly activeByConversation = new Map<ConversationId, RunId>();
  private readonly usageAdapters: UsageAdapterRegistry;
  private readonly onKernelEvent = (event: KernelStdioEvent) => this.acceptKernelEvent(event);

  constructor(private readonly options: ConversationRouterOptions) {
    super();
    this.usageAdapters = options.usageAdapters ?? new UsageAdapterRegistry();
    options.supervisors.on('event', this.onKernelEvent);
  }

  async prompt(input: ConversationPromptInput): Promise<ConversationPromptAcceptance> {
    const snapshot = this.options.supervisors.status(input.kernelId);
    if (snapshot.state !== 'ready') throw new Error(`Kernel ${input.kernelId} is not ready`);
    if (input.generation !== undefined && input.generation !== snapshot.generation) {
      throw new Error(`Kernel generation is stale: expected ${snapshot.generation}, received ${input.generation}`);
    }
    const createdAt = this.now();
    const resolvedAgent = await this.options.resolveAgentSnapshot?.({
      kernelId: input.kernelId,
      agentId: input.agentId,
      ...(input.providerId ? { providerId: input.providerId } : {}),
      ...(input.modelId ? { modelId: input.modelId } : {}),
    }) ?? {
      agentId: input.agentId as AgentRunSnapshot['agentId'],
      displayName: input.agentId,
      kernelId: input.kernelId,
      workspaceUri: input.workspaceUri,
      canonicalVersion: 1,
    };
    const providerDefault = (!input.providerId && !resolvedAgent.model?.providerAccountId)
      || (!input.modelId && !resolvedAgent.model?.modelId)
      ? await this.options.resolveProviderDefault?.(input.kernelId)
      : undefined;
    const providerId = input.providerId
      ?? resolvedAgent.model?.providerAccountId
      ?? resolvedAgent.model?.providerId
      ?? providerDefault?.accountId;
    const modelId = input.modelId ?? (
      resolvedAgent.model?.modelId
      ?? (!providerId || providerId === providerDefault?.accountId ? providerDefault?.modelId : undefined)
    );
    const agentSnapshot: AgentRunSnapshot = providerId && modelId
      ? {
          ...resolvedAgent,
          model: {
            providerAccountId: providerId,
            providerId: resolvedAgent.model?.providerId ?? providerId,
            modelId,
            ...(resolvedAgent.model?.parameters ? { parameters: resolvedAgent.model.parameters } : {}),
          },
        }
      : resolvedAgent;
    const workspaceUri = agentSnapshot.workspaceUri;
    const conversationId = input.conversationId ?? asConversationId(this.id());
    const turnId = input.turnId ?? asTurnId(this.id());
    const runId = input.runId ?? asRunId(this.id());
    if (this.activeByConversation.has(conversationId)) {
      throw new Error(`Conversation already has an active run: ${conversationId}`);
    }
    const existing = await this.options.mainData.call<unknown>('getConversation', conversationId);
    if (!existing) {
      await this.options.mainData.call('createConversation', {
        id: conversationId,
        ...(input.message?.trim() ? { title: input.message.trim().slice(0, 120) } : {}),
        createdAt,
      });
    }
    const blocks: CanonicalContentBlock[] = input.blocks?.length
      ? input.blocks
      : [{
          id: this.id(),
          type: 'text' as const,
          visibility: 'portable' as const,
          text: input.message ?? '',
        }];
    const attachments = [...(input.attachments ?? [])];
    for (const attachment of input.attachmentInputs ?? []) {
      const stored = await this.options.mainData.call<{ hash: string }>('putBlob', {
        data: attachment.data,
        mimeType: attachment.mimeType,
        createdAt,
      });
      const blockId = this.id();
      const accessGrantId = this.id();
      blocks.push({
        id: blockId,
        type: attachment.mimeType.startsWith('image/') ? 'image' : 'resource-link',
        visibility: 'portable',
        mimeType: attachment.mimeType,
        blobHash: stored.hash,
      });
      if (attachment.fileName) {
        blocks.push({
          id: this.id(),
          type: 'metadata',
          visibility: 'portable',
          json: { attachment: { blockId, fileName: attachment.fileName } },
        });
      }
      attachments.push({ blockId, blobHash: stored.hash, accessGrantId });
    }
    if (blocks.length === 0) throw new Error('Prompt requires at least one canonical content block');
    await this.options.mainData.call('admitRun', {
      conversationId,
      turnId,
      runId,
      routing: {
        kernelId: input.kernelId,
        kernelVersion: snapshot.artifactVersion ?? snapshot.version ?? 'unknown',
        generation: snapshot.generation,
        agentId: agentSnapshot.agentId,
        agentSnapshot,
        workspaceUri,
        ...(providerId ? { providerId } : {}),
        ...(modelId ? { modelId } : {}),
        contextCompilerVersion: 'clawx.portable-context/v1',
      },
      userBlocks: blocks,
      ...(attachments.length > 0 ? {
        attachmentGrants: attachments.map(attachment => ({
          id: attachment.accessGrantId,
          blockId: attachment.blockId,
          blobHash: attachment.blobHash,
          expiresAt: new Date(Date.parse(createdAt) + 24 * 60 * 60 * 1000).toISOString(),
        })),
      } : {}),
      createdAt,
    });

    const kernelClient = await this.options.connectKernelData(input.kernelId, snapshot.generation);
    const state: RunState = {
      conversationId,
      turnId,
      runId,
      kernelId: input.kernelId,
      generation: snapshot.generation,
      acceptedAt: createdAt,
      ...(providerId ? { providerId } : {}),
      ...(modelId ? { modelId } : {}),
      kernelClient,
      eventTail: Promise.resolve(),
      pendingEvents: [],
      flushScheduled: false,
      seenEventSeq: new Map(),
      seenNativeIds: new Map(),
      assistantText: '',
      assistantBlocks: [],
      assistantResourceKeys: new Set(),
      completed: false,
    };
    this.runs.set(runId, state);
    this.activeByConversation.set(conversationId, runId);
    try {
      const context = await kernelClient.call<KernelContextSnapshotV1>('compileContext', {
        conversationId,
        runId,
        maxBlocks: 2_000,
        maxTextCharacters: 1_000_000,
      });
      await kernelClient.call('markRunStarted', runId, this.now());
      this.emit('started', {
        ...this.acceptance(state),
        updatedAt: this.now(),
      });
      const checkpoint = input.kernelId === 'deepseek-harness'
        ? await kernelClient.call<{ checkpoint: unknown } | undefined>('getLatestConversationCheckpoint', {
            conversationId,
            codec: DSH_CHECKPOINT_CODEC,
            schemaVersion: DSH_CHECKPOINT_SCHEMA_VERSION,
            beforeRunId: runId,
          })
        : undefined;
      const attachmentPayloads = await Promise.all(attachments.map(async attachment => {
        const block = blocks.find(candidate => candidate.id === attachment.blockId);
        const metadata = blocks.find(candidate => (
          candidate.type === 'metadata'
          && candidate.json
          && typeof candidate.json === 'object'
          && (candidate.json as { attachment?: { blockId?: unknown } }).attachment?.blockId === attachment.blockId
        ));
        const fileName = metadata?.json && typeof metadata.json === 'object'
          ? (metadata.json as { attachment?: { fileName?: unknown } }).attachment?.fileName
          : undefined;
        const data = await kernelClient.call<Uint8Array>('readBlob', {
          grantId: attachment.accessGrantId,
          blobHash: attachment.blobHash,
          runId,
          now: this.now(),
        });
        return {
          blockId: attachment.blockId,
          blobHash: attachment.blobHash,
          mimeType: block?.mimeType ?? 'application/octet-stream',
          data: Buffer.from(data).toString('base64'),
          ...(typeof fileName === 'string' ? { name: fileName } : {}),
        };
      }));
      const promptResult = await this.options.supervisors.request<KernelPromptResult>(
        input.kernelId,
        'session.prompt',
        {
          context: context.blocks,
          agentId: agentSnapshot.agentId,
          agentVersion: agentSnapshot.canonicalVersion,
          workspaceUri,
          ...(agentSnapshot.persona ? { agentPersona: agentSnapshot.persona } : {}),
          ...(agentSnapshot.presetId ? { agentPresetId: agentSnapshot.presetId } : {}),
          ...(providerId ? { providerId } : {}),
          ...(modelId ? { modelId } : {}),
          ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
          ...(input.kernelId === 'deepseek-harness'
            ? (attachmentPayloads.length > 0 ? { attachments: attachmentPayloads } : {})
            : (attachments.length > 0 ? { attachments } : {})),
          ...(checkpoint ? { checkpoint: checkpoint.checkpoint } : {}),
        },
        { conversationId, turnId, runId },
        KERNEL_PROMPT_TIMEOUT_MS,
      );
      if (promptResult?.checkpoint !== undefined) {
        await kernelClient.call('putCheckpoint', {
          runId,
          codec: DSH_CHECKPOINT_CODEC,
          schemaVersion: DSH_CHECKPOINT_SCHEMA_VERSION,
          checkpoint: promptResult.checkpoint,
          createdAt: this.now(),
        });
      }
      for (const output of promptResult?.outputAttachments ?? []) {
        const bytes = Buffer.from(output.data, 'base64');
        if (bytes.toString('base64') !== output.data) throw new Error('Kernel returned non-canonical attachment base64');
        const stored = await this.options.mainData.call<{ hash: string }>('putBlob', {
          data: bytes,
          mimeType: output.mimeType,
          createdAt: this.now(),
        });
        state.assistantBlocks.push({
          id: output.blockId || this.id(),
          type: output.mimeType.startsWith('image/') ? 'image' : 'resource-link',
          visibility: 'portable',
          mimeType: output.mimeType,
          blobHash: stored.hash,
        });
        if (output.name) {
          state.assistantBlocks.push({
            id: this.id(),
            type: 'metadata',
            visibility: 'portable',
            json: { attachment: { blockId: output.blockId, fileName: output.name } },
          });
        }
      }
      await state.eventTail;
      await this.commitTerminal(state, state.terminal ?? 'completed');
      return {
        conversationId,
        turnId,
        runId,
        kernelId: input.kernelId,
        generation: snapshot.generation,
        acceptedAt: createdAt,
      };
    } catch (error) {
      await state.eventTail.catch(() => undefined);
      await this.commitTerminal(state, state.terminal ?? 'failed').catch(() => undefined);
      if (!state.completed) await this.abandonState(state);
      throw error;
    }
  }

  async cancel(input: ConversationRouteIdentity): Promise<{ acknowledged: boolean }> {
    const state = this.requireState(input);
    const result = await this.options.supervisors.request<{ acknowledged?: boolean; cancelled?: boolean }>(
      state.kernelId,
      'session.cancel',
      undefined,
      { conversationId: state.conversationId, turnId: state.turnId, runId: state.runId },
    );
    await state.eventTail;
    await this.commitTerminal(state, 'cancelled');
    return { acknowledged: result.acknowledged === true || result.cancelled === true };
  }

  async configure(input: ConversationRouteIdentity & {
    providerId?: string;
    modelId?: string;
    permissionMode?: 'default' | 'ask' | 'deny';
  }): Promise<void> {
    const state = this.requireState(input);
    await this.options.supervisors.request(
      state.kernelId,
      'session.configure',
      { providerId: input.providerId, modelId: input.modelId, permissionMode: input.permissionMode },
      { conversationId: state.conversationId, turnId: state.turnId, runId: state.runId },
    );
  }

  async resolvePermission(input: ConversationRouteIdentity & {
    requestId: string;
    decision: 'allow-once' | 'reject-once';
    optionId?: string;
    answer?: string;
  }): Promise<void> {
    const state = this.requireState(input);
    await this.options.supervisors.request(
      state.kernelId,
      'session.permission.resolve',
      {
        requestId: input.requestId,
        decision: input.decision,
        ...(input.optionId ? { optionId: input.optionId } : {}),
        ...(input.answer ? { answer: input.answer } : {}),
      },
      { conversationId: state.conversationId, turnId: state.turnId, runId: state.runId },
    );
  }

  activeRun(conversationId: ConversationId): ConversationPromptAcceptance | undefined {
    const runId = this.activeByConversation.get(conversationId);
    const state = runId ? this.runs.get(runId) : undefined;
    return state && !state.completed ? this.acceptance(state) : undefined;
  }

  runtimeSnapshot(kernelId: KernelId) {
    return this.options.supervisors.status(kernelId);
  }

  async close(): Promise<void> {
    this.options.supervisors.off('event', this.onKernelEvent);
    await Promise.allSettled([...this.runs.values()].map(async state => {
      await state.eventTail.catch(() => undefined);
      if (!state.completed) await this.commitTerminal(state, state.terminal ?? 'interrupted').catch(() => undefined);
      if (!state.completed) await this.abandonState(state);
    }));
    this.runs.clear();
    this.activeByConversation.clear();
  }

  private acceptKernelEvent(event: KernelStdioEvent): void {
    const state = this.runs.get(asRunId(event.identity.runId));
    if (!state || state.completed) return;
    if (
      event.kernelId !== state.kernelId
      || event.generation !== state.generation
      || event.identity.conversationId !== state.conversationId
      || event.identity.turnId !== state.turnId
    ) return;
    state.pendingEvents.push(event);
    if (state.flushScheduled) return;
    state.flushScheduled = true;
    state.eventTail = state.eventTail.then(async () => {
      // Coalesce adjacent streaming deltas while keeping interaction latency low.
      await new Promise(resolve => setTimeout(resolve, 4));
      while (state.pendingEvents.length > 0) {
        const batch = state.pendingEvents.splice(0);
        await this.persistEvents(state, batch);
        await Promise.resolve();
      }
      state.flushScheduled = false;
    }, async (error) => {
      state.flushScheduled = false;
      throw error;
    });
  }

  private async persistEvents(state: RunState, events: KernelStdioEvent[]): Promise<void> {
    const pendingSeq = new Map<number, string>();
    const pendingNative = new Map<string, { eventSeq: number; fingerprint: string }>();
    const envelopes: KernelEventEnvelopeV1[] = [];
    for (const event of [...events].sort((left, right) => left.eventSeq - right.eventSeq)) {
      const rawPayload = event.event.payload;
      const payloadEventId = rawPayload && typeof rawPayload === 'object'
        && typeof (rawPayload as Record<string, unknown>).eventId === 'string'
        ? String((rawPayload as Record<string, unknown>).eventId)
        : undefined;
      const nativeEventId = event.nativeEventId ?? payloadEventId;
      const payload = event.event.kind === 'usage'
        ? this.usageAdapters.normalize(rawPayload, {
            kernelId: state.kernelId,
            runId: state.runId,
            eventSeq: event.eventSeq,
            ...(nativeEventId ? { nativeEventId } : {}),
            ...(state.providerId ? { providerId: state.providerId } : {}),
            ...(state.modelId ? { modelId: state.modelId } : {}),
          })
        : rawPayload;
      const fingerprint = JSON.stringify([event.event.kind, payload ?? null, nativeEventId ?? null]);
      const previousSeq = state.seenEventSeq.get(event.eventSeq) ?? pendingSeq.get(event.eventSeq);
      if (previousSeq !== undefined) {
        if (previousSeq !== fingerprint) {
          throw new Error(`Conflicting kernel event replay for ${state.runId}:${event.eventSeq}`);
        }
        continue;
      }
      if (nativeEventId) {
        const previousNative = state.seenNativeIds.get(nativeEventId) ?? pendingNative.get(nativeEventId);
        if (previousNative) {
          if (previousNative.eventSeq !== event.eventSeq || previousNative.fingerprint !== fingerprint) {
            throw new Error(`Conflicting native event replay for ${state.runId}:${nativeEventId}`);
          }
          continue;
        }
      }
      pendingSeq.set(event.eventSeq, fingerprint);
      if (nativeEventId) pendingNative.set(nativeEventId, { eventSeq: event.eventSeq, fingerprint });
      envelopes.push({
        protocol: KERNEL_CONTRACT_PROTOCOL,
        conversationId: state.conversationId,
        turnId: state.turnId,
        runId: state.runId,
        kernelId: state.kernelId,
        generation: state.generation,
        eventSeq: event.eventSeq,
        emittedAt: this.now(),
        ...(nativeEventId ? { nativeEventId } : {}),
        event: { kind: event.event.kind as KernelEventEnvelopeV1['event']['kind'], payload },
      });
    }
    if (envelopes.length === 0) return;
    await state.kernelClient.call('appendEvents', envelopes);
    for (const envelope of envelopes) {
      const fingerprint = JSON.stringify([
        envelope.event.kind,
        envelope.event.payload ?? null,
        envelope.nativeEventId ?? null,
      ]);
      state.seenEventSeq.set(envelope.eventSeq, fingerprint);
      if (envelope.nativeEventId) {
        state.seenNativeIds.set(envelope.nativeEventId, { eventSeq: envelope.eventSeq, fingerprint });
      }
      this.reduceEvent(state, envelope);
      this.emit('event', envelope);
    }
  }

  private reduceEvent(state: RunState, envelope: KernelEventEnvelopeV1): void {
    const { kind, payload } = envelope.event;
    if (kind === 'assistant.delta') state.assistantText += textPayload(payload);
    if (kind === 'assistant.final') {
      const text = textPayload(payload);
      if (text) state.assistantText = text;
    }
    if ((kind === 'assistant.delta' || kind === 'assistant.final') && payload && typeof payload === 'object') {
      const payloadRecord = payload as Record<string, unknown>;
      const content = Array.isArray(payloadRecord.content) ? payloadRecord.content : [];
      const resources = [
        ...(Array.isArray(payloadRecord.resources) ? payloadRecord.resources : []),
        ...content.filter(value => (
          value && typeof value === 'object' && (value as Record<string, unknown>).type === 'resource_link'
        )),
      ];
      resources.forEach((value, index) => {
        if (!value || typeof value !== 'object') return;
        const resource = value as Record<string, unknown>;
        if (typeof resource.uri !== 'string' || !resource.uri.trim()) return;
        const name = typeof resource.name === 'string' && resource.name.trim()
          ? resource.name
          : resource.uri;
        const mimeType = typeof resource.mimeType === 'string' && resource.mimeType.trim()
          ? resource.mimeType
          : undefined;
        const key = JSON.stringify([resource.uri, name, mimeType ?? null]);
        if (state.assistantResourceKeys.has(key)) return;
        state.assistantResourceKeys.add(key);
        state.assistantBlocks.push({
          id: `${state.runId}:resource:${envelope.eventSeq}:${index}`,
          type: 'resource-link',
          visibility: 'kernel',
          kernelId: state.kernelId,
          ...(mimeType ? { mimeType } : {}),
          json: {
            uri: resource.uri,
            name,
            ...(typeof resource.size === 'number' && Number.isFinite(resource.size) && resource.size >= 0
              ? { size: resource.size }
              : {}),
            ...(resource._meta && typeof resource._meta === 'object'
              ? { _meta: structuredClone(resource._meta) }
              : {}),
          },
        });
      });
      content.forEach((value, index) => {
        if (!value || typeof value !== 'object') return;
        const image = value as Record<string, unknown>;
        if (image.type !== 'image') return;
        const uri = typeof image.uri === 'string' && image.uri.trim() ? image.uri : undefined;
        const data = typeof image.data === 'string' && image.data ? image.data : undefined;
        if (!uri && !data) return;
        const mimeType = typeof image.mimeType === 'string' && image.mimeType.trim()
          ? image.mimeType
          : undefined;
        const key = JSON.stringify(['image', uri ?? null, data ?? null, mimeType ?? null]);
        if (state.assistantResourceKeys.has(key)) return;
        state.assistantResourceKeys.add(key);
        state.assistantBlocks.push({
          id: `${state.runId}:image:${envelope.eventSeq}:${index}`,
          type: 'image',
          visibility: 'kernel',
          kernelId: state.kernelId,
          ...(mimeType ? { mimeType } : {}),
          json: {
            ...(uri ? { uri } : {}),
            ...(data ? { data } : {}),
            ...(image._meta && typeof image._meta === 'object'
              ? { _meta: structuredClone(image._meta) }
              : {}),
          },
        });
      });
    }
    if (kind === 'tool.result') {
      state.assistantBlocks.push({
        id: `tool-${envelope.eventSeq}`,
        type: 'tool-result',
        visibility: 'kernel',
        kernelId: state.kernelId,
        json: structuredClone(payload),
      });
    }
    if (kind === 'usage' && payload && typeof payload === 'object') {
      const row = payload as Record<string, unknown>;
      state.usage = {
        ...(numberField(row, 'inputTokens', 'input_tokens', 'input') !== undefined
          ? { inputTokens: numberField(row, 'inputTokens', 'input_tokens', 'input') }
          : {}),
        ...(numberField(row, 'outputTokens', 'output_tokens', 'output') !== undefined
          ? { outputTokens: numberField(row, 'outputTokens', 'output_tokens', 'output') }
          : {}),
        ...(numberField(row, 'cacheReadTokens', 'cache_read_tokens', 'cacheRead') !== undefined
          ? { cacheReadTokens: numberField(row, 'cacheReadTokens', 'cache_read_tokens', 'cacheRead') }
          : {}),
        ...(numberField(row, 'cacheWriteTokens', 'cache_write_tokens', 'cacheWrite') !== undefined
          ? { cacheWriteTokens: numberField(row, 'cacheWriteTokens', 'cache_write_tokens', 'cacheWrite') }
          : {}),
        ...(numberField(row, 'totalTokens', 'total_tokens') !== undefined
          ? { totalTokens: numberField(row, 'totalTokens', 'total_tokens') }
          : {}),
        ...(numberField(row, 'cost', 'costUsd', 'cost_usd') !== undefined
          ? { cost: numberField(row, 'cost', 'costUsd', 'cost_usd') }
          : {}),
        ...(typeof row.currency === 'string' ? { currency: row.currency } : {}),
        ...(typeof row.eventKey === 'string' ? { eventKey: row.eventKey } : {}),
        ...(typeof row.requestId === 'string' ? { requestId: row.requestId } : {}),
        source: row.source === 'provider-response' ? 'provider-response' : 'runtime-event',
      };
    }
    if (kind === 'run.terminal') state.terminal = outcomeOf(payload);
  }

  private async commitTerminal(state: RunState, outcome: CommitTerminalRunInput['outcome']): Promise<void> {
    if (state.completed) return;
    if (state.committing) return state.committing;
    state.committing = (async () => {
      const assistantBlocks = [...state.assistantBlocks];
      if (state.assistantText) {
        assistantBlocks.unshift({
          id: this.id(),
          type: 'text',
          visibility: 'portable',
          text: state.assistantText,
        });
      }
      const completedAt = this.now();
      await state.kernelClient.call('commitTerminalRun', {
        conversationId: state.conversationId,
        userTurnId: state.turnId,
        assistantTurnId: asTurnId(this.id()),
        runId: state.runId,
        kernelId: state.kernelId,
        generation: state.generation,
        outcome,
        assistantBlocks,
        ...(state.usage ? { usage: state.usage } : {}),
        completedAt,
      });
      state.completed = true;
      this.activeByConversation.delete(state.conversationId);
      await Promise.resolve(state.kernelClient.disconnect?.()).catch(() => undefined);
      this.emit('terminal', { ...this.acceptance(state), outcome, updatedAt: completedAt });
    })();
    try {
      await state.committing;
    } finally {
      state.committing = undefined;
    }
  }

  private async abandonState(state: RunState): Promise<void> {
    state.completed = true;
    if (this.activeByConversation.get(state.conversationId) === state.runId) {
      this.activeByConversation.delete(state.conversationId);
    }
    await Promise.resolve(state.kernelClient.disconnect?.()).catch(() => undefined);
  }

  private requireState(input: ConversationRouteIdentity): RunState {
    const state = this.runs.get(input.runId);
    if (
      !state
      || state.conversationId !== input.conversationId
      || state.turnId !== input.turnId
      || state.kernelId !== input.kernelId
      || state.generation !== input.generation
    ) throw new Error('Run identity is stale or unknown');
    return state;
  }

  private acceptance(state: RunState): ConversationPromptAcceptance {
    return {
      conversationId: state.conversationId,
      turnId: state.turnId,
      runId: state.runId,
      kernelId: state.kernelId,
      generation: state.generation,
      acceptedAt: state.acceptedAt,
    };
  }

  private now(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  private id(): string {
    return this.options.id?.() ?? randomUUID();
  }
}
