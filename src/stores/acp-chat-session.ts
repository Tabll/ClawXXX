import { create } from 'zustand';
import type {
  AcpChatLoadPayload,
  AcpChatOperationResult,
  AcpChatPromptPayload,
  AcpChatRespondPermissionPayload,
  AcpChatSetConfigOptionPayload,
  AcpPermissionRequestEnvelope,
  AcpSessionUpdateEnvelope,
} from '@shared/acp-chat/types';
import type {
  MediaThumbnailResult,
  ResolveAttachmentPayload,
  ResolveAttachmentResult,
} from '@shared/host-api/contract';
import i18n from '@/i18n';
import {
  extractImageGenerationCompletionFromAcpEnvelope,
  extractImageGenerationCompletionFromRuntimeEvent,
  extractImageGenerationStartFromAcpEnvelope,
  imageGenerationEvidenceKey,
  type ImageGenerationCompletionEvidence,
  type ImageGenerationMediaCandidate,
  type ImageGenerationTaskStart,
} from '@/lib/acp/image-generation-compat';
import {
  applyAttachmentResolution,
  collectPendingAttachments,
  createPendingAttachment,
  type PendingAttachmentLocation,
} from '@/lib/acp/attachments';
import {
  appendSyntheticAssistantMessage,
  applyAcpSessionUpdate,
  createEmptyAcpTimeline,
} from '@/lib/acp/reducer';
import {
  canonicalDiagnosticHash,
  canonicalResourceLinkPromptText,
} from '@/lib/acp/canonical-prompt-format';
import { applyAssistantMessageMetadata } from '@/lib/acp/assistant-metadata';
import type { AcpTurnTiming } from '@/lib/acp/turn-timings';
import { hostApi } from '@/lib/host-api';
import { hostEvents } from '@/lib/host-events';
import { asConversationId, asRunId, asTurnId } from '@shared/conversations/contracts';
import type { KernelId } from '@shared/kernels/contracts';
import {
  kernelEventToAcpUpdate,
  kernelEventToPermission,
  kernelEventToPermissionResolution,
  projectConversationHistory,
} from '@/lib/conversations/acp-projection';
import type { AcpTimelineSnapshot, MessageSegmentItem, PermissionItem, RenderPart } from '@/lib/acp/timeline-types';

const EMPTY_SESSION_ID = '';
const CANCEL_PERMISSION_OPTION_ID = '__cancelled__';
const IMAGE_GENERATION_COMPAT_WINDOW_MS = 195_000;

type ImageGenerationCompatSession = {
  taskStartedAt: number;
  replayTaskStartedAt: number;
  taskIds: Set<string>;
  replayTaskIds: Set<string>;
  taskToolCallIds: Map<string, string>;
  replayTaskToolCallIds: Map<string, string>;
  lastTaskToolCallId?: string;
  lastReplayToolCallId?: string;
  lastTaskId?: string;
  lastReplayTaskId?: string;
  delivered: Set<string>;
  reservations: Map<string, string>;
  authoritativeCaptions: Map<string, { text: string; priority: number }>;
};

const imageGenerationCompatSessions = new Map<string, ImageGenerationCompatSession>();
type PendingLoadEvent =
  | { kind: 'update'; event: AcpSessionUpdateEnvelope }
  | { kind: 'permission-request'; event: AcpPermissionRequestEnvelope }
  | {
      kind: 'permission-resolved';
      event: {
        sessionKey: string;
        generation: number;
        conversationId?: string;
        runId: string;
        kernelId?: KernelId;
        eventSeq?: number;
        requestId: string;
        status: PermissionItem['status'];
      };
    };
const pendingLoadEvents = new Map<number, PendingLoadEvent[]>();

function queuePendingLoadEvent(generation: number, event: PendingLoadEvent): void {
  const pending = pendingLoadEvents.get(generation) ?? [];
  pendingLoadEvents.set(generation, [...pending, event]);
}

function pendingLoadEventSeq(event: PendingLoadEvent): number {
  if (event.kind === 'update' || event.kind === 'permission-request') {
    return event.event.eventSeq ?? Number.MAX_SAFE_INTEGER;
  }
  return event.event.eventSeq ?? Number.MAX_SAFE_INTEGER;
}
type LiveSessionSnapshot = {
  sessionKey: string;
  activeRunId: string | null;
  activeTurnId: string | null;
  activeKernelId: KernelId | null;
  workspaceRoot: string | null;
  cwd: string | null;
  generation: number;
  sending: boolean;
  pendingImageGenerationTaskIds: string[];
  timeline: AcpTimelineSnapshot;
  turnTimingsByUserMessageId: Record<string, AcpTurnTiming>;
  deferredImageUpdates: Array<{ key: string; event: AcpSessionUpdateEnvelope }>;
  deferredImageCompletions: Array<{
    key: string;
    evidence: ImageGenerationCompletionEvidence;
  }>;
};
const liveSessionSnapshots = new Map<string, LiveSessionSnapshot>();
const SETTLED_RUN_EVENT_GRACE_MS = 5_000;
type SettledRunEventWindow = {
  runId: string;
  kernelId: KernelId;
  generation: number;
  expiresAt: number;
};
const settledRunEventWindows = new Map<string, SettledRunEventWindow>();

function rememberSettledRun(
  sessionKey: string,
  runId: string,
  kernelId: KernelId,
  generation: number,
): void {
  const window = {
    runId,
    kernelId,
    generation,
    expiresAt: Date.now() + SETTLED_RUN_EVENT_GRACE_MS,
  };
  settledRunEventWindows.set(sessionKey, window);
  setTimeout(() => {
    if (settledRunEventWindows.get(sessionKey) === window) settledRunEventWindows.delete(sessionKey);
  }, SETTLED_RUN_EVENT_GRACE_MS);
}

function matchesSettledRun(
  sessionKey: string,
  generation: number,
  eventRunId: string | undefined,
  eventKernelId: KernelId | undefined,
): boolean {
  const window = settledRunEventWindows.get(sessionKey);
  if (!window) return false;
  if (window.expiresAt < Date.now()) {
    settledRunEventWindows.delete(sessionKey);
    return false;
  }
  return window.generation === generation
    && window.runId === eventRunId
    && window.kernelId === eventKernelId;
}

function matchesRunOrSettled(
  sessionKey: string,
  generation: number,
  activeRunId: string | null,
  activeKernelId: KernelId | null,
  eventRunId: string | undefined,
  eventKernelId: KernelId | undefined,
  historical = false,
  allowClaim = false,
): boolean {
  return matchesRun(
    activeRunId,
    activeKernelId,
    eventRunId,
    eventKernelId,
    historical,
    allowClaim,
  ) || (!historical && matchesSettledRun(sessionKey, generation, eventRunId, eventKernelId));
}
export type QueuedAcpPrompt = {
  id: string;
  payload: AcpChatPromptPayload;
  createdAt: number;
};
const MAX_QUEUED_PROMPTS = 5;
const queuedPromptsBySession = new Map<string, QueuedAcpPrompt[]>();
const queueDrainBlockedSessions = new Set<string>();
const drainingQueuedSessions = new Set<string>();
let loadRequestSeq = 0;
const attachmentResolutionsInFlight = new Set<string>();

function deferInactiveImageUpdate(
  snapshot: LiveSessionSnapshot,
  event: AcpSessionUpdateEnvelope,
): LiveSessionSnapshot {
  const start = extractImageGenerationStartFromAcpEnvelope(event);
  const evidence = extractImageGenerationCompletionFromAcpEnvelope(event);
  if (!start && !evidence) return snapshot;
  const key = start
    ? `start:${start.taskId}:${event.historical ? 'history' : 'live'}`
    : `completion:${imageGenerationEvidenceKey(evidence!)}`;
  const existingIndex = snapshot.deferredImageUpdates.findIndex((entry) => entry.key === key);
  const deferredImageUpdates = [...snapshot.deferredImageUpdates];
  const entry = { key, event };
  if (existingIndex >= 0) deferredImageUpdates[existingIndex] = entry;
  else deferredImageUpdates.push(entry);
  return { ...snapshot, deferredImageUpdates };
}

let imageProjectionSeq = 0;

type ImageGenerationProjectionOptions = {
  isCurrent?: () => boolean;
  staleReason?: string;
  transcriptMessageId?: string;
  reservationOwner?: string;
};

type PermissionOutcome = AcpChatRespondPermissionPayload['outcome'];

export type AcpChatSessionState = {
  activeSessionKey: string | null;
  activeRunId: string | null;
  activeTurnId: string | null;
  activeKernelId: KernelId | null;
  workspaceRoot: string | null;
  cwd: string | null;
  generation: number;
  loading: boolean;
  sending: boolean;
  pendingImageGenerationTaskIds: string[];
  cancelling: boolean;
  error: string | null;
  timeline: AcpTimelineSnapshot;
  turnTimingsByUserMessageId: Record<string, AcpTurnTiming>;
  queuedPrompts: QueuedAcpPrompt[];
  prepareLocalSession: (input: AcpChatLoadPayload) => void;
  loadSession: (input: AcpChatLoadPayload) => Promise<boolean>;
  sendPrompt: (input: AcpChatPromptPayload) => Promise<boolean>;
  enqueuePrompt: (input: AcpChatPromptPayload) => boolean;
  removeQueuedPrompt: (id: string) => void;
  drainQueuedPrompts: (sessionKey: string, generation: number) => Promise<void>;
  setConfigOption: (configId: string, value: string | boolean) => Promise<boolean>;
  cancel: () => Promise<void>;
  respondPermission: (requestId: string, optionId: string) => Promise<void>;
  applyUpdateEnvelope: (event: AcpSessionUpdateEnvelope) => void;
  applyPermissionRequest: (event: AcpPermissionRequestEnvelope) => void;
  applyPermissionResolution: (event: {
    sessionKey: string;
    generation: number;
    conversationId?: string;
    runId: string;
    kernelId?: KernelId;
    eventSeq?: number;
    requestId: string;
    status: PermissionItem['status'];
  }) => void;
  recordImageGenerationStart: (event: AcpSessionUpdateEnvelope) => void;
  projectImageGenerationCompletion: (event: ImageGenerationCompletionEvidence, options?: ImageGenerationProjectionOptions) => Promise<void>;
  clearError: () => void;
};

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return fallback;
}

function failedOperationMessage(result: AcpChatOperationResult, fallback: string): string {
  return result.error || fallback;
}

function permissionOutcome(optionId: string): PermissionOutcome {
  return optionId === CANCEL_PERMISSION_OPTION_ID
    ? { outcome: 'cancelled' }
    : { outcome: 'selected', optionId };
}

function permissionStatus(outcome: PermissionOutcome): PermissionItem['status'] {
  return outcome.outcome === 'cancelled' ? 'cancelled' : 'selected';
}

function applyPermissionRequestToTimeline(
  timeline: AcpTimelineSnapshot,
  event: AcpPermissionRequestEnvelope,
): AcpTimelineSnapshot {
  const toolCallId = event.request.toolCall?.toolCallId;
  const id = `permission:${event.requestId}`;
  const item: PermissionItem = {
    kind: 'permission',
    id,
    requestId: event.requestId,
    toolCallId,
    title: event.request.toolCall?.title ?? toolCallId ?? 'Permission request',
    options: event.request.options.map((option) => ({
      optionId: option.optionId,
      name: option.name,
      kind: option.kind,
    })),
    status: 'pending',
  };
  return {
    ...timeline,
    itemOrder: timeline.itemOrder.includes(id) ? timeline.itemOrder : [...timeline.itemOrder, id],
    itemsById: { ...timeline.itemsById, [id]: item },
    openMessageSegments: {},
  };
}

function captureLiveSession(state: AcpChatSessionState): void {
  if (
    (!state.sending && state.pendingImageGenerationTaskIds.length === 0)
    || !state.activeSessionKey
  ) return;
  const existing = liveSessionSnapshots.get(state.activeSessionKey);
  liveSessionSnapshots.set(state.activeSessionKey, {
    sessionKey: state.activeSessionKey,
    activeRunId: state.activeRunId,
    activeTurnId: state.activeTurnId,
    activeKernelId: state.activeKernelId,
    workspaceRoot: state.workspaceRoot,
    cwd: state.cwd,
    generation: state.generation,
    sending: state.sending,
    pendingImageGenerationTaskIds: state.pendingImageGenerationTaskIds,
    timeline: state.timeline,
    turnTimingsByUserMessageId: state.turnTimingsByUserMessageId,
    deferredImageUpdates: existing?.deferredImageUpdates ?? [],
    deferredImageCompletions: existing?.deferredImageCompletions ?? [],
  });
}

function compatSession(sessionKey: string): ImageGenerationCompatSession {
  const existing = imageGenerationCompatSessions.get(sessionKey);
  if (existing) return existing;

  const created: ImageGenerationCompatSession = {
    taskStartedAt: 0,
    replayTaskStartedAt: 0,
    taskIds: new Set<string>(),
    replayTaskIds: new Set<string>(),
    taskToolCallIds: new Map<string, string>(),
    replayTaskToolCallIds: new Map<string, string>(),
    delivered: new Set<string>(),
    reservations: new Map<string, string>(),
    authoritativeCaptions: new Map<string, { text: string; priority: number }>(),
  };
  imageGenerationCompatSessions.set(sessionKey, created);
  return created;
}

function resetImageGenerationCompatSession(sessionKey: string): void {
  imageGenerationCompatSessions.delete(sessionKey);
}

function hasFreshImageGenerationContext(
  sessionKey: string,
  now = Date.now(),
  includeReplay = false,
): boolean {
  const session = imageGenerationCompatSessions.get(sessionKey);
  if (!session) return false;
  const anchors = includeReplay ? [session.replayTaskStartedAt] : [session.taskStartedAt];
  return anchors.some((startedAt) => startedAt > 0 && now - startedAt <= IMAGE_GENERATION_COMPAT_WINDOW_MS);
}

function reserveDelivery(
  sessionKey: string,
  key: string,
  owner: string,
  allowSupersede: boolean,
): boolean {
  const session = compatSession(sessionKey);
  if (session.delivered.has(key)) return false;
  if (session.reservations.has(key) && !allowSupersede) return false;
  session.reservations.set(key, owner);
  return true;
}

function ownsDeliveryReservation(sessionKey: string, key: string, owner: string): boolean {
  return imageGenerationCompatSessions.get(sessionKey)?.reservations.get(key) === owner;
}

function releaseDelivery(sessionKey: string, key: string, owner: string): void {
  const session = imageGenerationCompatSessions.get(sessionKey);
  if (session?.reservations.get(key) === owner) session.reservations.delete(key);
}

function commitDelivery(sessionKey: string, key: string, owner: string): void {
  const session = imageGenerationCompatSessions.get(sessionKey);
  if (session?.reservations.get(key) !== owner) return;
  session.reservations.delete(key);
  session.delivered.add(key);
}

function imageGenerationTaskIdFromSessionKey(sessionKey: string | undefined): string | null {
  const match = sessionKey?.match(/^image_generate:([0-9a-f-]{36})(?::|$)/i);
  return match?.[1] ?? null;
}

function deferInactiveImageGenerationCompletion(
  activeSessionKey: string | null,
  evidence: ImageGenerationCompletionEvidence,
): boolean {
  const taskId = evidence.taskId ?? imageGenerationTaskIdFromSessionKey(evidence.sessionKey);
  if (!taskId) return false;
  for (const [sessionKey, snapshot] of liveSessionSnapshots) {
    if (
      sessionKey === activeSessionKey
      || !snapshot.pendingImageGenerationTaskIds.includes(taskId)
    ) continue;
    const key = imageGenerationEvidenceKey(evidence);
    const deferredImageCompletions = snapshot.deferredImageCompletions.filter(
      (entry) => entry.key !== key,
    );
    deferredImageCompletions.push({ key, evidence });
    liveSessionSnapshots.set(sessionKey, { ...snapshot, deferredImageCompletions });
    return true;
  }
  return false;
}

function resolveImageGenerationProjectionSession(
  state: AcpChatSessionState,
  evidence: ImageGenerationCompletionEvidence,
): string | null {
  const activeSessionKey = state.activeSessionKey;
  if (!activeSessionKey) return null;
  const session = imageGenerationCompatSessions.get(activeSessionKey);
  const taskIds = usesReplayImageGenerationContext(evidence)
    ? session?.replayTaskIds
    : session?.taskIds;
  const taskId = evidence.taskId ?? imageGenerationTaskIdFromSessionKey(evidence.sessionKey);
  if (taskId) return taskIds?.has(taskId) ? activeSessionKey : null;
  if (!evidence.sessionKey || evidence.sessionKey === activeSessionKey) return activeSessionKey;
  return null;
}

function imageGenerationCaptionPriority(source: ImageGenerationCompletionEvidence['source']): number {
  if (source === 'acp-session-update') return 3;
  if (source === 'transcript-history') return 1;
  return 2;
}

function usesReplayImageGenerationContext(evidence: ImageGenerationCompletionEvidence): boolean {
  return !!evidence.historical
    && (evidence.source === 'acp-session-update' || evidence.source === 'transcript-history');
}

function recordImageGenerationStartAnchor(
  session: ImageGenerationCompatSession,
  start: ImageGenerationTaskStart,
  replay: boolean,
): void {
  if (replay) {
    session.lastReplayTaskId = start.taskId;
    if (!start.toolCallId) return;
    session.replayTaskToolCallIds.set(start.taskId, start.toolCallId);
    session.lastReplayToolCallId = start.toolCallId;
    return;
  }
  session.lastTaskId = start.taskId;
  if (!start.toolCallId) return;
  session.taskToolCallIds.set(start.taskId, start.toolCallId);
  session.lastTaskToolCallId = start.toolCallId;
}

function existingToolAnchorId(state: AcpChatSessionState, toolCallId: string | undefined): string | undefined {
  if (!toolCallId) return undefined;
  const itemId = `tool:${toolCallId}`;
  return state.timeline.itemsById[itemId]?.kind === 'tool-call' ? itemId : undefined;
}

function imageGenerationAnchorItemId(
  state: AcpChatSessionState,
  sessionKey: string,
  evidence: ImageGenerationCompletionEvidence,
): string | undefined {
  const session = imageGenerationCompatSessions.get(sessionKey);
  const replay = usesReplayImageGenerationContext(evidence);
  const taskId = evidence.taskId ?? imageGenerationTaskIdFromSessionKey(evidence.sessionKey);
  const candidates = [
    evidence.toolCallId,
    taskId ? (replay ? session?.replayTaskToolCallIds : session?.taskToolCallIds)?.get(taskId) : undefined,
    replay ? session?.lastReplayToolCallId : session?.lastTaskToolCallId,
  ];

  for (const candidate of candidates) {
    const anchorId = existingToolAnchorId(state, candidate);
    if (anchorId) return anchorId;
  }
  return undefined;
}

function recordProjectionTrace(input: {
  event: string;
  sessionKey?: string | null;
  generation?: number;
  details?: Record<string, unknown>;
}): void {
  void hostApi.diagnostics.recordAcpTrace({
    event: input.event,
    direction: 'projection',
    ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
    ...(typeof input.generation === 'number' ? { generation: input.generation } : {}),
    ...(input.details ? { details: input.details } : {}),
  }).catch(() => undefined);
}

function projectionTraceDetails(
  evidence: ImageGenerationCompletionEvidence,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const taskId = evidence.taskId ?? imageGenerationTaskIdFromSessionKey(evidence.sessionKey);
  return {
    source: evidence.source,
    historical: !!evidence.historical,
    candidateCount: evidence.candidates.length,
    ...(taskId ? { taskId } : {}),
    ...extra,
  };
}

function messageIdFromEvidence(key: string): string {
  const encoded: string[] = [];
  for (let index = 0; index < key.length; index += 1) {
    encoded.push(key.charCodeAt(index).toString(16).padStart(4, '0'));
  }
  return `compat:image-generation:${encoded.join('')}`;
}

function replaceSyntheticImageCaptionAtItem(
  timeline: AcpTimelineSnapshot,
  itemId: string,
  caption: string,
): AcpTimelineSnapshot {
  const item = timeline.itemsById[itemId];
  if (item?.kind !== 'message-segment' || item.compat?.source !== 'image-generation') return timeline;
  const markdownIndex = item.parts.findIndex((part) => part.kind === 'markdown');
  const parts = markdownIndex < 0
    ? [{ kind: 'markdown' as const, text: caption }, ...item.parts]
    : item.parts.map((part, index) => (
        index === markdownIndex ? { kind: 'markdown' as const, text: caption } : part
      ));
  return {
    ...timeline,
    itemsById: {
      ...timeline.itemsById,
      [itemId]: { ...item, parts },
    },
  };
}

function replaceSyntheticImageCaption(
  timeline: AcpTimelineSnapshot,
  key: string,
  caption: string,
): AcpTimelineSnapshot {
  return replaceSyntheticImageCaptionAtItem(timeline, `${messageIdFromEvidence(key)}:0`, caption);
}

function matchingSyntheticImageItemId(
  timeline: AcpTimelineSnapshot,
  imageParts: RenderPart[],
): string | undefined {
  const identities = imageParts.flatMap((part) => (
    part.kind === 'image' && part.mediaIdentity ? [part.mediaIdentity] : []
  )).sort();
  if (identities.length === 0) return undefined;
  const identityKey = JSON.stringify(identities);
  return timeline.itemOrder.find((itemId) => {
    const item = timeline.itemsById[itemId];
    if (item?.kind !== 'message-segment' || item.compat?.source !== 'image-generation') return false;
    const existingIdentities = item.parts.flatMap((part) => (
      part.kind === 'image' && part.mediaIdentity ? [part.mediaIdentity] : []
    )).sort();
    return JSON.stringify(existingIdentities) === identityKey;
  });
}

function isCurrentAction(
  state: AcpChatSessionState,
  sessionKey: string,
  generation: number,
): boolean {
  return state.activeSessionKey === sessionKey && state.generation === generation;
}

function matchesRun(
  activeRunId: string | null,
  activeKernelId: KernelId | null,
  eventRunId: string | undefined,
  eventKernelId: KernelId | undefined,
  historical = false,
  allowClaim = false,
): boolean {
  if (historical) return true;
  // Live updates originate only from canonical KernelEvent envelopes. Missing
  // identity is rejected instead of being treated as a wildcard.
  if (!eventRunId || !eventKernelId) return false;
  if (activeRunId ? activeRunId !== eventRunId : !allowClaim) return false;
  return !activeKernelId || activeKernelId === eventKernelId;
}

function imageCandidateUri(candidate: ImageGenerationMediaCandidate): string {
  return candidate.gatewayUrl ?? candidate.filePath ?? candidate.key;
}

function safeAttachmentName(uri: string): string {
  let value = uri;
  try {
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(uri)) value = new URL(uri).pathname;
  } catch {
    value = uri;
  }
  const name = value.split(/[\\/]/).filter(Boolean).pop() ?? 'attachment';
  const clean = (candidate: string) => Array.from(candidate)
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join('')
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, '')
    .slice(0, 200) || 'attachment';
  try {
    return clean(decodeURIComponent(name));
  } catch {
    return clean(name);
  }
}

function newPendingAttachments(
  previous: AcpTimelineSnapshot,
  next: AcpTimelineSnapshot,
): PendingAttachmentLocation[] {
  const previousRequests = new Set(
    collectPendingAttachments(previous).map(({ attachment, fingerprint }) => (
      JSON.stringify([attachment.attachmentId, fingerprint])
    )),
  );
  return collectPendingAttachments(next).filter(({ attachment, fingerprint }) => (
    !previousRequests.has(JSON.stringify([attachment.attachmentId, fingerprint]))
  ));
}

function attachmentResolvePayload(
  sessionKey: string,
  generation: number,
  location: PendingAttachmentLocation,
): ResolveAttachmentPayload {
  const { reference } = location.attachment;
  return {
    ref: {
      sessionKey,
      generation,
      uri: reference.uri,
      ...(reference.stagingId ? { stagingId: reference.stagingId } : {}),
      ...(reference.transcriptMessageId ? { transcriptMessageId: reference.transcriptMessageId } : {}),
    },
    ...(reference.name ? { name: reference.name } : {}),
    ...(reference.mimeType ? { mimeType: reference.mimeType } : {}),
    ...(typeof reference.size === 'number' ? { size: reference.size } : {}),
  };
}

function resolvePendingAttachments(
  sessionKey: string,
  generation: number,
  locations: PendingAttachmentLocation[],
): void {
  for (const location of locations) {
    const attachmentId = location.attachment.attachmentId;
    const expectedFingerprint = location.fingerprint;
    const inFlightKey = JSON.stringify([sessionKey, generation, attachmentId, expectedFingerprint]);
    if (attachmentResolutionsInFlight.has(inFlightKey)) continue;
    attachmentResolutionsInFlight.add(inFlightKey);

    void hostApi.files.resolveAttachment(attachmentResolvePayload(sessionKey, generation, location))
      .catch((): ResolveAttachmentResult => ({
        ok: false,
        displayName: location.attachment.reference.name,
        error: 'operationFailed',
      }))
      .then((result) => {
        useAcpChatSessionStore.setState((state) => {
          if (!isCurrentAction(state, sessionKey, generation)) return {};
          return {
            timeline: applyAttachmentResolution(state.timeline, {
              attachmentId,
              expectedFingerprint,
              result,
            }),
          };
        });
      })
      .finally(() => attachmentResolutionsInFlight.delete(inFlightKey));
  }
}

function getPendingPermission(
  timeline: AcpTimelineSnapshot,
  requestId: string,
): PermissionItem | null {
  const item = timeline.itemsById[`permission:${requestId}`];
  return item?.kind === 'permission' && item.status === 'pending' ? item : null;
}

function updatePermissionStatus(
  timeline: AcpTimelineSnapshot,
  requestId: string,
  status: PermissionItem['status'],
): AcpTimelineSnapshot {
  const id = `permission:${requestId}`;
  const item = timeline.itemsById[id];
  if (item?.kind !== 'permission') return timeline;

  return {
    ...timeline,
    itemsById: {
      ...timeline.itemsById,
      [id]: { ...item, status },
    },
  };
}

function createOptimisticMessageId(): string {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `user:${random}`;
}

function optimisticPromptParts(input: AcpChatPromptPayload, messageId: string): RenderPart[] {
  const parts: RenderPart[] = [];
  const text = input.message?.trim();
  if (text) parts.push({ kind: 'markdown', text });

  for (const [mediaIndex, item] of (input.media ?? []).entries()) {
    parts.push(createPendingAttachment({
      messageId,
      segmentIndex: 0,
      blockIndex: (text ? 1 : 0) + mediaIndex,
      uri: item.filePath,
      name: item.fileName ?? item.filePath,
      ...(item.mimeType ? { mimeType: item.mimeType } : {}),
      stagingId: item.stagingId,
    }));
  }

  return parts.length > 0 ? parts : [{ kind: 'markdown', text: '' }];
}

function optimisticPromptTextBlocks(input: AcpChatPromptPayload): string[] {
  const text = input.message?.trim();
  return [
    ...(text ? [text] : []),
    ...(input.media ?? []).flatMap((item) => (
      item.mimeType?.startsWith('image/')
        ? []
        : [canonicalResourceLinkPromptText(item.filePath)]
    )),
  ];
}

function appendOptimisticUserSegment(
  timeline: AcpTimelineSnapshot,
  input: AcpChatPromptPayload,
  messageId: string,
): AcpTimelineSnapshot {
  const existingId = timeline.itemOrder.find((itemId) => {
    const item = timeline.itemsById[itemId];
    return item?.kind === 'message-segment' && item.role === 'user' && item.messageId === messageId;
  });
  const id = existingId ?? `${messageId}:0`;
  const item: MessageSegmentItem = {
    kind: 'message-segment',
    id,
    role: 'user',
    messageId,
    segmentIndex: 0,
    parts: optimisticPromptParts(input, messageId),
    userPromptTextBlocks: optimisticPromptTextBlocks(input),
    userPromptTextBlocksOptimistic: true,
    blockCount: 0,
    optimistic: true,
  };

  return {
    ...timeline,
    itemOrder: timeline.itemOrder.includes(id) ? timeline.itemOrder : [...timeline.itemOrder, id],
    itemsById: { ...timeline.itemsById, [id]: item },
    openMessageSegments: { ...timeline.openMessageSegments, [messageId]: id },
    segmentCounts: { ...timeline.segmentCounts, [messageId]: Math.max(timeline.segmentCounts[messageId] ?? 0, 1) },
  };
}

function removePendingOptimisticUserSegment(
  timeline: AcpTimelineSnapshot,
  messageId: string,
): AcpTimelineSnapshot {
  const itemId = timeline.openMessageSegments[messageId];
  const item = itemId ? timeline.itemsById[itemId] : undefined;
  if (item?.kind !== 'message-segment' || item.role !== 'user' || !item.optimistic) return timeline;

  const { [itemId]: _removedItem, ...itemsById } = timeline.itemsById;
  const { [messageId]: _removedOpenSegment, ...openMessageSegments } = timeline.openMessageSegments;
  const { [messageId]: _removedSegmentCount, ...segmentCounts } = timeline.segmentCounts;

  return {
    ...timeline,
    itemOrder: timeline.itemOrder.filter((id) => id !== itemId),
    itemsById,
    openMessageSegments,
    segmentCounts,
  };
}

function applyOperationGeneration(
  state: AcpChatSessionState,
  result: AcpChatOperationResult,
): Pick<AcpChatSessionState, 'generation' | 'timeline'> | Record<string, never> {
  if (result.generation == null) return {};
  return {
    generation: result.generation,
    timeline: { ...state.timeline, loadGeneration: result.generation },
  };
}

export const useAcpChatSessionStore = create<AcpChatSessionState>((set, get) => ({
  activeSessionKey: null,
  activeRunId: null,
  activeTurnId: null,
  activeKernelId: null,
  workspaceRoot: null,
  cwd: null,
  generation: 0,
  loading: false,
  sending: false,
  pendingImageGenerationTaskIds: [],
  cancelling: false,
  error: null,
  timeline: createEmptyAcpTimeline(EMPTY_SESSION_ID, 0),
  turnTimingsByUserMessageId: {},
  queuedPrompts: [],

  prepareLocalSession(input) {
    captureLiveSession(get());
    loadRequestSeq += 1;
    pendingLoadEvents.clear();
    const generation = get().generation;
    resetImageGenerationCompatSession(input.sessionKey);
    set({
      activeSessionKey: input.sessionKey,
      activeRunId: null,
      activeTurnId: null,
      activeKernelId: input.kernelId ?? null,
      workspaceRoot: input.workspaceRoot,
      cwd: input.cwd,
      generation,
      loading: false,
      sending: false,
      pendingImageGenerationTaskIds: [],
      cancelling: false,
      error: null,
      timeline: createEmptyAcpTimeline(input.sessionKey, generation),
      turnTimingsByUserMessageId: {},
      queuedPrompts: queuedPromptsBySession.get(input.sessionKey) ?? [],
    });
  },

  async loadSession(input) {
    captureLiveSession(get());
    const requestId = loadRequestSeq + 1;
    loadRequestSeq = requestId;
    pendingLoadEvents.clear();
    const previousGeneration = get().generation;
    const liveSnapshot = liveSessionSnapshots.get(input.sessionKey);
    if (!liveSnapshot?.pendingImageGenerationTaskIds.length) {
      resetImageGenerationCompatSession(input.sessionKey);
    }
    set({
      activeSessionKey: input.sessionKey,
      activeRunId: liveSnapshot?.activeRunId ?? null,
      activeTurnId: liveSnapshot?.activeTurnId ?? null,
      activeKernelId: liveSnapshot?.activeKernelId ?? input.kernelId ?? null,
      workspaceRoot: input.workspaceRoot,
      cwd: input.cwd,
      generation: liveSnapshot?.generation ?? previousGeneration,
      loading: true,
      sending: liveSnapshot?.sending ?? false,
      pendingImageGenerationTaskIds: liveSnapshot?.pendingImageGenerationTaskIds ?? [],
      cancelling: false,
      error: null,
      timeline: liveSnapshot?.timeline
        ?? createEmptyAcpTimeline(input.sessionKey, previousGeneration),
      turnTimingsByUserMessageId: liveSnapshot?.turnTimingsByUserMessageId ?? {},
      queuedPrompts: queuedPromptsBySession.get(input.sessionKey) ?? [],
    });

    try {
      // Canonical history is available even when every optional runtime is
      // stopped or uninstalled. In that case there is no runtime selection to
      // perform; project SQLite history into the same timeline and keep the
      // composer disabled until a ready kernel is selected.
      const result: AcpChatOperationResult = input.kernelId
        ? await hostApi.chat.selectConversationKernel(input)
        : { success: true, generation: get().generation };
      const state = get();
      if (
        loadRequestSeq !== requestId
        || state.activeSessionKey !== input.sessionKey
        || state.workspaceRoot !== input.workspaceRoot
        || state.cwd !== input.cwd
      ) return false;
      if (!result.success) {
        pendingLoadEvents.clear();
        set({
          activeSessionKey: null,
          activeRunId: null,
          activeTurnId: null,
          activeKernelId: null,
          workspaceRoot: null,
          cwd: null,
          loading: false,
          error: failedOperationMessage(result, 'ACP session load failed'),
        });
        return false;
      }
      const generation = result.generation ?? state.generation;
      const canonicalHistory = input.createIfMissing
        ? null
        : await hostApi.conversations.get(asConversationId(input.sessionKey));
      if (
        loadRequestSeq !== requestId
        || get().activeSessionKey !== input.sessionKey
        || get().workspaceRoot !== input.workspaceRoot
        || get().cwd !== input.cwd
      ) return false;

      const projection = projectConversationHistory(canonicalHistory);
      const currentLiveSnapshot = liveSessionSnapshots.get(input.sessionKey);
      const restorableLiveSnapshot = currentLiveSnapshot?.generation === generation
        ? currentLiveSnapshot
        : undefined;
      let timeline = restorableLiveSnapshot?.timeline
        ?? createEmptyAcpTimeline(input.sessionKey, generation);
      if (!restorableLiveSnapshot) {
        for (const step of projection.steps) {
          if (step.kind === 'update') {
            timeline = applyAcpSessionUpdate(
              timeline,
              step.event.notification,
              { historical: true },
            );
          } else if (step.kind === 'permission-request') {
            timeline = applyPermissionRequestToTimeline(timeline, step.event);
          } else {
            timeline = updatePermissionStatus(timeline, step.requestId, step.status);
          }
        }
        timeline = applyAssistantMessageMetadata(
          timeline,
          projection.assistantMetadataByMessageId,
        );
      }
      if (result.configOptions) {
        timeline = {
          ...timeline,
          metadata: {
            ...timeline.metadata,
            configOptions: result.configOptions,
          },
        };
      }
      const selectedRunId = restorableLiveSnapshot?.activeRunId ?? result.runId ?? null;
      const selectedKernelId = restorableLiveSnapshot?.activeKernelId
        ?? result.kernelId
        ?? input.kernelId
        ?? null;
      const liveEvents = [...(pendingLoadEvents.get(generation) ?? [])]
        .filter(({ event }) => (
          event.sessionKey === input.sessionKey && event.generation === generation
          && matchesRun(
            selectedRunId,
            selectedKernelId,
            event.runId,
            event.kernelId,
          )
        ))
        .sort((left, right) => pendingLoadEventSeq(left) - pendingLoadEventSeq(right));
      for (const pending of liveEvents) {
        if (pending.kind === 'update') {
          timeline = applyAcpSessionUpdate(
            timeline,
            pending.event.notification,
            { historical: !!pending.event.historical },
          );
        } else if (pending.kind === 'permission-request') {
          timeline = applyPermissionRequestToTimeline(timeline, pending.event);
        } else {
          timeline = updatePermissionStatus(
            timeline,
            pending.event.requestId,
            pending.event.status,
          );
        }
      }
      pendingLoadEvents.clear();
      const pendingAttachments = newPendingAttachments(
        createEmptyAcpTimeline(input.sessionKey, generation),
        timeline,
      );
      set({
        activeRunId: selectedRunId,
        activeTurnId: restorableLiveSnapshot?.activeTurnId ?? result.turnId ?? null,
        activeKernelId: selectedKernelId,
        loading: false,
        sending: restorableLiveSnapshot?.sending ?? result.resumedActivePrompt ?? false,
        pendingImageGenerationTaskIds: restorableLiveSnapshot?.pendingImageGenerationTaskIds ?? [],
        error: null,
        generation,
        timeline,
        turnTimingsByUserMessageId: {
          ...projection.turnTimingsByUserMessageId,
          ...(restorableLiveSnapshot?.turnTimingsByUserMessageId ?? {}),
        },
      });
      if (restorableLiveSnapshot) {
        liveSessionSnapshots.set(input.sessionKey, {
          ...restorableLiveSnapshot,
          timeline,
          deferredImageUpdates: [],
          deferredImageCompletions: [],
        });
      } else {
        liveSessionSnapshots.delete(input.sessionKey);
        if (get().sending) captureLiveSession(get());
      }
      resolvePendingAttachments(input.sessionKey, generation, pendingAttachments);
      for (const { event } of restorableLiveSnapshot?.deferredImageUpdates ?? []) {
        get().recordImageGenerationStart(event);
        const evidence = extractImageGenerationCompletionFromAcpEnvelope(event);
        if (evidence) void get().projectImageGenerationCompletion(evidence);
      }
      for (const { evidence } of restorableLiveSnapshot?.deferredImageCompletions ?? []) {
        void get().projectImageGenerationCompletion(evidence);
      }
      const projectedUpdates = projection.steps.flatMap(step => (
        step.kind === 'update' ? [step.event] : []
      ));
      const liveUpdates = liveEvents.flatMap(pending => (
        pending.kind === 'update' ? [pending.event] : []
      ));
      for (const event of [...projectedUpdates, ...liveUpdates]) {
        get().recordImageGenerationStart(event);
        const evidence = extractImageGenerationCompletionFromAcpEnvelope(event);
        if (evidence) void get().projectImageGenerationCompletion(evidence);
      }
      queueMicrotask(() => {
        void get().drainQueuedPrompts(input.sessionKey, generation);
      });
      return true;
    } catch (error) {
      if (loadRequestSeq === requestId) pendingLoadEvents.clear();
      set((state) => (
        loadRequestSeq === requestId
          && state.activeSessionKey === input.sessionKey
          && state.workspaceRoot === input.workspaceRoot
          && state.cwd === input.cwd
          ? {
            activeSessionKey: null,
            activeRunId: null,
            activeTurnId: null,
            activeKernelId: null,
            workspaceRoot: null,
            cwd: null,
            loading: false,
            queuedPrompts: [],
            error: errorMessage(error, 'ACP session load failed'),
          }
          : {}
      ));
      return false;
    }
  },

  async sendPrompt(input) {
    const startState = get();
    const sessionKey = input.sessionKey;
    const generation = startState.generation;
    if (startState.activeSessionKey !== sessionKey) return false;
    settledRunEventWindows.delete(sessionKey);
    queueDrainBlockedSessions.delete(sessionKey);

    const messageId = input.messageId ?? createOptimisticMessageId();
    const kernelId = input.kernelId ?? startState.activeKernelId;
    if (!kernelId) {
      set({ error: 'No execution kernel is selected' });
      return false;
    }
    const runId = input.runId ?? asRunId(messageId);
    const turnId = input.turnId ?? asTurnId(`turn:${createOptimisticMessageId()}`);
    const payload: AcpChatPromptPayload = {
      ...input,
      sessionKey,
      conversationId: input.conversationId ?? asConversationId(sessionKey),
      turnId,
      runId,
      kernelId,
      generation,
      messageId,
    };
    const startedAtMs = Date.now();
    set((state) => (
      isCurrentAction(state, sessionKey, generation)
        ? {
          activeRunId: runId,
          activeTurnId: turnId,
          activeKernelId: kernelId,
          sending: true,
          error: null,
          timeline: appendOptimisticUserSegment(state.timeline, payload, messageId),
          turnTimingsByUserMessageId: {
            ...state.turnTimingsByUserMessageId,
            [messageId]: { source: 'live', status: 'running', startedAtMs },
          },
        }
        : {}
    ));
    const optimisticState = get();
    if (isCurrentAction(optimisticState, sessionKey, generation)) {
      captureLiveSession(optimisticState);
      resolvePendingAttachments(
        sessionKey,
        generation,
        newPendingAttachments(startState.timeline, optimisticState.timeline),
      );
    }
    try {
      const result = await hostApi.chat.sendAcpPrompt(payload);
      const state = get();
      if (result.success) {
        rememberSettledRun(sessionKey, runId, kernelId, result.generation ?? generation);
      } else {
        settledRunEventWindows.delete(sessionKey);
      }
      liveSessionSnapshots.delete(sessionKey);
      if (!isCurrentAction(state, sessionKey, generation)) return result.success;
      const failedTimeline = result.success
        ? state.timeline
        : removePendingOptimisticUserSegment(state.timeline, messageId);
      const { [messageId]: _removedTiming, ...remainingTurnTimings } = state.turnTimingsByUserMessageId;
      set({
        activeRunId: null,
        activeTurnId: null,
        sending: false,
        turnTimingsByUserMessageId: result.success
          ? {
            ...state.turnTimingsByUserMessageId,
            [messageId]: {
              source: 'live',
              status: 'complete',
              durationMs: Math.max(0, Date.now() - startedAtMs),
            },
          }
          : remainingTurnTimings,
        ...(result.success
          ? applyOperationGeneration(state, result)
          : { error: failedOperationMessage(result, 'ACP prompt failed'), timeline: failedTimeline }),
      });
      if (result.success) {
        queueMicrotask(() => {
          void get().drainQueuedPrompts(sessionKey, result.generation ?? generation);
        });
      }
      return result.success;
    } catch (error) {
      settledRunEventWindows.delete(sessionKey);
      liveSessionSnapshots.delete(sessionKey);
      set((state) => (
        isCurrentAction(state, sessionKey, generation)
          ? (() => {
            const { [messageId]: _removedTiming, ...turnTimingsByUserMessageId } = state.turnTimingsByUserMessageId;
            return {
              activeRunId: null,
              activeTurnId: null,
              sending: false,
              error: errorMessage(error, 'ACP prompt failed'),
              timeline: removePendingOptimisticUserSegment(state.timeline, messageId),
              turnTimingsByUserMessageId,
            };
          })()
          : {}
      ));
      return false;
    }
  },

  enqueuePrompt(input) {
    const state = get();
    if (state.activeSessionKey !== input.sessionKey || !state.sending) return false;
    const queue = queuedPromptsBySession.get(input.sessionKey) ?? [];
    if (queue.length >= MAX_QUEUED_PROMPTS) return false;
    const entry: QueuedAcpPrompt = {
      id: createOptimisticMessageId(),
      payload: input,
      createdAt: Date.now(),
    };
    const nextQueue = [...queue, entry];
    queuedPromptsBySession.set(input.sessionKey, nextQueue);
    set({ queuedPrompts: nextQueue });
    return true;
  },

  removeQueuedPrompt(id) {
    const sessionKey = get().activeSessionKey;
    if (!sessionKey) return;
    const queue = queuedPromptsBySession.get(sessionKey) ?? [];
    const nextQueue = queue.filter((entry) => entry.id !== id);
    if (nextQueue.length === queue.length) return;
    if (nextQueue.length > 0) queuedPromptsBySession.set(sessionKey, nextQueue);
    else queuedPromptsBySession.delete(sessionKey);
    set({ queuedPrompts: nextQueue });
  },

  async drainQueuedPrompts(sessionKey, generation) {
    if (drainingQueuedSessions.has(sessionKey) || queueDrainBlockedSessions.has(sessionKey)) return;
    drainingQueuedSessions.add(sessionKey);
    try {
      while (!queueDrainBlockedSessions.has(sessionKey)) {
        const state = get();
        if (
          !isCurrentAction(state, sessionKey, generation)
          || state.loading
          || state.sending
          || state.cancelling
        ) return;
        const queue = queuedPromptsBySession.get(sessionKey) ?? [];
        const [entry, ...remaining] = queue;
        if (!entry) return;
        if (remaining.length > 0) queuedPromptsBySession.set(sessionKey, remaining);
        else queuedPromptsBySession.delete(sessionKey);
        set({ queuedPrompts: remaining });

        const sent = await get().sendPrompt(entry.payload);
        if (!sent) {
          const currentQueue = queuedPromptsBySession.get(sessionKey) ?? [];
          const restoredQueue = [entry, ...currentQueue].slice(0, MAX_QUEUED_PROMPTS);
          queuedPromptsBySession.set(sessionKey, restoredQueue);
          if (get().activeSessionKey === sessionKey) set({ queuedPrompts: restoredQueue });
          return;
        }
        generation = get().generation;
      }
    } finally {
      drainingQueuedSessions.delete(sessionKey);
    }
  },

  async setConfigOption(configId, value) {
    const startState = get();
    const sessionKey = startState.activeSessionKey;
    const generation = startState.generation;
    if (!sessionKey || startState.loading || startState.sending || startState.cancelling) return false;

    const identity = {
      sessionKey,
      conversationId: asConversationId(sessionKey),
      generation,
      ...(startState.activeKernelId ? { kernelId: startState.activeKernelId } : {}),
      ...(startState.activeRunId ? { runId: asRunId(startState.activeRunId) } : {}),
      ...(startState.activeTurnId ? { turnId: asTurnId(startState.activeTurnId) } : {}),
    };
    const payload: AcpChatSetConfigOptionPayload = typeof value === 'boolean'
      ? { ...identity, configId, value, type: 'boolean' }
      : { ...identity, configId, value };
    try {
      const result = await hostApi.chat.setAcpSessionConfigOption(payload);
      const state = get();
      if (!isCurrentAction(state, sessionKey, generation)) return result.success;
      if (!result.success || !result.configOptions) {
        set({ error: failedOperationMessage(result, i18n.t('chat:composer.sessionConfigFailed')) });
        return false;
      }
      set({
        ...applyOperationGeneration(state, result),
        error: null,
        timeline: {
          ...state.timeline,
          metadata: {
            ...state.timeline.metadata,
            configOptions: result.configOptions,
          },
        },
      });
      return true;
    } catch (error) {
      set((state) => (
        isCurrentAction(state, sessionKey, generation)
          ? { error: errorMessage(error, i18n.t('chat:composer.sessionConfigFailed')) }
          : {}
      ));
      return false;
    }
  },

  async cancel() {
    const startState = get();
    const sessionKey = startState.activeSessionKey;
    const generation = startState.generation;
    if (!sessionKey) return;
    queueDrainBlockedSessions.add(sessionKey);

    set({ cancelling: true, error: null });
    try {
      const result = await hostApi.chat.cancelAcpSession({
        sessionKey,
        conversationId: asConversationId(sessionKey),
        generation,
        ...(startState.activeKernelId ? { kernelId: startState.activeKernelId } : {}),
        ...(startState.activeRunId ? { runId: asRunId(startState.activeRunId) } : {}),
        ...(startState.activeTurnId ? { turnId: asTurnId(startState.activeTurnId) } : {}),
      });
      set((state) => {
        if (!isCurrentAction(state, sessionKey, generation)) return {};
        return {
          cancelling: false,
          ...(result.success
            ? applyOperationGeneration(state, result)
            : { error: failedOperationMessage(result, 'ACP cancel failed') }),
        };
      });
    } catch (error) {
      set((state) => (
        isCurrentAction(state, sessionKey, generation)
          ? { cancelling: false, error: errorMessage(error, 'ACP cancel failed') }
          : {}
      ));
    }
  },

  async respondPermission(requestId, optionId) {
    const startState = get();
    const sessionKey = startState.activeSessionKey;
    const generation = startState.generation;
    if (!sessionKey) return;
    if (!getPendingPermission(startState.timeline, requestId)) return;

    const outcome = permissionOutcome(optionId);
    try {
      const result = await hostApi.chat.respondAcpPermission({
        sessionKey,
        conversationId: asConversationId(sessionKey),
        generation,
        ...(startState.activeKernelId ? { kernelId: startState.activeKernelId } : {}),
        ...(startState.activeRunId ? { runId: asRunId(startState.activeRunId) } : {}),
        ...(startState.activeTurnId ? { turnId: asTurnId(startState.activeTurnId) } : {}),
        requestId,
        outcome,
      });
      if (result.success) {
        const liveSnapshot = liveSessionSnapshots.get(sessionKey);
        if (liveSnapshot?.generation === generation && getPendingPermission(liveSnapshot.timeline, requestId)) {
          liveSessionSnapshots.set(sessionKey, {
            ...liveSnapshot,
            timeline: updatePermissionStatus(liveSnapshot.timeline, requestId, permissionStatus(outcome)),
          });
        }
      }
      set((state) => {
        if (!isCurrentAction(state, sessionKey, generation)) return {};
        if (!result.success) {
          return { error: failedOperationMessage(result, 'ACP permission failed') };
        }
        if (!getPendingPermission(state.timeline, requestId)) return {};
        const timeline = updatePermissionStatus(state.timeline, requestId, permissionStatus(outcome));
        const nextGeneration = result.generation ?? state.generation;
        return {
          error: null,
          generation: nextGeneration,
          timeline: result.generation == null ? timeline : { ...timeline, loadGeneration: nextGeneration },
        };
      });
    } catch (error) {
      set((state) => (
        isCurrentAction(state, sessionKey, generation)
          ? { error: errorMessage(error, 'ACP permission failed') }
          : {}
      ));
    }
  },

  recordImageGenerationStart(event) {
    const state = get();
    if (event.sessionKey !== state.activeSessionKey || event.generation !== state.generation) return;

    const start = extractImageGenerationStartFromAcpEnvelope(event);
    if (!start) return;
    recordProjectionTrace({
      event: 'image-generation:start-detected',
      sessionKey: start.sessionKey,
      generation: event.generation,
      details: {
        taskId: start.taskId,
        ...(start.toolCallId ? { toolCallId: start.toolCallId } : {}),
        historical: !!event.historical,
      },
    });
    const session = compatSession(start.sessionKey);
    if (event.historical) {
      session.replayTaskStartedAt = Date.now();
      session.replayTaskIds.add(start.taskId);
      recordImageGenerationStartAnchor(session, start, true);
    } else {
      session.taskStartedAt = Date.now();
      session.taskIds.add(start.taskId);
      recordImageGenerationStartAnchor(session, start, false);
      set((current) => (
        current.activeSessionKey === start.sessionKey
        && current.generation === event.generation
        && !current.pendingImageGenerationTaskIds.includes(start.taskId)
          ? {
            pendingImageGenerationTaskIds: [
              ...current.pendingImageGenerationTaskIds,
              start.taskId,
            ],
          }
          : {}
      ));
    }
  },

  async projectImageGenerationCompletion(evidence, options) {
    const state = get();
    if (options?.isCurrent && !options.isCurrent()) {
      recordProjectionTrace({
        event: 'image-generation:projection-rejected',
        sessionKey: state.activeSessionKey ?? evidence.sessionKey ?? null,
        generation: state.generation,
        details: projectionTraceDetails(evidence, { reason: options.staleReason ?? 'stale-projection' }),
      });
      return;
    }
    const sessionKey = resolveImageGenerationProjectionSession(state, evidence);
    if (!sessionKey) {
      recordProjectionTrace({
        event: 'image-generation:projection-rejected',
        sessionKey: state.activeSessionKey ?? evidence.sessionKey ?? null,
        generation: state.generation,
        details: projectionTraceDetails(evidence, { reason: 'no-session-match' }),
      });
      return;
    }
    if (!hasFreshImageGenerationContext(
      sessionKey,
      Date.now(),
      usesReplayImageGenerationContext(evidence),
    )) {
      recordProjectionTrace({
        event: 'image-generation:projection-rejected',
        sessionKey,
        generation: state.generation,
        details: projectionTraceDetails(evidence, { reason: 'no-fresh-context' }),
      });
      return;
    }
    if (options?.isCurrent && !options.isCurrent()) {
      recordProjectionTrace({
        event: 'image-generation:projection-rejected',
        sessionKey,
        generation: state.generation,
        details: projectionTraceDetails(evidence, { reason: options.staleReason ?? 'stale-projection' }),
      });
      return;
    }
    if (evidence.candidates.length === 0 && !evidence.authoritativeCaption) {
      recordProjectionTrace({
        event: 'image-generation:projection-rejected',
        sessionKey,
        generation: state.generation,
        details: projectionTraceDetails(evidence, { reason: 'no-candidates' }),
      });
      return;
    }

    const generation = state.generation;
    const compat = compatSession(sessionKey);
    const correlatedTaskId = evidence.taskId
      ?? imageGenerationTaskIdFromSessionKey(evidence.sessionKey)
      ?? (usesReplayImageGenerationContext(evidence) ? compat.lastReplayTaskId : compat.lastTaskId);
    const settlePendingTask = (current: AcpChatSessionState): string[] => {
      if (!correlatedTaskId) {
        return usesReplayImageGenerationContext(evidence)
          ? current.pendingImageGenerationTaskIds
          : [];
      }
      return current.pendingImageGenerationTaskIds.filter((taskId) => taskId !== correlatedTaskId);
    };
    const key = imageGenerationEvidenceKey({
      ...evidence,
      sessionKey,
      ...(correlatedTaskId ? { taskId: correlatedTaskId } : {}),
    });
    if (evidence.authoritativeCaption) {
      const captions = compat.authoritativeCaptions;
      const next = { text: evidence.caption, priority: imageGenerationCaptionPriority(evidence.source) };
      const previous = captions.get(key);
      if (!previous || next.priority > previous.priority) captions.set(key, next);
    }
    const reservationOwner = options?.reservationOwner ?? `projection:${imageProjectionSeq += 1}`;
    if (!reserveDelivery(sessionKey, key, reservationOwner, Boolean(options?.reservationOwner))) {
      if (evidence.authoritativeCaption) {
        const preferredCaption = compatSession(sessionKey).authoritativeCaptions.get(key)?.text ?? evidence.caption;
        set((current) => ({
          timeline: replaceSyntheticImageCaption(current.timeline, key, preferredCaption),
        }));
      }
      recordProjectionTrace({
        event: 'image-generation:projection-deduped',
        sessionKey,
        generation,
        details: projectionTraceDetails(evidence),
      });
      if (compat.delivered.has(key)) {
        set((current) => ({
          pendingImageGenerationTaskIds: settlePendingTask(current),
        }));
      }
      return;
    }

    const resolvedCandidates: Array<{
      candidate: ImageGenerationMediaCandidate;
      identity: string;
      mimeType: string;
      target: Extract<ResolveAttachmentResult, { ok: true }>['target'];
    }> = [];
    let unresolvedCandidateCount = 0;
    for (const candidate of evidence.candidates) {
      let result: ResolveAttachmentResult;
      try {
        result = await hostApi.files.resolveAttachment({
          ref: {
            sessionKey,
            generation,
            uri: imageCandidateUri(candidate),
            ...(options?.transcriptMessageId ? { transcriptMessageId: options.transcriptMessageId } : {}),
          },
          ...(candidate.mimeType ? { mimeType: candidate.mimeType } : {}),
        });
      } catch {
        result = { ok: false, displayName: safeAttachmentName(candidate.key), error: 'operationFailed' };
      }
      recordProjectionTrace({
        event: result.ok ? 'image-generation:resolution-available' : 'image-generation:resolution-unavailable',
        sessionKey,
        generation,
        details: projectionTraceDetails(evidence, {
          reason: result.ok ? 'available' : result.error,
          evidenceHash: canonicalDiagnosticHash(evidence.evidenceId),
          ...(result.ok ? { identityHash: canonicalDiagnosticHash(result.identity) } : {}),
        }),
      });
      if (result.ok) {
        if (!resolvedCandidates.some((entry) => entry.identity === result.identity)) {
          resolvedCandidates.push({
            candidate,
            identity: result.identity,
            mimeType: result.mimeType,
            target: result.target,
          });
        }
      } else {
        unresolvedCandidateCount += 1;
      }
      if (
        !ownsDeliveryReservation(sessionKey, key, reservationOwner)
        || (options?.isCurrent && !options.isCurrent())
        || !isCurrentAction(get(), sessionKey, generation)
      ) {
        releaseDelivery(sessionKey, key, reservationOwner);
        recordProjectionTrace({
          event: 'image-generation:projection-dropped',
          sessionKey,
          generation,
          details: projectionTraceDetails(evidence, { reason: options?.staleReason ?? 'stale-resolution' }),
        });
        return;
      }
    }

    let thumbnails: MediaThumbnailResult = {};
    try {
      const paths = resolvedCandidates.flatMap(({ identity, mimeType, target }) => (
        target.kind === 'local'
          ? [{ attachmentFileRef: target.ref, key: identity, mimeType }]
          : []
      ));
      if (paths.length > 0) thumbnails = await hostApi.media.thumbnails({ paths });
      recordProjectionTrace({
        event: 'image-generation:thumbnail-result',
        sessionKey,
        generation,
        details: projectionTraceDetails(evidence, {
          previewCount: resolvedCandidates.filter(({ identity }) => Boolean(thumbnails[identity]?.preview)).length,
        }),
      });
    } catch {
      thumbnails = {};
      recordProjectionTrace({
        event: 'image-generation:thumbnail-result',
        sessionKey,
        generation,
        details: projectionTraceDetails(evidence, { previewCount: 0, error: true }),
      });
    }

    const latest = get();
    if (!ownsDeliveryReservation(sessionKey, key, reservationOwner) || (options?.isCurrent && !options.isCurrent())) {
      releaseDelivery(sessionKey, key, reservationOwner);
      recordProjectionTrace({
        event: 'image-generation:projection-dropped',
        sessionKey,
        generation,
        details: projectionTraceDetails(evidence, { reason: options?.staleReason ?? 'stale-projection' }),
      });
      return;
    }
    if (latest.activeSessionKey !== sessionKey || latest.generation !== generation) {
      releaseDelivery(sessionKey, key, reservationOwner);
      recordProjectionTrace({
        event: 'image-generation:projection-dropped',
        sessionKey,
        generation,
        details: projectionTraceDetails(evidence, {
          reason: 'stale-generation',
          latestGeneration: latest.generation,
        }),
      });
      return;
    }

    const imageParts: RenderPart[] = [];
    for (const { candidate, identity, mimeType } of resolvedCandidates) {
      const resolved = thumbnails[identity];
      if (!resolved?.preview) continue;
      imageParts.push({
        kind: 'image',
        source: resolved.preview,
        mimeType: candidate.mimeType ?? mimeType,
        alt: i18n.t('chat:acp.image'),
        mediaIdentity: identity,
      });
    }

    const missingCount = unresolvedCandidateCount + resolvedCandidates.length - imageParts.length;
    if (missingCount > 0) releaseDelivery(sessionKey, key, reservationOwner);
    const authoritativeCaption = imageGenerationCompatSessions.get(sessionKey)?.authoritativeCaptions.get(key)?.text;
    const caption = authoritativeCaption
      ? authoritativeCaption
      : imageParts.length === 0
        ? i18n.t('chat:imageGeneration.previewUnavailable')
        : missingCount > 0
          ? i18n.t('chat:imageGeneration.generatedReadyWithMissing')
          : i18n.t('chat:imageGeneration.generatedReady');
    const duplicateItemId = matchingSyntheticImageItemId(latest.timeline, imageParts);
    if (duplicateItemId) {
      const existingItem = latest.timeline.itemsById[duplicateItemId];
      const existingKey = existingItem?.kind === 'message-segment' ? existingItem.compat?.evidenceId : undefined;
      const captions = imageGenerationCompatSessions.get(sessionKey)?.authoritativeCaptions;
      const currentCaption = captions?.get(key);
      const existingCaption = existingKey ? captions?.get(existingKey) : undefined;
      if (existingKey && currentCaption && (!existingCaption || currentCaption.priority > existingCaption.priority)) {
        captions?.set(existingKey, currentCaption);
        set((current) => ({
          timeline: replaceSyntheticImageCaptionAtItem(current.timeline, duplicateItemId, currentCaption.text),
          pendingImageGenerationTaskIds: settlePendingTask(current),
        }));
      }
      set((current) => ({
        pendingImageGenerationTaskIds: settlePendingTask(current),
      }));
      if (missingCount === 0) commitDelivery(sessionKey, key, reservationOwner);
      else releaseDelivery(sessionKey, key, reservationOwner);
      recordProjectionTrace({
        event: 'image-generation:projection-deduped',
        sessionKey,
        generation,
        details: projectionTraceDetails(evidence, { reason: 'resolved-media-identity' }),
      });
      return;
    }
    const parts: RenderPart[] = [{ kind: 'markdown', text: caption }, ...imageParts];
    const afterItemId = imageGenerationAnchorItemId(latest, sessionKey, evidence);

    set((current) => {
      if (current.activeSessionKey !== sessionKey || current.generation !== generation) return {};
      return {
        timeline: appendSyntheticAssistantMessage(current.timeline, {
          messageId: messageIdFromEvidence(key),
          evidenceId: key,
          parts,
          afterItemId,
        }),
        pendingImageGenerationTaskIds: settlePendingTask(current),
      };
    });
    if (missingCount === 0) commitDelivery(sessionKey, key, reservationOwner);
    recordProjectionTrace({
      event: 'image-generation:projection-appended',
      sessionKey,
      generation,
      details: projectionTraceDetails(evidence, { imageCount: imageParts.length, missingCount }),
    });
  },

  applyUpdateEnvelope(event) {
    const state = get();
    if (state.loading) {
      if (event.sessionKey === state.activeSessionKey) {
        if (!matchesRunOrSettled(
          event.sessionKey,
          event.generation,
          state.activeRunId,
          state.activeKernelId,
          event.runId,
          event.kernelId,
          !!event.historical,
          true,
        )) return;
        queuePendingLoadEvent(event.generation, { kind: 'update', event });
      } else {
        const liveSnapshot = liveSessionSnapshots.get(event.sessionKey);
        if (
          liveSnapshot?.generation === event.generation
          && matchesRunOrSettled(
            event.sessionKey,
            event.generation,
            liveSnapshot.activeRunId,
            liveSnapshot.activeKernelId,
            event.runId,
            event.kernelId,
            !!event.historical,
            liveSnapshot.sending,
          )
        ) {
          liveSessionSnapshots.set(event.sessionKey, deferInactiveImageUpdate({
            ...liveSnapshot,
            activeRunId: liveSnapshot.activeRunId ?? event.runId ?? null,
            activeKernelId: liveSnapshot.activeKernelId ?? event.kernelId ?? null,
            timeline: applyAcpSessionUpdate(
              liveSnapshot.timeline,
              event.notification,
              { historical: !!event.historical },
            ),
          }, event));
        }
      }
      return;
    }
    if (event.sessionKey !== state.activeSessionKey || event.generation !== state.generation) {
      const liveSnapshot = liveSessionSnapshots.get(event.sessionKey);
      if (
        liveSnapshot?.generation === event.generation
        && matchesRunOrSettled(
          event.sessionKey,
          event.generation,
          liveSnapshot.activeRunId,
          liveSnapshot.activeKernelId,
          event.runId,
          event.kernelId,
          !!event.historical,
          liveSnapshot.sending,
        )
      ) {
        liveSessionSnapshots.set(event.sessionKey, deferInactiveImageUpdate({
          ...liveSnapshot,
          activeRunId: liveSnapshot.activeRunId ?? event.runId ?? null,
          activeKernelId: liveSnapshot.activeKernelId ?? event.kernelId ?? null,
          timeline: applyAcpSessionUpdate(
            liveSnapshot.timeline,
            event.notification,
            { historical: !!event.historical },
          ),
        }, event));
      }
      return;
    }
    if (!matchesRunOrSettled(
      event.sessionKey,
      event.generation,
      state.activeRunId,
      state.activeKernelId,
      event.runId,
      event.kernelId,
      !!event.historical,
      state.sending,
    )) return;
    const timeline = applyAcpSessionUpdate(state.timeline, event.notification, { historical: !!event.historical });
    const pending = newPendingAttachments(state.timeline, timeline);
    const settledDelivery = !event.historical && matchesSettledRun(
      event.sessionKey,
      event.generation,
      event.runId,
      event.kernelId,
    );
    const activeRunId = settledDelivery ? state.activeRunId : state.activeRunId ?? event.runId ?? null;
    const activeKernelId = state.activeKernelId ?? event.kernelId ?? null;
    set({ timeline, activeRunId, activeKernelId });
    if (state.sending) {
      const liveSnapshot = liveSessionSnapshots.get(event.sessionKey);
      if (liveSnapshot?.generation === event.generation) {
        liveSessionSnapshots.set(event.sessionKey, {
          ...liveSnapshot,
          activeRunId,
          activeKernelId,
          timeline,
        });
      }
    }
    resolvePendingAttachments(event.sessionKey, event.generation, pending);
    get().recordImageGenerationStart(event);
    const evidence = extractImageGenerationCompletionFromAcpEnvelope(event);
    if (evidence) void get().projectImageGenerationCompletion(evidence);
  },

  applyPermissionRequest(event) {
    const state = get();
    if (state.loading && event.sessionKey === state.activeSessionKey) {
      if (!matchesRun(
        state.activeRunId,
        state.activeKernelId,
        event.runId,
        event.kernelId,
        false,
        true,
      )) return;
      queuePendingLoadEvent(event.generation, { kind: 'permission-request', event });
      return;
    }
    if (event.sessionKey !== state.activeSessionKey || event.generation !== state.generation) {
      const liveSnapshot = liveSessionSnapshots.get(event.sessionKey);
      if (
        liveSnapshot?.generation === event.generation
        && matchesRun(
          liveSnapshot.activeRunId,
          liveSnapshot.activeKernelId,
          event.runId,
          event.kernelId,
          false,
          liveSnapshot.sending,
        )
      ) {
        liveSessionSnapshots.set(event.sessionKey, {
          ...liveSnapshot,
          activeRunId: liveSnapshot.activeRunId ?? event.runId ?? null,
          activeKernelId: liveSnapshot.activeKernelId ?? event.kernelId ?? null,
          timeline: applyPermissionRequestToTimeline(liveSnapshot.timeline, event),
        });
      }
      return;
    }
    if (!matchesRun(
      state.activeRunId,
      state.activeKernelId,
      event.runId,
      event.kernelId,
      false,
      state.sending,
    )) return;

    const timeline = applyPermissionRequestToTimeline(state.timeline, event);
    const activeRunId = state.activeRunId ?? event.runId ?? null;
    const activeKernelId = state.activeKernelId ?? event.kernelId ?? null;
    set({ timeline, activeRunId, activeKernelId });
    if (state.sending) {
      const liveSnapshot = liveSessionSnapshots.get(event.sessionKey);
      if (liveSnapshot?.generation === event.generation) {
        liveSessionSnapshots.set(event.sessionKey, {
          ...liveSnapshot,
          activeRunId,
          activeKernelId,
          timeline,
        });
      }
    }
  },

  applyPermissionResolution(event) {
    const state = get();
    if (state.loading && event.sessionKey === state.activeSessionKey) {
      if (!matchesRun(
        state.activeRunId,
        state.activeKernelId,
        event.runId,
        event.kernelId,
        false,
        true,
      )) return;
      queuePendingLoadEvent(event.generation, { kind: 'permission-resolved', event });
      return;
    }
    if (event.sessionKey !== state.activeSessionKey || event.generation !== state.generation) {
      const liveSnapshot = liveSessionSnapshots.get(event.sessionKey);
      if (
        liveSnapshot?.generation === event.generation
        && matchesRun(
          liveSnapshot.activeRunId,
          liveSnapshot.activeKernelId,
          event.runId,
          event.kernelId,
          false,
          liveSnapshot.sending,
        )
      ) {
        liveSessionSnapshots.set(event.sessionKey, {
          ...liveSnapshot,
          timeline: updatePermissionStatus(
            liveSnapshot.timeline,
            event.requestId,
            event.status,
          ),
        });
      }
      return;
    }
    if (!matchesRun(
      state.activeRunId,
      state.activeKernelId,
      event.runId,
      event.kernelId,
      false,
      state.sending,
    )) return;
    const timeline = updatePermissionStatus(state.timeline, event.requestId, event.status);
    set({ timeline });
    const liveSnapshot = liveSessionSnapshots.get(event.sessionKey);
    if (liveSnapshot?.generation === event.generation) {
      liveSessionSnapshots.set(event.sessionKey, { ...liveSnapshot, timeline });
    }
  },

  clearError() {
    set({ error: null });
  },
}));

let acpChatSubscribed = false;

export function ensureAcpChatSubscriptions(): void {
  if (acpChatSubscribed) return;
  acpChatSubscribed = true;
  hostEvents.onKernelEvent((event) => {
    const update = kernelEventToAcpUpdate(event);
    if (update) useAcpChatSessionStore.getState().applyUpdateEnvelope(update);
    const permission = kernelEventToPermission(event);
    if (permission) useAcpChatSessionStore.getState().applyPermissionRequest(permission);
    const resolution = kernelEventToPermissionResolution(event);
    if (resolution) useAcpChatSessionStore.getState().applyPermissionResolution(resolution);
  });
  hostEvents.onChatRuntimeEvent((event) => {
    const evidence = extractImageGenerationCompletionFromRuntimeEvent(event);
    const state = useAcpChatSessionStore.getState();
    if (
      evidence
      && !deferInactiveImageGenerationCompletion(state.loading ? null : state.activeSessionKey, evidence)
    ) void state.projectImageGenerationCompletion(evidence);
  });
}
