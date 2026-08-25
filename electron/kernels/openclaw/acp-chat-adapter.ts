import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type {
  KernelDriverHost,
  KernelEventKind,
  KernelPermissionResolution,
  KernelRunAcceptance,
  KernelRunConfiguration,
  KernelRunIdentity,
  KernelRunRequest,
} from '@shared/kernels/contracts';
import type { AcpChatService } from '../../services/acp-chat-service';
import type { AcpPermissionRequestEnvelope, AcpSessionUpdateEnvelope } from '@shared/acp-chat/types';
import type { OpenClawChatAdapter } from './openclaw-driver';
import type { OpenClawRuntimeLocation } from './runtime-location';

function workspacePath(uri: string): string {
  if (uri.startsWith('file:')) return fileURLToPath(uri);
  return uri;
}

function sessionKey(input: Pick<KernelRunIdentity, 'conversationId'> & { agentId?: string }): string {
  if (String(input.conversationId).startsWith('agent:')) return String(input.conversationId);
  return `agent:${input.agentId || 'main'}:clawx-${input.conversationId}`;
}

function promptText(input: KernelRunRequest): string {
  const parts = input.context.map(block => {
    if (block.text !== undefined) return block.text;
    if (block.json !== undefined) return JSON.stringify(block.json);
    if (block.blobHash) return `[ClawX attachment ${block.blobHash}]`;
    return '';
  }).filter(Boolean);
  return parts.join('\n\n');
}

function requireSuccess(result: { success: boolean; error?: string }, operation: string): void {
  if (!result.success) throw new Error(result.error || `OpenClaw ACP ${operation} failed`);
}

/** Compatibility execution adapter; ConversationRouter replaces UI session/load in M7. */
export class OpenClawAcpChatAdapter implements OpenClawChatAdapter {
  private readonly sessionsByRun = new Map<string, string>();
  private readonly runsBySession = new Map<string, KernelRunIdentity>();
  private readonly eventSeqByRun = new Map<string, number>();
  private readonly terminalRuns = new Set<string>();
  private readonly pendingRuns = new Set<string>();
  private readonly cancelledBeforePrompt = new Set<string>();
  private executionTail: Promise<void> = Promise.resolve();
  private activeRunId?: string;
  private host?: KernelDriverHost;
  private generation?: number;
  private runtime?: OpenClawRuntimeLocation;
  private unsubscribeUpdates?: () => void;
  private unsubscribePermissions?: () => void;

  constructor(
    private readonly acp: AcpChatService,
    private readonly afterOperation?: () => Promise<void>,
  ) {}

  async initialize(input: {
    host: KernelDriverHost;
    generation: number;
    runtime: OpenClawRuntimeLocation;
  }): Promise<void> {
    this.host = input.host;
    this.generation = input.generation;
    this.runtime = input.runtime;
    this.unsubscribeUpdates?.();
    this.unsubscribePermissions?.();
    this.unsubscribeUpdates = this.acp.observeSessionUpdates(event => this.forwardSessionUpdate(event));
    this.unsubscribePermissions = this.acp.observePermissionRequests(event => this.forwardPermission(event));
  }

  async execute(input: KernelRunRequest): Promise<KernelRunAcceptance> {
    this.pendingRuns.add(input.runId);
    const predecessor = this.executionTail;
    let release!: () => void;
    this.executionTail = new Promise<void>(resolve => { release = resolve; });
    await predecessor;
    this.pendingRuns.delete(input.runId);
    this.activeRunId = input.runId;
    try {
      return await this.executeInActiveSlot(input);
    } finally {
      if (this.activeRunId === input.runId) this.activeRunId = undefined;
      this.cancelledBeforePrompt.delete(input.runId);
      release();
    }
  }

  private async executeInActiveSlot(input: KernelRunRequest): Promise<KernelRunAcceptance> {
    if (this.cancelledBeforePrompt.has(input.runId)) return this.acceptance(input);
    const key = sessionKey(input);
    const cwd = workspacePath(input.workspaceUri);
    const loaded = await this.acp.loadSession({
      sessionKey: key,
      workspaceRoot: cwd,
      cwd,
      // Managed sessions are always transient and hydrate from canonical input.
      createIfMissing: true,
    });
    requireSuccess(loaded, 'session/new');
    this.sessionsByRun.set(input.runId, key);
    this.runsBySession.set(key, input);
    if (this.cancelledBeforePrompt.has(input.runId)) return this.acceptance(input, key);
    const configuration: Array<[string, string]> = [];
    if (input.providerId) configuration.push(['provider', input.providerId]);
    if (input.modelId) configuration.push(['model', input.modelId]);
    if (input.permissionMode) configuration.push(['permission_mode', input.permissionMode]);
    for (const [configId, value] of configuration) {
      const configured = await this.acp.setSessionConfigOption({ sessionKey: key, configId, value });
      requireSuccess(configured, `set ${configId}`);
    }
    if (this.cancelledBeforePrompt.has(input.runId)) return this.acceptance(input, key);
    const staged = await this.materializeAttachments(input);
    try {
      const prompted = await this.acp.sendPrompt({
        sessionKey: key,
        cwd,
        message: promptText(input),
        messageId: input.runId,
        ...(staged.media.length > 0 ? { media: staged.media } : {}),
      });
      requireSuccess(prompted, 'session/prompt');
      await this.emit(input, 'run.terminal', { outcome: 'completed' });
    } finally {
      await staged.cleanup();
      await this.afterOperation?.();
    }
    return this.acceptance(input, key);
  }

  async cancel(input: KernelRunIdentity): Promise<{ acknowledged: boolean }> {
    if (
      (this.pendingRuns.has(input.runId) || this.activeRunId === input.runId)
      && !this.sessionsByRun.has(input.runId)
    ) {
      this.cancelledBeforePrompt.add(input.runId);
      await this.emit(input, 'cancel.acknowledged', { acknowledged: true, queued: true });
      await this.emit(input, 'run.terminal', { outcome: 'cancelled' });
      return { acknowledged: true };
    }
    const key = this.sessionsByRun.get(input.runId) ?? sessionKey(input);
    const result = await this.acp.cancelSession({ sessionKey: key });
    if (result.success) {
      await this.emit(input, 'cancel.acknowledged', { acknowledged: true });
      await this.emit(input, 'run.terminal', { outcome: 'cancelled' });
    }
    await this.afterOperation?.();
    return { acknowledged: result.success };
  }

  async resolvePermission(input: KernelPermissionResolution): Promise<void> {
    const key = this.sessionsByRun.get(input.runId) ?? sessionKey(input);
    const result = await this.acp.respondPermission({
      sessionKey: key,
      requestId: input.requestId,
      outcome: input.decision === 'allow-once'
        ? { outcome: 'selected', optionId: 'allow_once' }
        : { outcome: 'cancelled' },
    });
    requireSuccess(result, 'permission response');
    await this.emit(input, 'permission.resolved', {
      requestId: input.requestId,
      decision: input.decision,
    });
  }

  async updateRunConfiguration(input: KernelRunConfiguration): Promise<void> {
    const key = this.sessionsByRun.get(input.runId) ?? sessionKey(input);
    const values: Array<[string, string]> = [];
    if (input.providerId) values.push(['provider', input.providerId]);
    if (input.modelId) values.push(['model', input.modelId]);
    if (input.permissionMode) values.push(['permission_mode', input.permissionMode]);
    for (const [configId, value] of values) {
      const result = await this.acp.setSessionConfigOption({ sessionKey: key, configId, value });
      requireSuccess(result, `set ${configId}`);
    }
  }

  async stop(): Promise<void> {
    this.unsubscribeUpdates?.();
    this.unsubscribePermissions?.();
    this.unsubscribeUpdates = undefined;
    this.unsubscribePermissions = undefined;
    this.sessionsByRun.clear();
    this.runsBySession.clear();
    this.eventSeqByRun.clear();
    this.terminalRuns.clear();
    this.pendingRuns.clear();
    this.cancelledBeforePrompt.clear();
    this.activeRunId = undefined;
    this.host = undefined;
    this.generation = undefined;
    this.runtime = undefined;
    await this.acp.shutdown();
  }

  private acceptance(input: KernelRunIdentity, nativeSessionId?: string): KernelRunAcceptance {
    return {
      conversationId: input.conversationId,
      turnId: input.turnId,
      runId: input.runId,
      kernelId: input.kernelId,
      generation: input.generation,
      acceptedAt: new Date().toISOString(),
      ...(nativeSessionId ? { nativeSessionId } : {}),
    };
  }

  private async materializeAttachments(input: KernelRunRequest): Promise<{
    media: Array<{ filePath: string; stagingId: string; fileName: string; mimeType: string }>;
    cleanup(): Promise<void>;
  }> {
    if (!input.attachments?.length) return { media: [], cleanup: async () => undefined };
    if (!this.host || !this.runtime) throw new Error('OpenClaw attachment bridge is not initialized');
    const directory = await mkdtemp(join(this.runtime.tempRoot, 'prompt-attachment-'));
    const metadataNames = new Map<string, string>();
    for (const block of input.context) {
      if (block.type !== 'metadata' || !block.json || typeof block.json !== 'object') continue;
      const attachment = (block.json as Record<string, unknown>).attachment;
      if (!attachment || typeof attachment !== 'object') continue;
      const record = attachment as Record<string, unknown>;
      if (typeof record.blockId === 'string' && typeof record.fileName === 'string') {
        metadataNames.set(record.blockId, basename(record.fileName));
      }
    }
    try {
      const media = [];
      for (const [index, attachment] of input.attachments.entries()) {
        const block = input.context.find(candidate => candidate.id === attachment.blockId);
        if (!block?.blobHash || block.blobHash !== attachment.blobHash) {
          throw new Error(`OpenClaw attachment block is missing from canonical context: ${attachment.blockId}`);
        }
        const mimeType = block.mimeType || 'application/octet-stream';
        const preferredName = metadataNames.get(block.id)
          || `${attachment.blobHash}${extensionForMime(mimeType)}`;
        const filePath = join(directory, `${index}-${preferredName}`);
        const data = await this.host.store.readAttachment({
          grantId: attachment.accessGrantId,
          blobHash: attachment.blobHash,
          runId: input.runId,
        });
        await writeFile(filePath, data);
        media.push({
          filePath,
          stagingId: attachment.accessGrantId,
          fileName: preferredName,
          mimeType,
        });
      }
      return {
        media,
        cleanup: async () => { await rm(directory, { recursive: true, force: true }); },
      };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  private async forwardSessionUpdate(envelope: AcpSessionUpdateEnvelope): Promise<void> {
    if (envelope.historical || envelope.generation < 1) return;
    const run = this.runsBySession.get(envelope.sessionKey);
    if (!run) return;
    const update = envelope.notification.update as Record<string, unknown>;
    const type = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : 'unknown';
    const projectedContent = sessionContent(update.content);
    const contentPayload = {
      text: projectedContent.text,
      messageId: update.messageId,
      ...(projectedContent.resources.length > 0 ? { resources: projectedContent.resources } : {}),
      ...(projectedContent.images.length > 0 ? { content: projectedContent.images } : {}),
    };
    switch (type) {
      case 'user_message':
      case 'user_message_chunk':
        return;
      case 'agent_message_chunk':
        await this.emit(run, 'assistant.delta', contentPayload);
        return;
      case 'agent_message':
        await this.emit(run, 'assistant.final', contentPayload);
        return;
      case 'agent_thought_chunk':
        await this.emit(run, 'reasoning.visibility', { visibility: 'private', text: projectedContent.text });
        return;
      case 'tool_call':
        await this.emit(run, 'tool.start', update);
        return;
      case 'tool_call_update': {
        const status = String(update.status ?? '').toLowerCase();
        await this.emit(
          run,
          status === 'completed' || status === 'failed' ? 'tool.result' : 'tool.progress',
          update,
        );
        return;
      }
      case 'usage_update':
        await this.emit(run, 'usage', update);
        return;
      case 'plan':
        await this.emit(run, 'diagnostic', { category: 'plan', ...update });
        return;
      default:
        await this.emit(run, 'diagnostic', { category: 'acp-session-update', ...update });
    }
  }

  private async forwardPermission(envelope: AcpPermissionRequestEnvelope): Promise<void> {
    const run = this.runsBySession.get(envelope.sessionKey);
    if (!run) return;
    await this.emit(run, 'permission.request', {
      requestId: envelope.requestId,
      toolCall: envelope.request.toolCall,
      options: envelope.request.options,
    });
  }

  private async emit(
    run: KernelRunIdentity,
    kind: KernelEventKind,
    payload: unknown,
  ): Promise<void> {
    if (!this.host || this.generation !== run.generation) return;
    if (this.terminalRuns.has(run.runId)) return;
    const eventSeq = (this.eventSeqByRun.get(run.runId) ?? 0) + 1;
    this.eventSeqByRun.set(run.runId, eventSeq);
    await this.host.emit({
      protocol: 'clawx.kernel/v1',
      conversationId: run.conversationId,
      turnId: run.turnId,
      runId: run.runId,
      kernelId: run.kernelId,
      generation: run.generation,
      eventSeq,
      emittedAt: new Date().toISOString(),
      event: { kind, payload },
    });
    if (kind === 'run.terminal') this.terminalRuns.add(run.runId);
  }
}

function sessionContent(value: unknown): {
  text: string;
  resources: Array<{ uri: string; name: string; mimeType?: string; size?: number }>;
  images: Array<{
    type: 'image';
    uri?: string;
    data?: string;
    mimeType?: string;
    _meta?: Record<string, unknown>;
  }>;
} {
  if (typeof value === 'string') return { text: value, resources: [], images: [] };
  const blocks = Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : [];
  const text: string[] = [];
  const resources: Array<{ uri: string; name: string; mimeType?: string; size?: number }> = [];
  const images: Array<{
    type: 'image';
    uri?: string;
    data?: string;
    mimeType?: string;
    _meta?: Record<string, unknown>;
  }> = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const record = block as Record<string, unknown>;
    if (typeof record.text === 'string') text.push(record.text);
    if (record.type === 'image' && (typeof record.uri === 'string' || typeof record.data === 'string')) {
      images.push({
        type: 'image',
        ...(typeof record.uri === 'string' ? { uri: record.uri } : {}),
        ...(typeof record.data === 'string' ? { data: record.data } : {}),
        ...(typeof record.mimeType === 'string' ? { mimeType: record.mimeType } : {}),
        ...(record._meta && typeof record._meta === 'object'
          ? { _meta: structuredClone(record._meta as Record<string, unknown>) }
          : {}),
      });
      continue;
    }
    if (record.type !== 'resource_link' || typeof record.uri !== 'string' || !record.uri.trim()) continue;
    resources.push({
      uri: record.uri,
      name: typeof record.name === 'string' && record.name.trim() ? record.name : basename(record.uri),
      ...(typeof record.mimeType === 'string' ? { mimeType: record.mimeType } : {}),
      ...(typeof record.size === 'number' && Number.isFinite(record.size) && record.size >= 0
        ? { size: record.size }
        : {}),
    });
  }
  return { text: text.join(''), resources, images };
}

function extensionForMime(mimeType: string): string {
  return ({
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'text/plain': '.txt',
    'text/markdown': '.md',
    'application/pdf': '.pdf',
  } as Record<string, string>)[mimeType] ?? '.bin';
}
