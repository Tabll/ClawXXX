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

export type UsageHistoryEntry = {
  timestamp: string;
  sessionId: string;
  agentId: string;
  model?: string;
  provider?: string;
  content?: string;
  recordKind?: 'assistant' | 'toolResult';
  contextWeight?: UsageContextWeight;
  usageStatus?: 'available' | 'missing' | 'error';
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd?: number;
};

export type UsageWindow = '7d' | '30d' | 'all';
export type UsageGroupBy = 'model' | 'provider' | 'agent' | 'day';

export type UsageSessionBreakdownItem = {
  label: string;
  totalTokens: number;
  count: number;
  costUsd: number;
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
  availableEntries: number;
  missingEntries: number;
  errorEntries: number;
  contentPreview?: string;
  contextWeight?: UsageContextWeight;
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

export function formatUsageDay(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
  }).format(date);
}

export function getUsageDaySortKey(timestamp: string): number {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return 0;
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function getEntryTime(entry: UsageHistoryEntry): number {
  const timestamp = Date.parse(entry.timestamp);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function getEntryCost(entry: UsageHistoryEntry): number {
  return typeof entry.costUsd === 'number' && Number.isFinite(entry.costUsd) ? entry.costUsd : 0;
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
  };
  current.totalTokens += entry.totalTokens;
  current.count += 1;
  current.costUsd += getEntryCost(entry);
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
      availableEntries: 0,
      missingEntries: 0,
      errorEntries: 0,
    };

    current.entries.push(entry);
    current.inputTokens += entry.inputTokens;
    current.outputTokens += entry.outputTokens;
    current.cacheReadTokens += entry.cacheReadTokens;
    current.cacheWriteTokens += entry.cacheWriteTokens;
    current.cacheTokens += entry.cacheReadTokens + entry.cacheWriteTokens;
    current.totalTokens += entry.totalTokens;
    current.costUsd += getEntryCost(entry);
    if (entry.usageStatus === 'missing') {
      current.missingEntries += 1;
    } else if (entry.usageStatus === 'error') {
      current.errorEntries += 1;
    } else {
      current.availableEntries += 1;
    }
    addBreakdownValue(current.modelMap, entry.model, entry);
    addBreakdownValue(current.providerMap, entry.provider, entry);
    if (entry.content?.trim()) {
      current.contentPreview = entry.content.trim();
    }
    if (entry.contextWeight) {
      current.contextWeight = entry.contextWeight;
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
      availableEntries: session.availableEntries,
      missingEntries: session.missingEntries,
      errorEntries: session.errorEntries,
      ...(session.contentPreview ? { contentPreview: session.contentPreview } : {}),
      ...(session.contextWeight ? { contextWeight: session.contextWeight } : {}),
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
    ...session.models.map((item) => item.label),
    ...session.providers.map((item) => item.label),
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

function getUsageGroupLabel(entry: UsageHistoryEntry, groupBy: UsageGroupBy): string {
  switch (groupBy) {
    case 'provider':
      return entry.provider || 'Unknown';
    case 'agent':
      return entry.agentId || 'Unknown';
    case 'day':
      return formatUsageDay(entry.timestamp);
    case 'model':
    default:
      return entry.model || 'Unknown';
  }
}

function getUsageGroupSortKey(entry: UsageHistoryEntry, label: string, groupBy: UsageGroupBy): number | string {
  if (groupBy === 'day') return getUsageDaySortKey(entry.timestamp);
  return label.toLowerCase();
}

export function groupUsageHistory(
  entries: UsageHistoryEntry[],
  groupBy: UsageGroupBy,
): UsageGroup[] {
  const grouped = new Map<string, UsageGroup>();

  for (const entry of entries) {
    const label = getUsageGroupLabel(entry, groupBy);
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
      sortKey: getUsageGroupSortKey(entry, label, groupBy),
    };
    current.totalTokens += entry.totalTokens;
    current.inputTokens += entry.inputTokens;
    current.outputTokens += entry.outputTokens;
    current.cacheReadTokens += entry.cacheReadTokens;
    current.cacheWriteTokens += entry.cacheWriteTokens;
    current.cacheTokens += entry.cacheReadTokens + entry.cacheWriteTokens;
    current.costUsd += getEntryCost(entry);
    current.count += 1;
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
