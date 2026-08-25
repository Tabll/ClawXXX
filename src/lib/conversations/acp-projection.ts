import type { SessionNotification } from '@agentclientprotocol/sdk';
import type {
  CanonicalContentBlock,
  ConversationExport,
  ConversationRunEventRecord,
  ConversationRunRecord,
} from '@shared/conversations/contracts';
import type { KernelEventEnvelopeV1 } from '@shared/kernels/contracts';
import type {
  AcpPermissionRequestEnvelope,
  AcpSessionUpdateEnvelope,
} from '@shared/acp-chat/types';
import type { AcpTurnTiming } from '@/lib/acp/turn-timings';
import type { AssistantMessageMetadata } from '@/lib/acp/timeline-types';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function textOf(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  const value = record(payload);
  for (const key of ['text', 'content', 'message', 'delta']) {
    if (typeof value[key] === 'string') return value[key] as string;
  }
  return '';
}

function resourceContent(payload: unknown): Array<Record<string, unknown>> {
  const resources = record(payload).resources;
  if (!Array.isArray(resources)) return [];
  return resources.flatMap((value) => {
    const resource = record(value);
    if (typeof resource.uri !== 'string' || !resource.uri.trim()) return [];
    return [{
      type: 'resource_link',
      uri: resource.uri,
      name: typeof resource.name === 'string' && resource.name.trim()
        ? resource.name
        : resource.uri,
      ...(typeof resource.mimeType === 'string' && resource.mimeType.trim()
        ? { mimeType: resource.mimeType }
        : {}),
      ...(typeof resource.size === 'number' && Number.isFinite(resource.size) && resource.size >= 0
        ? { size: resource.size }
        : {}),
      ...(resource._meta && typeof resource._meta === 'object' ? { _meta: resource._meta } : {}),
    }];
  });
}

function imageContent(payload: unknown): Array<Record<string, unknown>> {
  const blocks = record(payload).content;
  if (!Array.isArray(blocks)) return [];
  return blocks.flatMap((value) => {
    const block = record(value);
    if (block.type !== 'image') return [];
    const uri = typeof block.uri === 'string' && block.uri.trim() ? block.uri : undefined;
    const data = typeof block.data === 'string' && block.data ? block.data : undefined;
    if (!uri && !data) return [];
    return [{
      type: 'image',
      ...(uri ? { uri } : {}),
      ...(data ? { data } : {}),
      ...(typeof block.mimeType === 'string' && block.mimeType.trim()
        ? { mimeType: block.mimeType }
        : {}),
      ...(block._meta && typeof block._meta === 'object' ? { _meta: block._meta } : {}),
    }];
  });
}

function assistantEventBlocks(payload: unknown): Array<Record<string, unknown>> {
  const text = textOf(payload);
  const rich = [...imageContent(payload), ...resourceContent(payload)];
  return [
    ...(text ? [{ type: 'text', text }] : []),
    ...rich,
  ];
}

function assistantDeltaContent(payload: unknown): Record<string, unknown> {
  // ACP chunk updates carry exactly one ContentBlock, while a complete
  // `agent_message` carries ContentBlock[]. Keep these shapes distinct: using
  // the chunk shape for `assistant.final` makes the timeline reducer replace
  // the streamed message with an empty block list.
  const [first] = assistantEventBlocks(payload);
  return first ?? { type: 'text', text: '' };
}

function attachmentNames(blocks: CanonicalContentBlock[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const block of blocks) {
    if (block.type !== 'metadata') continue;
    const attachment = record(record(block.json).attachment);
    if (typeof attachment.blockId === 'string' && typeof attachment.fileName === 'string') {
      names.set(attachment.blockId, attachment.fileName);
    }
  }
  return names;
}

function content(
  conversationId: string,
  blocks: CanonicalContentBlock[],
): Array<Record<string, unknown>> {
  const names = attachmentNames(blocks);
  const projected: Array<Record<string, unknown>> = [];
  for (const block of blocks) {
    if (block.type === 'metadata') continue;
    if (block.type === 'image' && block.json && typeof block.json === 'object') {
      const image = record(block.json);
      const uri = typeof image.uri === 'string' ? image.uri : undefined;
      const data = typeof image.data === 'string' ? image.data : undefined;
      if (uri || data) {
        projected.push({
          type: 'image',
          ...(uri ? { uri } : {}),
          ...(data ? { data } : {}),
          ...(block.mimeType ? { mimeType: block.mimeType } : {}),
          ...(image._meta && typeof image._meta === 'object' ? { _meta: image._meta } : {}),
        });
        continue;
      }
    }
    if (block.type === 'resource-link' && block.json && typeof block.json === 'object') {
      const resource = record(block.json);
      if (typeof resource.uri === 'string' && resource.uri.trim()) {
        projected.push({
          type: 'resource_link',
          uri: resource.uri,
          name: typeof resource.name === 'string' && resource.name.trim()
            ? resource.name
            : block.id,
          ...(block.mimeType ? { mimeType: block.mimeType } : {}),
          ...(typeof resource.size === 'number' ? { size: resource.size } : {}),
          ...(resource._meta && typeof resource._meta === 'object' ? { _meta: resource._meta } : {}),
        });
        continue;
      }
    }
    if (block.text !== undefined) {
      projected.push({ type: 'text', text: block.text });
      continue;
    }
    if (block.blobHash) {
      projected.push({
        type: 'resource_link',
        uri: `clawx-blob://${block.blobHash}`,
        name: names.get(block.id) ?? block.id,
        mimeType: block.mimeType,
        _meta: {
          clawx: {
            conversationId,
            blobHash: block.blobHash,
            blockId: block.id,
            fileName: names.get(block.id) ?? block.id,
          },
        },
      });
      continue;
    }
    if (block.json !== undefined) projected.push({ type: 'text', text: JSON.stringify(block.json) });
  }
  return projected;
}

function historicalEnvelope(
  conversationId: string,
  generation: number,
  notification: SessionNotification,
): AcpSessionUpdateEnvelope {
  return { sessionKey: conversationId, generation, historical: true, notification };
}

function eventNotification(
  conversationId: string,
  run: ConversationRunRecord,
  event: ConversationRunEventRecord,
): AcpSessionUpdateEnvelope | null {
  const payload = record(event.payload);
  let update: Record<string, unknown> | null = null;
  switch (event.kind) {
    // Terminal assistant content is projected from the durable assistant turn.
    // An active/interrupted run without such a turn can still be restored from
    // its canonical run events after a Renderer reload.
    case 'assistant.delta':
      if (run.assistantTurnId) return null;
      update = {
        sessionUpdate: 'agent_message_chunk',
        messageId: run.id,
        content: assistantDeltaContent(payload),
      };
      break;
    case 'assistant.final':
      if (run.assistantTurnId) return null;
      update = {
        sessionUpdate: 'agent_message',
        messageId: run.id,
        content: assistantEventBlocks(payload),
      };
      break;
    case 'reasoning.visibility':
      update = {
        sessionUpdate: 'agent_thought_chunk',
        messageId: `${run.id}:reasoning:${event.eventSeq}`,
        content: { type: 'text', text: textOf(payload) },
      };
      break;
    case 'tool.start':
      update = { sessionUpdate: 'tool_call', ...payload };
      break;
    case 'tool.progress':
    case 'tool.result':
      update = { sessionUpdate: 'tool_call_update', ...payload };
      break;
    case 'usage':
      update = { sessionUpdate: 'usage_update', ...payload };
      break;
    case 'diagnostic':
      if (payload.category === 'plan') update = { sessionUpdate: 'plan', ...payload };
      break;
    default:
      break;
  }
  if (!update) return null;
  return historicalEnvelope(conversationId, run.generation, {
    sessionId: conversationId,
    update,
  } as SessionNotification);
}

export type ConversationHistoryProjectionStep =
  | { kind: 'update'; event: AcpSessionUpdateEnvelope }
  | { kind: 'permission-request'; event: AcpPermissionRequestEnvelope }
  | {
      kind: 'permission-resolved';
      requestId: string;
      status: 'selected' | 'cancelled';
    };

export type ConversationHistoryProjection = {
  steps: ConversationHistoryProjectionStep[];
  assistantMetadataByMessageId: Record<string, AssistantMessageMetadata>;
  turnTimingsByUserMessageId: Record<string, AcpTurnTiming>;
};

/**
 * Projects the canonical SQLite export into the existing kernel-neutral
 * Timeline model. No runtime history or backend-specific transcript is read.
 */
export function projectConversationHistory(
  history: ConversationExport | null,
): ConversationHistoryProjection {
  if (!history) {
    return { steps: [], assistantMetadataByMessageId: {}, turnTimingsByUserMessageId: {} };
  }
  const steps: ConversationHistoryProjectionStep[] = [];
  const assistantMetadataByMessageId: Record<string, AssistantMessageMetadata> = {};
  const turnTimingsByUserMessageId: Record<string, AcpTurnTiming> = {};
  const runsByTurn = new Map<string, ConversationRunRecord[]>();
  for (const run of history.runs) {
    const runs = runsByTurn.get(run.turnId) ?? [];
    runs.push(run);
    runsByTurn.set(run.turnId, runs);

    const started = Date.parse(run.startedAt ?? run.createdAt);
    const completed = run.completedAt ? Date.parse(run.completedAt) : Number.NaN;
    if (Number.isFinite(started) && Number.isFinite(completed)) {
      turnTimingsByUserMessageId[run.turnId] = {
        source: 'transcript',
        status: 'complete',
        durationMs: Math.max(0, completed - started),
      };
    }
    if (run.assistantTurnId) {
      const usage = history.usage.find(entry => entry.runId === run.id);
      assistantMetadataByMessageId[`${run.assistantTurnId}:0`] = {
        timestamp: Date.parse(run.completedAt ?? run.createdAt),
        ...(run.modelId ? { model: run.modelId } : {}),
        ...(run.providerId ? { provider: run.providerId } : {}),
        kernelId: run.kernelId,
        kernelVersion: run.kernelVersion,
        agentId: run.agentId,
        agentName: run.agentSnapshot.displayName,
        ...(run.agentSnapshot.deletedReference ? { agentDeleted: true } : {}),
        runId: run.id,
        ...(usage ? {
          usage: {
            ...(typeof usage.inputTokens === 'number' ? { inputTokens: usage.inputTokens } : {}),
            ...(typeof usage.outputTokens === 'number' ? { outputTokens: usage.outputTokens } : {}),
            ...(typeof usage.cacheReadTokens === 'number' ? { cacheReadTokens: usage.cacheReadTokens } : {}),
            ...(typeof usage.cacheWriteTokens === 'number' ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
          },
        } : {}),
      };
    }
  }

  for (const turn of history.turns) {
    if (turn.role === 'user' || turn.role === 'assistant') {
      steps.push({
        kind: 'update',
        event: historicalEnvelope(history.conversation.id, 1, {
          sessionId: history.conversation.id,
          update: {
            sessionUpdate: turn.role === 'user' ? 'user_message' : 'agent_message',
            messageId: turn.id,
            content: content(history.conversation.id, turn.blocks),
          },
        } as unknown as SessionNotification),
      });
    }
    if (turn.role !== 'user') continue;
    for (const run of runsByTurn.get(turn.id) ?? []) {
      for (const event of run.events) {
        if (event.kind === 'permission.request') {
          const payload = record(event.payload);
          if (typeof payload.requestId === 'string' && Array.isArray(payload.options)) {
            steps.push({
              kind: 'permission-request',
              event: {
                sessionKey: history.conversation.id,
                generation: run.generation,
                requestId: payload.requestId,
                request: {
                  sessionId: history.conversation.id,
                  ...(payload.toolCall && typeof payload.toolCall === 'object'
                    ? { toolCall: payload.toolCall }
                    : {}),
                  options: payload.options,
                } as AcpPermissionRequestEnvelope['request'],
              },
            });
            continue;
          }
        }
        if (event.kind === 'permission.resolved') {
          const payload = record(event.payload);
          if (typeof payload.requestId === 'string') {
            steps.push({
              kind: 'permission-resolved',
              requestId: payload.requestId,
              status: payload.decision === 'allow-once' ? 'selected' : 'cancelled',
            });
            continue;
          }
        }
        const projected = eventNotification(history.conversation.id, run, event);
        if (projected) steps.push({ kind: 'update', event: projected });
      }
    }
  }

  return { steps, assistantMetadataByMessageId, turnTimingsByUserMessageId };
}

/** Compatibility helper used by small reducer tests. */
export function conversationHistoryNotifications(history: ConversationExport | null): SessionNotification[] {
  return projectConversationHistory(history).steps.flatMap(step => (
    step.kind === 'update' ? [step.event.notification] : []
  ));
}

export function kernelEventToAcpUpdate(
  event: KernelEventEnvelopeV1,
): AcpSessionUpdateEnvelope | null {
  const projected = eventNotification(event.conversationId, {
    id: event.runId as ConversationRunRecord['id'],
    turnId: event.turnId as ConversationRunRecord['turnId'],
    kernelId: event.kernelId,
    kernelVersion: 'live',
    generation: event.generation,
    agentId: 'live',
    agentSnapshot: {
      agentId: 'live' as ConversationRunRecord['agentSnapshot']['agentId'],
      displayName: 'live',
      kernelId: event.kernelId,
      workspaceUri: '',
      canonicalVersion: 1,
    },
    status: 'running',
    createdAt: event.emittedAt,
    events: [],
  }, {
    eventSeq: event.eventSeq,
    kind: event.event.kind,
    payload: event.event.payload,
    emittedAt: event.emittedAt,
    ...(event.nativeEventId ? { nativeEventId: event.nativeEventId } : {}),
  });
  return projected ? {
    ...projected,
    // `eventNotification` is also used for durable history and therefore
    // creates a historical envelope. A live KernelEvent must never inherit
    // that bypass flag or it could cross the active-run isolation boundary.
    historical: false,
    conversationId: event.conversationId as AcpSessionUpdateEnvelope['conversationId'],
    runId: event.runId as AcpSessionUpdateEnvelope['runId'],
    kernelId: event.kernelId,
    eventSeq: event.eventSeq,
  } : null;
}

export function kernelEventToPermission(
  event: KernelEventEnvelopeV1,
): AcpPermissionRequestEnvelope | null {
  if (event.event.kind !== 'permission.request') return null;
  const payload = record(event.event.payload);
  if (typeof payload.requestId !== 'string' || !Array.isArray(payload.options)) return null;
  return {
    sessionKey: event.conversationId,
    generation: event.generation,
    conversationId: event.conversationId as AcpPermissionRequestEnvelope['conversationId'],
    runId: event.runId as AcpPermissionRequestEnvelope['runId'],
    kernelId: event.kernelId,
    eventSeq: event.eventSeq,
    requestId: payload.requestId,
    request: {
      sessionId: event.conversationId,
      ...(payload.toolCall && typeof payload.toolCall === 'object' ? { toolCall: payload.toolCall } : {}),
      options: payload.options,
    } as AcpPermissionRequestEnvelope['request'],
  };
}

export function kernelEventToPermissionResolution(event: KernelEventEnvelopeV1): {
  sessionKey: string;
  generation: number;
  conversationId: string;
  runId: string;
  kernelId: KernelEventEnvelopeV1['kernelId'];
  eventSeq: number;
  requestId: string;
  status: 'selected' | 'cancelled';
} | null {
  if (event.event.kind !== 'permission.resolved') return null;
  const payload = record(event.event.payload);
  if (typeof payload.requestId !== 'string') return null;
  return {
    sessionKey: event.conversationId,
    generation: event.generation,
    conversationId: event.conversationId,
    runId: event.runId,
    kernelId: event.kernelId,
    eventSeq: event.eventSeq,
    requestId: payload.requestId,
    status: payload.decision === 'allow-once' ? 'selected' : 'cancelled',
  };
}
