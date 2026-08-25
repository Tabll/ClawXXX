export type UsageContextWeightEntry = {
  name: string;
  blockChars?: number;
  summaryChars?: number;
  schemaChars?: number;
  injectedChars?: number;
};

export type UsageContextWeight = {
  systemPrompt: {
    chars: number;
    projectContextChars?: number;
    nonProjectContextChars?: number;
  };
  skills: {
    promptChars: number;
    entries: UsageContextWeightEntry[];
  };
  tools: {
    listChars: number;
    schemaChars: number;
    entries: UsageContextWeightEntry[];
  };
  injectedWorkspaceFiles: UsageContextWeightEntry[];
};

export type UsageMessageCounts = {
  total: number;
  user: number;
  assistant: number;
  toolCalls: number;
  toolResults: number;
  errors: number;
};

export type UsageToolStat = {
  name: string;
  count: number;
};

export type UsageToolUsage = {
  totalCalls: number;
  uniqueTools: number;
  tools: UsageToolStat[];
};

export type UsageSessionMetadata = {
  key?: string;
  label?: string;
  channel?: string;
  chatType?: string;
  status?: string;
  startedAt?: number;
  endedAt?: number;
  runtimeMs?: number;
  updatedAt?: number;
  usageFamilyKey?: string;
  includedSessionIds?: string[];
  modelOverride?: string;
  providerOverride?: string;
  modelProvider?: string;
  originProvider?: string;
  originModel?: string;
  messageCounts?: UsageMessageCounts;
  toolUsage?: UsageToolUsage;
};

export type UsageHistoryEntry = {
  id?: string;
  eventKey?: string;
  runId?: string;
  kernelId?: string;
  requestId?: string;
  source?: 'runtime-event' | 'provider-response';
  timestamp: string;
  sessionId: string;
  agentId: string;
  model?: string;
  provider?: string;
  content?: string;
  recordKind?: 'assistant' | 'toolResult';
  contextWeight?: UsageContextWeight;
  sessionMeta?: UsageSessionMetadata;
  usageStatus?: 'available' | 'missing' | 'error';
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  cost?: number;
  currency?: string;
  costUsd?: number;
  inputCostUsd?: number;
  outputCostUsd?: number;
  cacheReadCostUsd?: number;
  cacheWriteCostUsd?: number;
};

export type UsageWindow = '7d' | '30d' | 'all';
export type UsageGroupBy = 'model' | 'provider' | 'agent' | 'day';

export type UsageSessionBreakdownItem = {
  label: string;
  totalTokens: number;
  count: number;
  costUsd: number;
  unknownTokenEntries: number;
  unknownCostEntries: number;
};

export type UsageSessionSummary = {
  id: string;
  sessionId: string;
  agentId: string;
  firstTimestamp: string;
  lastTimestamp: string;
  model?: string;
  provider?: string;
  models: UsageSessionBreakdownItem[];
  providers: UsageSessionBreakdownItem[];
  entries: UsageHistoryEntry[];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheTokens: number;
  totalTokens: number;
  costUsd: number;
  inputCostUsd: number;
  outputCostUsd: number;
  cacheReadCostUsd: number;
  cacheWriteCostUsd: number;
  availableEntries: number;
  missingEntries: number;
  errorEntries: number;
  unknownTokenEntries: number;
  unknownCostEntries: number;
  contentPreview?: string;
  contextWeight?: UsageContextWeight;
  sessionMeta?: UsageSessionMetadata;
  messageCounts?: UsageMessageCounts;
  toolUsage?: UsageToolUsage;
};

export type UsageGroup = {
  label: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheTokens: number;
  costUsd: number;
  count: number;
  unknownTokenEntries: number;
  unknownCostEntries: number;
  sortKey: number | string;
};

export function resolveStableUsageHistory(
  previousStableEntries: UsageHistoryEntry[],
  nextEntries: UsageHistoryEntry[],
  options: { preservePreviousOnEmpty?: boolean } = {},
): UsageHistoryEntry[] {
  if (nextEntries.length > 0) {
    return nextEntries;
  }

  return options.preservePreviousOnEmpty ? previousStableEntries : [];
}

export function resolveVisibleUsageHistory(
  currentEntries: UsageHistoryEntry[],
  stableEntries: UsageHistoryEntry[],
  options: { preferStableOnEmpty?: boolean } = {},
): UsageHistoryEntry[] {
  if (options.preferStableOnEmpty && currentEntries.length === 0) {
    return stableEntries;
  }

  return currentEntries;
}

export function formatUsageDay(timestamp: string, timeZone?: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    ...(timeZone ? { timeZone } : {}),
  }).format(date);
}

export function getUsageDaySortKey(timestamp: string, timeZone?: string): number {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return 0;
  if (!timeZone) {
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(part => part.type === type)?.value);
  return Date.UTC(value('year'), value('month') - 1, value('day'));
}

function getEntryTime(entry: UsageHistoryEntry): number {
  const timestamp = Date.parse(entry.timestamp);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function getEntryCost(entry: UsageHistoryEntry): number {
  return typeof entry.costUsd === 'number' && Number.isFinite(entry.costUsd) ? entry.costUsd : 0;
}

function getEntryToken(entry: UsageHistoryEntry, key: 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'): number {
  const value = entry[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function getEntryTotal(entry: UsageHistoryEntry): number {
  if (typeof entry.totalTokens === 'number' && Number.isFinite(entry.totalTokens)) return entry.totalTokens;
  return getEntryToken(entry, 'inputTokens')
    + getEntryToken(entry, 'outputTokens')
    + getEntryToken(entry, 'cacheReadTokens')
    + getEntryToken(entry, 'cacheWriteTokens');
}

function getEntryCostPart(entry: UsageHistoryEntry, key: 'inputCostUsd' | 'outputCostUsd' | 'cacheReadCostUsd' | 'cacheWriteCostUsd'): number {
  const value = entry[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function addBreakdownValue(
  map: Map<string, UsageSessionBreakdownItem>,
  label: string | undefined,
  entry: UsageHistoryEntry,
): void {
  const resolvedLabel = label || 'Unknown';
  const current = map.get(resolvedLabel) ?? {
    label: resolvedLabel,
    totalTokens: 0,
    count: 0,
    costUsd: 0,
    unknownTokenEntries: 0,
    unknownCostEntries: 0,
  };
  current.totalTokens += getEntryTotal(entry);
  current.count += 1;
  current.costUsd += getEntryCost(entry);
  if (entry.totalTokens === undefined) current.unknownTokenEntries += 1;
  if (entry.costUsd === undefined) current.unknownCostEntries += 1;
  map.set(resolvedLabel, current);
}

function sortBreakdown(map: Map<string, UsageSessionBreakdownItem>): UsageSessionBreakdownItem[] {
  return Array.from(map.values()).sort((a, b) => {
    if (b.totalTokens !== a.totalTokens) return b.totalTokens - a.totalTokens;
    if (b.count !== a.count) return b.count - a.count;
    return a.label.localeCompare(b.label);
  });
}

export function aggregateUsageSessions(entries: UsageHistoryEntry[]): UsageSessionSummary[] {
  type MutableSession = Omit<
    UsageSessionSummary,
    'firstTimestamp' | 'lastTimestamp' | 'model' | 'provider' | 'models' | 'providers' | 'entries'
  > & {
    entries: UsageHistoryEntry[];
    modelMap: Map<string, UsageSessionBreakdownItem>;
    providerMap: Map<string, UsageSessionBreakdownItem>;
  };

  const sessions = new Map<string, MutableSession>();

  for (const entry of entries) {
    const agentId = entry.agentId || 'Unknown';
    const sessionId = entry.sessionId || 'Unknown';
    const id = `${agentId}::${sessionId}`;
    const current = sessions.get(id) ?? {
      id,
      sessionId,
      agentId,
      entries: [],
      modelMap: new Map<string, UsageSessionBreakdownItem>(),
      providerMap: new Map<string, UsageSessionBreakdownItem>(),
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      inputCostUsd: 0,
      outputCostUsd: 0,
      cacheReadCostUsd: 0,
      cacheWriteCostUsd: 0,
      availableEntries: 0,
      missingEntries: 0,
      errorEntries: 0,
      unknownTokenEntries: 0,
      unknownCostEntries: 0,
    };

    current.entries.push(entry);
    current.inputTokens += getEntryToken(entry, 'inputTokens');
    current.outputTokens += getEntryToken(entry, 'outputTokens');
    current.cacheReadTokens += getEntryToken(entry, 'cacheReadTokens');
    current.cacheWriteTokens += getEntryToken(entry, 'cacheWriteTokens');
    current.cacheTokens += getEntryToken(entry, 'cacheReadTokens') + getEntryToken(entry, 'cacheWriteTokens');
    current.totalTokens += getEntryTotal(entry);
    current.costUsd += getEntryCost(entry);
    current.inputCostUsd += getEntryCostPart(entry, 'inputCostUsd');
    current.outputCostUsd += getEntryCostPart(entry, 'outputCostUsd');
    current.cacheReadCostUsd += getEntryCostPart(entry, 'cacheReadCostUsd');
    current.cacheWriteCostUsd += getEntryCostPart(entry, 'cacheWriteCostUsd');
    if (entry.usageStatus === 'missing') {
      current.missingEntries += 1;
    } else if (entry.usageStatus === 'error') {
      current.errorEntries += 1;
    } else {
      current.availableEntries += 1;
    }
    if (entry.totalTokens === undefined) current.unknownTokenEntries += 1;
    if (entry.costUsd === undefined) current.unknownCostEntries += 1;
    addBreakdownValue(current.modelMap, entry.model, entry);
    addBreakdownValue(current.providerMap, entry.provider, entry);
    if (entry.content?.trim()) {
      current.contentPreview = entry.content.trim();
    }
    if (entry.contextWeight) {
      current.contextWeight = entry.contextWeight;
    }
    if (entry.sessionMeta) {
      current.sessionMeta = {
        ...(current.sessionMeta ?? {}),
        ...entry.sessionMeta,
        messageCounts: entry.sessionMeta.messageCounts ?? current.sessionMeta?.messageCounts,
        toolUsage: entry.sessionMeta.toolUsage ?? current.sessionMeta?.toolUsage,
      };
    }

    sessions.set(id, current);
  }

  return Array.from(sessions.values()).map((session) => {
    const sessionEntries = [...session.entries].sort((a, b) => getEntryTime(a) - getEntryTime(b));
    const models = sortBreakdown(session.modelMap);
    const providers = sortBreakdown(session.providerMap);

    return {
      id: session.id,
      sessionId: session.sessionId,
      agentId: session.agentId,
      firstTimestamp: sessionEntries[0]?.timestamp ?? '',
      lastTimestamp: sessionEntries[sessionEntries.length - 1]?.timestamp ?? '',
      model: models[0]?.label,
      provider: providers[0]?.label,
      models,
      providers,
      entries: sessionEntries,
      inputTokens: session.inputTokens,
      outputTokens: session.outputTokens,
      cacheReadTokens: session.cacheReadTokens,
      cacheWriteTokens: session.cacheWriteTokens,
      cacheTokens: session.cacheTokens,
      totalTokens: session.totalTokens,
      costUsd: session.costUsd,
      inputCostUsd: session.inputCostUsd,
      outputCostUsd: session.outputCostUsd,
      cacheReadCostUsd: session.cacheReadCostUsd,
      cacheWriteCostUsd: session.cacheWriteCostUsd,
      availableEntries: session.availableEntries,
      missingEntries: session.missingEntries,
      errorEntries: session.errorEntries,
      unknownTokenEntries: session.unknownTokenEntries,
      unknownCostEntries: session.unknownCostEntries,
      ...(session.contentPreview ? { contentPreview: session.contentPreview } : {}),
      ...(session.contextWeight ? { contextWeight: session.contextWeight } : {}),
      ...(session.sessionMeta ? {
        sessionMeta: session.sessionMeta,
        ...(session.sessionMeta.messageCounts ? { messageCounts: session.sessionMeta.messageCounts } : {}),
        ...(session.sessionMeta.toolUsage ? { toolUsage: session.sessionMeta.toolUsage } : {}),
      } : {}),
    };
  }).sort((a, b) => {
    const timeDiff = Date.parse(b.lastTimestamp) - Date.parse(a.lastTimestamp);
    if (Number.isFinite(timeDiff) && timeDiff !== 0) return timeDiff;
    return b.totalTokens - a.totalTokens;
  });
}

export function matchesUsageSession(session: UsageSessionSummary, rawQuery: string): boolean {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return true;

  const searchable = [
    session.sessionId,
    session.agentId,
    session.model,
    session.provider,
    session.contentPreview,
    session.sessionMeta?.key,
    session.sessionMeta?.label,
    session.sessionMeta?.channel,
    session.sessionMeta?.chatType,
    session.sessionMeta?.status,
    session.sessionMeta?.modelOverride,
    session.sessionMeta?.providerOverride,
    session.sessionMeta?.modelProvider,
    ...session.models.map((item) => item.label),
    ...session.providers.map((item) => item.label),
    ...(session.toolUsage?.tools.map((item) => item.name) ?? []),
    ...session.entries.flatMap((entry) => [
      entry.model,
      entry.provider,
      entry.content,
      entry.recordKind,
      entry.usageStatus,
    ]),
  ].filter((value): value is string => Boolean(value));

  return searchable.some((value) => value.toLowerCase().includes(query));
}

function getUsageGroupLabel(entry: UsageHistoryEntry, groupBy: UsageGroupBy, timeZone?: string): string {
  switch (groupBy) {
    case 'provider':
      return entry.provider || 'Unknown';
    case 'agent':
      return entry.agentId || 'Unknown';
    case 'day':
      return formatUsageDay(entry.timestamp, timeZone);
    case 'model':
    default:
      return entry.model || 'Unknown';
  }
}

function getUsageGroupSortKey(
  entry: UsageHistoryEntry,
  label: string,
  groupBy: UsageGroupBy,
  timeZone?: string,
): number | string {
  if (groupBy === 'day') return getUsageDaySortKey(entry.timestamp, timeZone);
  return label.toLowerCase();
}

export function groupUsageHistory(
  entries: UsageHistoryEntry[],
  groupBy: UsageGroupBy,
  options: { timeZone?: string } = {},
): UsageGroup[] {
  const grouped = new Map<string, UsageGroup>();

  for (const entry of entries) {
    const label = getUsageGroupLabel(entry, groupBy, options.timeZone);
    const current = grouped.get(label) ?? {
      label,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheTokens: 0,
      costUsd: 0,
      count: 0,
      unknownTokenEntries: 0,
      unknownCostEntries: 0,
      sortKey: getUsageGroupSortKey(entry, label, groupBy, options.timeZone),
    };
    current.totalTokens += getEntryTotal(entry);
    current.inputTokens += getEntryToken(entry, 'inputTokens');
    current.outputTokens += getEntryToken(entry, 'outputTokens');
    current.cacheReadTokens += getEntryToken(entry, 'cacheReadTokens');
    current.cacheWriteTokens += getEntryToken(entry, 'cacheWriteTokens');
    current.cacheTokens += getEntryToken(entry, 'cacheReadTokens') + getEntryToken(entry, 'cacheWriteTokens');
    current.costUsd += getEntryCost(entry);
    current.count += 1;
    if (entry.totalTokens === undefined) current.unknownTokenEntries += 1;
    if (entry.costUsd === undefined) current.unknownCostEntries += 1;
    grouped.set(label, current);
  }

  const sorted = Array.from(grouped.values()).sort((a, b) => {
    if (groupBy === 'day') {
      return Number(a.sortKey) - Number(b.sortKey);
    }
    return b.totalTokens - a.totalTokens;
  });

  return groupBy === 'day' ? sorted : sorted.slice(0, 8);
}

export function filterUsageHistoryByWindow(
  entries: UsageHistoryEntry[],
  window: UsageWindow,
  now = Date.now(),
): UsageHistoryEntry[] {
  if (window === 'all') return entries;

  const days = window === '7d' ? 7 : 30;
  const cutoff = now - days * 24 * 60 * 60 * 1000;

  return entries.filter((entry) => {
    const timestamp = Date.parse(entry.timestamp);
    return Number.isFinite(timestamp) && timestamp >= cutoff;
  });
}
