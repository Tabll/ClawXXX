import { stripAcpWorkingDirectoryPrefix } from '@shared/chat/session-title';
import type { RawMessage } from '@shared/chat/types';
import { acpUserTurns, turnMatchKey, type AcpUserTurn } from './openclaw-media-compat';
import type { AcpTimelineSnapshot, AssistantMessageMetadata, MessageSegmentItem } from './timeline-types';

type TranscriptTurn = {
  normalizedUserText: string;
  userOccurrenceFromTail: number;
  messages: RawMessage[];
};

type AcpAssistantGroup = {
  messageId: string;
  itemIds: string[];
  normalizedText: string;
};

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function tokenValue(record: Record<string, unknown> | null, keys: string[]): number | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  }
  return undefined;
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((entry) => {
    const block = recordValue(entry);
    return block?.type === 'text' && typeof block.text === 'string' ? [block.text] : [];
  }).join('\n');
}

function normalizeUserText(text: string): string {
  return stripAcpWorkingDirectoryPrefix(text).replace(/\r\n/g, '\n').trim();
}

function normalizeAssistantText(text: string): string {
  return text
    .replace(/^\s*MEDIA:\s*.*$/gim, '')
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
}

function isInternalInterSessionUser(message: RawMessage): boolean {
  const provenance = recordValue((message as RawMessage & { provenance?: unknown }).provenance);
  if (typeof provenance?.kind === 'string' && provenance.kind.toLowerCase() === 'inter_session') return true;
  return /^\[Inter-session message\]\s/.test(textFromContent(message.content));
}

function assignOccurrencesFromTail(turns: Array<Omit<TranscriptTurn, 'userOccurrenceFromTail'>>): TranscriptTurn[] {
  const occurrences = new Map<string, number>();
  const result = new Array<TranscriptTurn>(turns.length);
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    const occurrence = (occurrences.get(turn.normalizedUserText) ?? 0) + 1;
    occurrences.set(turn.normalizedUserText, occurrence);
    result[index] = { ...turn, userOccurrenceFromTail: occurrence };
  }
  return result;
}

function transcriptTurns(messages: RawMessage[]): TranscriptTurn[] {
  const turns: Array<Omit<TranscriptTurn, 'userOccurrenceFromTail'>> = [];
  let current: (typeof turns)[number] | null = null;
  for (const message of messages) {
    if (message.role === 'user' && !isInternalInterSessionUser(message)) {
      current = { normalizedUserText: normalizeUserText(textFromContent(message.content)), messages: [message] };
      turns.push(current);
    } else if (current) {
      current.messages.push(message);
    }
  }
  return assignOccurrencesFromTail(turns);
}

function assistantMetadata(message: RawMessage): AssistantMessageMetadata | undefined {
  const details = recordValue(message.details);
  const usage = recordValue(message.usage) ?? recordValue(details?.usage);
  const inputTokens = tokenValue(usage, [
    'input', 'inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens', 'inputTokenCount', 'input_token_count',
  ]);
  const outputTokens = tokenValue(usage, [
    'output', 'outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens', 'outputTokenCount', 'output_token_count',
  ]);
  const cacheReadTokens = tokenValue(usage, [
    'cacheRead', 'cache_read', 'cacheReadTokens', 'cache_read_tokens', 'cacheReadTokenCount', 'cache_read_token_count',
  ]);
  const cacheWriteTokens = tokenValue(usage, [
    'cacheWrite', 'cache_write', 'cacheWriteTokens', 'cache_write_tokens', 'cacheWriteTokenCount', 'cache_write_token_count',
  ]);
  const totalTokens = tokenValue(usage, ['total', 'totalTokens', 'total_tokens', 'totalTokenCount', 'total_token_count']);
  const normalizedUsage = [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens]
    .some((value) => value !== undefined)
    ? {
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
      ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
      ...(totalTokens !== undefined ? { totalTokens } : {}),
    }
    : undefined;
  const rawTimestamp = typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)
    ? message.timestamp
    : undefined;
  const timestamp = rawTimestamp !== undefined && rawTimestamp > 0 && rawTimestamp < 100_000_000_000
    ? rawTimestamp * 1000
    : rawTimestamp;
  const model = stringValue(message.modelRef) ?? stringValue(message.model) ?? stringValue(details?.model);
  const provider = stringValue(message.provider) ?? stringValue(details?.provider);
  if (timestamp === undefined && !model && !provider && !normalizedUsage) return undefined;
  return {
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
    ...(normalizedUsage ? { usage: normalizedUsage } : {}),
  };
}

function timelineAssistantGroups(snapshot: AcpTimelineSnapshot): Map<string, AcpAssistantGroup[]> {
  const turns = acpUserTurns(snapshot);
  const turnByUserMessageId = new Map<string, AcpUserTurn>();
  for (const turn of turns) {
    for (const messageId of turn.messageIds) turnByUserMessageId.set(messageId, turn);
  }
  const groupsByTurnId = new Map<string, AcpAssistantGroup[]>();
  let currentTurn: AcpUserTurn | null = null;
  for (const itemId of snapshot.itemOrder) {
    const item = snapshot.itemsById[itemId];
    if (item?.kind === 'message-segment' && item.role === 'user') {
      currentTurn = turnByUserMessageId.get(item.messageId) ?? null;
      continue;
    }
    if (item?.kind !== 'message-segment' || item.role !== 'assistant' || !currentTurn) continue;
    const groups = groupsByTurnId.get(currentTurn.turnId) ?? [];
    let group = groups.find((candidate) => candidate.messageId === item.messageId);
    const text = normalizeAssistantText(
      item.parts.flatMap((part) => part.kind === 'markdown' ? [part.text] : []).join('\n'),
    );
    if (!group) {
      group = { messageId: item.messageId, itemIds: [], normalizedText: '' };
      groups.push(group);
      groupsByTurnId.set(currentTurn.turnId, groups);
    }
    group.itemIds.push(itemId);
    group.normalizedText = normalizeAssistantText([group.normalizedText, text].filter(Boolean).join('\n'));
  }
  return groupsByTurnId;
}

export function alignAssistantMessageMetadata(
  snapshot: AcpTimelineSnapshot,
  messages: RawMessage[],
  input: { liveUserMessageId?: string } = {},
): Record<string, AssistantMessageMetadata> {
  const acpTurns = acpUserTurns(snapshot);
  const eligibleTurns = input.liveUserMessageId
    ? acpTurns.filter((turn) => turn.messageIds.has(input.liveUserMessageId!))
    : acpTurns;
  if (input.liveUserMessageId && eligibleTurns.length !== 1) return {};
  const rawByKey = new Map(transcriptTurns(messages).map((turn) => [turnMatchKey(turn), turn]));
  const groupsByTurnId = timelineAssistantGroups(snapshot);
  const result: Record<string, AssistantMessageMetadata> = {};

  for (const acpTurn of eligibleTurns) {
    const rawTurn = rawByKey.get(turnMatchKey(acpTurn));
    const groups = groupsByTurnId.get(acpTurn.turnId) ?? [];
    if (!rawTurn || groups.length === 0) continue;
    const candidates = rawTurn.messages.flatMap((message) => {
      if (message.role !== 'assistant') return [];
      const metadata = assistantMetadata(message);
      if (!metadata) return [];
      return [{ metadata, normalizedText: normalizeAssistantText(textFromContent(message.content)) }];
    });
    const used = new Set<number>();
    for (const [groupIndex, group] of groups.entries()) {
      const exactMatches = candidates.flatMap((candidate, index) => (
        !used.has(index)
        && group.normalizedText
        && candidate.normalizedText === group.normalizedText
          ? [index]
          : []
      ));
      const candidateIndex = exactMatches.length === 1
        ? exactMatches[0]!
        : candidates.length === groups.length && !used.has(groupIndex)
          ? groupIndex
          : groups.length === 1 && candidates.length === 1
            ? 0
            : -1;
      if (candidateIndex < 0) continue;
      used.add(candidateIndex);
      for (const itemId of group.itemIds) result[itemId] = candidates[candidateIndex]!.metadata;
    }
  }
  return result;
}

export function applyAssistantMessageMetadata(
  snapshot: AcpTimelineSnapshot,
  metadataByItemId: Record<string, AssistantMessageMetadata>,
): AcpTimelineSnapshot {
  if (Object.keys(metadataByItemId).length === 0) return snapshot;
  let changed = false;
  const itemsById = { ...snapshot.itemsById };
  for (const [itemId, metadata] of Object.entries(metadataByItemId)) {
    const item = itemsById[itemId];
    if (item?.kind !== 'message-segment' || item.role !== 'assistant') continue;
    itemsById[itemId] = { ...item, assistantMetadata: metadata } as MessageSegmentItem;
    changed = true;
  }
  return changed ? { ...snapshot, itemsById } : snapshot;
}
