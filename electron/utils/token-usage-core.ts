export interface TokenUsageContextWeightEntry {
  name: string;
  blockChars?: number;
  summaryChars?: number;
  schemaChars?: number;
  injectedChars?: number;
}

export interface TokenUsageContextWeight {
  systemPrompt: {
    chars: number;
    projectContextChars?: number;
    nonProjectContextChars?: number;
  };
  skills: {
    promptChars: number;
    entries: TokenUsageContextWeightEntry[];
  };
  tools: {
    listChars: number;
    schemaChars: number;
    entries: TokenUsageContextWeightEntry[];
  };
  injectedWorkspaceFiles: TokenUsageContextWeightEntry[];
}

export interface TokenUsageMessageCounts {
  total: number;
  user: number;
  assistant: number;
  toolCalls: number;
  toolResults: number;
  errors: number;
}

export interface TokenUsageToolStat {
  name: string;
  count: number;
}

export interface TokenUsageToolUsage {
  totalCalls: number;
  uniqueTools: number;
  tools: TokenUsageToolStat[];
}

export interface TokenUsageSessionMetadata {
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
  messageCounts?: TokenUsageMessageCounts;
  toolUsage?: TokenUsageToolUsage;
}

export interface TokenUsageHistoryEntry {
  timestamp: string;
  sessionId: string;
  agentId: string;
  model?: string;
  provider?: string;
  content?: string;
  recordKind?: 'assistant' | 'toolResult';
  contextWeight?: TokenUsageContextWeight;
  sessionMeta?: TokenUsageSessionMetadata;
  usageStatus: 'available' | 'missing' | 'error';
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd?: number;
  inputCostUsd?: number;
  outputCostUsd?: number;
  cacheReadCostUsd?: number;
  cacheWriteCostUsd?: number;
}

export function extractSessionIdFromTranscriptFileName(fileName: string): string | undefined {
  if (!fileName.endsWith('.jsonl') && !fileName.includes('.jsonl.reset.')) return undefined;
  return fileName
    .replace(/\.reset\..+$/, '')
    .replace(/\.deleted\.jsonl$/, '')
    .replace(/\.jsonl$/, '');
}

interface TranscriptUsageShape {
  [key: string]: unknown;
  input?: number;
  output?: number;
  total?: number;
  cacheRead?: number;
  cacheWrite?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cache_read?: number;
  cache_write?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  inputTokenCount?: number;
  input_token_count?: number;
  outputTokenCount?: number;
  output_token_count?: number;
  promptTokenCount?: number;
  prompt_token_count?: number;
  completionTokenCount?: number;
  completion_token_count?: number;
  totalTokenCount?: number;
  total_token_count?: number;
  cacheReadTokenCount?: number;
  cacheReadTokens?: number;
  cache_write_token_count?: number;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    input_cost?: number;
    output_cost?: number;
    cache_read?: number;
    cache_write?: number;
    total?: number;
    total_cost?: number;
  };
  inputCost?: number;
  outputCost?: number;
  cacheReadCost?: number;
  cacheWriteCost?: number;
  totalCost?: number;
  input_cost?: number;
  output_cost?: number;
  cache_read_cost?: number;
  cache_write_cost?: number;
  total_cost?: number;
}

type UsageRecordStatus = 'available' | 'missing' | 'error';

interface ParsedUsageTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd?: number;
  inputCostUsd?: number;
  outputCostUsd?: number;
  cacheReadCostUsd?: number;
  cacheWriteCostUsd?: number;
  usageStatus: UsageRecordStatus;
}

function normalizeUsageNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return undefined;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function normalizeNonNegativeInteger(value: unknown): number | undefined {
  const parsed = normalizeUsageNumber(value);
  if (parsed === undefined || parsed < 0) return undefined;
  return Math.floor(parsed);
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeTimestampMs(value: unknown): number | undefined {
  const numeric = normalizeUsageNumber(value);
  if (numeric !== undefined && numeric >= 0) return numeric;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function normalizeContextEntry(value: unknown): TokenUsageContextWeightEntry | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const name = normalizeString(record.name) ?? normalizeString(record.path) ?? '(unknown)';
  const entry: TokenUsageContextWeightEntry = { name };
  const blockChars = normalizeNonNegativeInteger(record.blockChars);
  const summaryChars = normalizeNonNegativeInteger(record.summaryChars);
  const schemaChars = normalizeNonNegativeInteger(record.schemaChars);
  const injectedChars = normalizeNonNegativeInteger(record.injectedChars);
  if (blockChars !== undefined) entry.blockChars = blockChars;
  if (summaryChars !== undefined) entry.summaryChars = summaryChars;
  if (schemaChars !== undefined) entry.schemaChars = schemaChars;
  if (injectedChars !== undefined) entry.injectedChars = injectedChars;
  return entry;
}

function normalizeContextEntries(value: unknown): TokenUsageContextWeightEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => normalizeContextEntry(entry))
    .filter((entry): entry is TokenUsageContextWeightEntry => Boolean(entry));
}

export function normalizeTokenUsageContextWeight(value: unknown): TokenUsageContextWeight | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const systemPrompt = record.systemPrompt && typeof record.systemPrompt === 'object'
    ? record.systemPrompt as Record<string, unknown>
    : {};
  const skills = record.skills && typeof record.skills === 'object'
    ? record.skills as Record<string, unknown>
    : {};
  const tools = record.tools && typeof record.tools === 'object'
    ? record.tools as Record<string, unknown>
    : {};
  const systemPromptChars = normalizeNonNegativeInteger(systemPrompt.chars) ?? 0;
  const skillsPromptChars = normalizeNonNegativeInteger(skills.promptChars) ?? 0;
  const toolsListChars = normalizeNonNegativeInteger(tools.listChars) ?? 0;
  const toolsSchemaChars = normalizeNonNegativeInteger(tools.schemaChars) ?? 0;
  const injectedWorkspaceFiles = normalizeContextEntries(record.injectedWorkspaceFiles);
  const hasContextData = systemPromptChars > 0
    || skillsPromptChars > 0
    || toolsListChars > 0
    || toolsSchemaChars > 0
    || injectedWorkspaceFiles.some((entry) => (entry.injectedChars ?? 0) > 0);

  if (!hasContextData) return undefined;

  const projectContextChars = normalizeNonNegativeInteger(systemPrompt.projectContextChars);
  const nonProjectContextChars = normalizeNonNegativeInteger(systemPrompt.nonProjectContextChars);

  return {
    systemPrompt: {
      chars: systemPromptChars,
      ...(projectContextChars !== undefined ? { projectContextChars } : {}),
      ...(nonProjectContextChars !== undefined ? { nonProjectContextChars } : {}),
    },
    skills: {
      promptChars: skillsPromptChars,
      entries: normalizeContextEntries(skills.entries),
    },
    tools: {
      listChars: toolsListChars,
      schemaChars: toolsSchemaChars,
      entries: normalizeContextEntries(tools.entries),
    },
    injectedWorkspaceFiles,
  };
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => normalizeString(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function normalizeMessageCounts(value: unknown): TokenUsageMessageCounts | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const total = normalizeNonNegativeInteger(record.total) ?? 0;
  const user = normalizeNonNegativeInteger(record.user) ?? 0;
  const assistant = normalizeNonNegativeInteger(record.assistant) ?? 0;
  const toolCalls = normalizeNonNegativeInteger(record.toolCalls) ?? normalizeNonNegativeInteger(record.tool_calls) ?? 0;
  const toolResults = normalizeNonNegativeInteger(record.toolResults) ?? normalizeNonNegativeInteger(record.tool_results) ?? 0;
  const errors = normalizeNonNegativeInteger(record.errors) ?? 0;
  if (total + user + assistant + toolCalls + toolResults + errors <= 0) return undefined;
  return { total, user, assistant, toolCalls, toolResults, errors };
}

function normalizeToolUsage(value: unknown): TokenUsageToolUsage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const tools = Array.isArray(record.tools)
    ? record.tools
      .map((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
        const toolRecord = entry as Record<string, unknown>;
        const name = normalizeString(toolRecord.name);
        const count = normalizeNonNegativeInteger(toolRecord.count) ?? 0;
        return name && count > 0 ? { name, count } : undefined;
      })
      .filter((entry): entry is TokenUsageToolStat => Boolean(entry))
      .sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        return a.name.localeCompare(b.name);
      })
    : [];
  const totalCalls = normalizeNonNegativeInteger(record.totalCalls)
    ?? normalizeNonNegativeInteger(record.total_calls)
    ?? tools.reduce((sum, tool) => sum + tool.count, 0);
  const uniqueTools = normalizeNonNegativeInteger(record.uniqueTools)
    ?? normalizeNonNegativeInteger(record.unique_tools)
    ?? tools.length;
  if (totalCalls <= 0 && uniqueTools <= 0 && tools.length === 0) return undefined;
  return { totalCalls, uniqueTools, tools };
}

export function normalizeTokenUsageSessionMetadata(
  value: unknown,
  key?: string,
): TokenUsageSessionMetadata | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const origin = record.origin && typeof record.origin === 'object' && !Array.isArray(record.origin)
    ? record.origin as Record<string, unknown>
    : undefined;
  const usage = record.usage && typeof record.usage === 'object' && !Array.isArray(record.usage)
    ? record.usage as Record<string, unknown>
    : record.responseUsage && typeof record.responseUsage === 'object' && !Array.isArray(record.responseUsage)
      ? record.responseUsage as Record<string, unknown>
      : undefined;
  const includedSessionIds = [
    ...normalizeStringArray(record.includedSessionIds),
    ...normalizeStringArray(record.usageFamilySessionIds),
  ];
  const meta: TokenUsageSessionMetadata = {
    ...(normalizeString(key) ?? normalizeString(record.key) ?? normalizeString(record.sessionKey)
      ? { key: normalizeString(key) ?? normalizeString(record.key) ?? normalizeString(record.sessionKey) }
      : {}),
    ...(normalizeString(record.label) ?? normalizeString(record.displayName)
      ? { label: normalizeString(record.label) ?? normalizeString(record.displayName) }
      : {}),
    ...(normalizeString(record.channel) ? { channel: normalizeString(record.channel) } : {}),
    ...(normalizeString(record.chatType) ? { chatType: normalizeString(record.chatType) } : {}),
    ...(normalizeString(record.status) ? { status: normalizeString(record.status) } : {}),
    ...(normalizeTimestampMs(record.sessionStartedAt) ?? normalizeTimestampMs(record.startedAt)
      ? { startedAt: normalizeTimestampMs(record.sessionStartedAt) ?? normalizeTimestampMs(record.startedAt) }
      : {}),
    ...(normalizeTimestampMs(record.endedAt) ? { endedAt: normalizeTimestampMs(record.endedAt) } : {}),
    ...(normalizeTimestampMs(record.updatedAt) ? { updatedAt: normalizeTimestampMs(record.updatedAt) } : {}),
    ...(normalizeNonNegativeInteger(record.runtimeMs) ? { runtimeMs: normalizeNonNegativeInteger(record.runtimeMs) } : {}),
    ...(normalizeString(record.usageFamilyKey) ? { usageFamilyKey: normalizeString(record.usageFamilyKey) } : {}),
    ...(includedSessionIds.length > 0 ? { includedSessionIds: [...new Set(includedSessionIds)] } : {}),
    ...(normalizeString(record.modelOverride) ? { modelOverride: normalizeString(record.modelOverride) } : {}),
    ...(normalizeString(record.providerOverride) ? { providerOverride: normalizeString(record.providerOverride) } : {}),
    ...(normalizeString(record.modelProvider) ? { modelProvider: normalizeString(record.modelProvider) } : {}),
    ...(normalizeString(origin?.provider) ? { originProvider: normalizeString(origin?.provider) } : {}),
    ...(normalizeString(origin?.model) ? { originModel: normalizeString(origin?.model) } : {}),
    ...(normalizeMessageCounts(usage?.messageCounts) ? { messageCounts: normalizeMessageCounts(usage?.messageCounts) } : {}),
    ...(normalizeToolUsage(usage?.toolUsage) ? { toolUsage: normalizeToolUsage(usage?.toolUsage) } : {}),
  };
  return Object.keys(meta).length > 0 ? meta : undefined;
}

function firstUsageNumber(usage: TranscriptUsageShape | undefined, candidates: string[]): number | undefined {
  if (!usage) return undefined;
  for (const key of candidates) {
    const value = usage[key];
    const parsed = normalizeUsageNumber(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function firstNestedUsageNumber(
  usage: TranscriptUsageShape,
  nestedKey: keyof TranscriptUsageShape,
  candidates: string[],
): number | undefined {
  const nested = usage[nestedKey];
  if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return undefined;
  return firstUsageNumber(nested as TranscriptUsageShape, candidates);
}

function parseUsageFromShape(usage: unknown): ParsedUsageTokens | undefined {
  if (usage === undefined) {
    return undefined;
  }

  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) {
    return {
      usageStatus: 'error',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
    };
  }

  const usageShape = usage as TranscriptUsageShape;

  const inputTokens = firstUsageNumber(usageShape, [
    'input',
    'promptTokens',
    'prompt_tokens',
    'input_tokens',
    'inputTokenCount',
    'input_token_count',
    'promptTokenCount',
    'prompt_token_count',
  ]);
  const outputTokens = firstUsageNumber(usageShape, [
    'output',
    'completionTokens',
    'completion_tokens',
    'output_tokens',
    'outputTokenCount',
    'output_token_count',
    'completionTokenCount',
    'completion_token_count',
  ]);
  const cacheReadTokens = firstUsageNumber(usageShape, [
    'cacheRead',
    'cache_read',
    'cacheReadTokens',
    'cache_read_tokens',
    'cacheReadTokenCount',
    'cache_read_token_count',
  ]);
  const cacheWriteTokens = firstUsageNumber(usageShape, [
    'cacheWrite',
    'cache_write',
    'cacheWriteTokens',
    'cache_write_tokens',
    'cacheWriteTokenCount',
    'cache_write_token_count',
  ]);
  const explicitTotalTokens = firstUsageNumber(usageShape, [
    'total',
    'totalTokens',
    'total_tokens',
    'totalTokenCount',
    'total_token_count',
  ]);
  const inputCostUsd = firstNestedUsageNumber(usageShape, 'cost', ['input', 'inputCost', 'input_cost'])
    ?? firstUsageNumber(usageShape, ['inputCost', 'input_cost']);
  const outputCostUsd = firstNestedUsageNumber(usageShape, 'cost', ['output', 'outputCost', 'output_cost'])
    ?? firstUsageNumber(usageShape, ['outputCost', 'output_cost']);
  const cacheReadCostUsd = firstNestedUsageNumber(usageShape, 'cost', ['cacheRead', 'cache_read', 'cacheReadCost', 'cache_read_cost'])
    ?? firstUsageNumber(usageShape, ['cacheReadCost', 'cache_read_cost']);
  const cacheWriteCostUsd = firstNestedUsageNumber(usageShape, 'cost', ['cacheWrite', 'cache_write', 'cacheWriteCost', 'cache_write_cost'])
    ?? firstUsageNumber(usageShape, ['cacheWriteCost', 'cache_write_cost']);
  const costUsd = firstNestedUsageNumber(usageShape, 'cost', ['total', 'totalCost', 'total_cost'])
    ?? firstUsageNumber(usageShape, ['totalCost', 'total_cost']);

  const hasUsageValue =
    inputTokens !== undefined
    || outputTokens !== undefined
    || cacheReadTokens !== undefined
    || cacheWriteTokens !== undefined
    || explicitTotalTokens !== undefined
    || costUsd !== undefined
    || inputCostUsd !== undefined
    || outputCostUsd !== undefined
    || cacheReadCostUsd !== undefined
    || cacheWriteCostUsd !== undefined;

  if (!hasUsageValue) {
    return {
      usageStatus: 'missing',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
    };
  }

  const totalTokens = explicitTotalTokens ?? (
    (inputTokens ?? 0)
      + (outputTokens ?? 0)
      + (cacheReadTokens ?? 0)
      + (cacheWriteTokens ?? 0)
  );

  return {
    usageStatus: 'available',
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cacheReadTokens: cacheReadTokens ?? 0,
    cacheWriteTokens: cacheWriteTokens ?? 0,
    totalTokens,
    costUsd,
    inputCostUsd,
    outputCostUsd,
    cacheReadCostUsd,
    cacheWriteCostUsd,
  };
}

interface TranscriptLineShape {
  type?: string;
  timestamp?: string;
  message?: {
    role?: string;
    error?: unknown;
    content?: unknown;
    toolName?: string;
    name?: string;
    tool_calls?: unknown;
    toolCalls?: unknown;
    model?: string;
    modelRef?: string;
    provider?: string;
    usage?: TranscriptUsageShape;
    details?: {
      provider?: string;
      model?: string;
      usage?: TranscriptUsageShape;
      content?: unknown;
      error?: unknown;
      toolName?: string;
      name?: string;
      externalContent?: {
        provider?: string;
      };
    };
  };
}

function mergeSessionMetadata(
  base: TokenUsageSessionMetadata | undefined,
  extra: TokenUsageSessionMetadata | undefined,
): TokenUsageSessionMetadata | undefined {
  if (!base && !extra) return undefined;
  const extraToolUsage = extra?.toolUsage;
  const baseToolUsage = base?.toolUsage;
  return {
    ...(base ?? {}),
    ...(extra ?? {}),
    messageCounts: extra?.messageCounts ?? base?.messageCounts,
    toolUsage: extraToolUsage && extraToolUsage.totalCalls > 0 ? extraToolUsage : baseToolUsage ?? extraToolUsage,
  };
}

function countMessageError(parsed: TranscriptLineShape, message: NonNullable<TranscriptLineShape['message']>): boolean {
  if (parsed.type === 'error') return true;
  if (message.error !== undefined) return true;
  if (message.details?.error !== undefined) return true;
  return false;
}

function extractToolNamesFromContent(value: unknown): string[] {
  if (typeof value === 'string') {
    return [...value.matchAll(/^\s*\[Tool:\s*([^\]]+)\]/gm)]
      .map((match) => normalizeString(match[1]))
      .filter((name): name is string => Boolean(name));
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => extractToolNamesFromContent(item));
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return [
      ...extractToolNamesFromContent(record.text),
      ...extractToolNamesFromContent(record.content),
    ];
  }

  return [];
}

function extractToolNamesFromCalls(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
      const record = item as Record<string, unknown>;
      const fn = record.function && typeof record.function === 'object'
        ? record.function as Record<string, unknown>
        : undefined;
      return normalizeString(record.name)
        ?? normalizeString(record.toolName)
        ?? normalizeString(fn?.name);
    })
    .filter((name): name is string => Boolean(name));
}

function extractToolNamesFromMessage(message: NonNullable<TranscriptLineShape['message']>): string[] {
  const names = [
    normalizeString(message.toolName),
    normalizeString(message.name),
    normalizeString(message.details?.toolName),
    normalizeString(message.details?.name),
    ...extractToolNamesFromCalls(message.toolCalls),
    ...extractToolNamesFromCalls(message.tool_calls),
    ...extractToolNamesFromContent(message.content),
    ...extractToolNamesFromContent(message.details?.content),
  ].filter((name): name is string => Boolean(name));
  return names;
}

function summarizeTranscriptSession(parsedLines: TranscriptLineShape[]): TokenUsageSessionMetadata {
  const counts: TokenUsageMessageCounts = {
    total: 0,
    user: 0,
    assistant: 0,
    toolCalls: 0,
    toolResults: 0,
    errors: 0,
  };
  const tools = new Map<string, number>();

  for (const parsed of parsedLines) {
    const message = parsed.message;
    if (!message) continue;
    counts.total += 1;
    if (message.role === 'user') counts.user += 1;
    if (message.role === 'assistant') counts.assistant += 1;
    if (message.role === 'toolResult' || message.role === 'tool') counts.toolResults += 1;
    if (countMessageError(parsed, message)) counts.errors += 1;

    const toolNames = extractToolNamesFromMessage(message);
    counts.toolCalls += toolNames.length;
    for (const name of toolNames) {
      tools.set(name, (tools.get(name) ?? 0) + 1);
    }
  }

  const toolEntries = Array.from(tools.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.name.localeCompare(b.name);
    });

  return {
    messageCounts: counts,
    toolUsage: {
      totalCalls: toolEntries.reduce((sum, tool) => sum + tool.count, 0),
      uniqueTools: toolEntries.length,
      tools: toolEntries,
    },
  };
}

function normalizeUsageContent(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (Array.isArray(value)) {
    const chunks = value
      .map((item) => normalizeUsageContent(item))
      .filter((item): item is string => Boolean(item));
    if (chunks.length === 0) return undefined;
    return chunks.join('\n\n');
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.text === 'string') {
      const trimmed = record.text.trim();
      if (trimmed.length > 0) return trimmed;
    }
    if (typeof record.content === 'string') {
      const trimmed = record.content.trim();
      if (trimmed.length > 0) return trimmed;
    }
    if (Array.isArray(record.content)) {
      return normalizeUsageContent(record.content);
    }
    if (typeof record.thinking === 'string') {
      const trimmed = record.thinking.trim();
      if (trimmed.length > 0) return trimmed;
    }
    try {
      return JSON.stringify(record, null, 2);
    } catch {
      return undefined;
    }
  }

  return undefined;
}

export function parseUsageEntriesFromJsonl(
  content: string,
  context: {
    sessionId: string;
    agentId: string;
    contextWeight?: TokenUsageContextWeight;
    sessionMeta?: TokenUsageSessionMetadata;
  },
  limit?: number,
): TokenUsageHistoryEntry[] {
  const entries: TokenUsageHistoryEntry[] = [];
  const lines = content.split(/\r?\n/).filter(Boolean);
  const parsedLines: TranscriptLineShape[] = [];
  for (const line of lines) {
    try {
      parsedLines.push(JSON.parse(line) as TranscriptLineShape);
    } catch {
      continue;
    }
  }
  const sessionMeta = mergeSessionMetadata(context.sessionMeta, summarizeTranscriptSession(parsedLines));
  const maxEntries = typeof limit === 'number' && Number.isFinite(limit)
    ? Math.max(Math.floor(limit), 0)
    : Number.POSITIVE_INFINITY;

  for (let i = parsedLines.length - 1; i >= 0 && entries.length < maxEntries; i -= 1) {
    const parsed = parsedLines[i];
    const message = parsed.message;
    if (!message || !parsed.timestamp) {
      continue;
    }

    if (message.role === 'assistant' && 'usage' in message) {
      const usage = parseUsageFromShape(message.usage);
      if (!usage) continue;

      const contentText = normalizeUsageContent((message as Record<string, unknown>).content);
      entries.push({
        timestamp: parsed.timestamp,
        sessionId: context.sessionId,
        agentId: context.agentId,
        model: message.model ?? message.modelRef,
        provider: message.provider,
        recordKind: 'assistant',
        ...(context.contextWeight ? { contextWeight: context.contextWeight } : {}),
        ...(sessionMeta ? { sessionMeta } : {}),
        ...(contentText ? { content: contentText } : {}),
        ...usage,
      });
      continue;
    }

    if (message.role !== 'toolResult') {
      continue;
    }

    const details = message.details;
    if (!details || !('usage' in details)) {
      continue;
    }

    const usage = parseUsageFromShape(details.usage);
    if (!usage) continue;

    const provider = details.provider ?? details.externalContent?.provider ?? message.provider;
    const model = details.model ?? message.model ?? message.modelRef;
    const contentText = normalizeUsageContent(details.content)
      ?? normalizeUsageContent((message as Record<string, unknown>).content);

    entries.push({
      timestamp: parsed.timestamp,
      sessionId: context.sessionId,
      agentId: context.agentId,
      model,
      provider,
      recordKind: 'toolResult',
      ...(context.contextWeight ? { contextWeight: context.contextWeight } : {}),
      ...(sessionMeta ? { sessionMeta } : {}),
      ...(contentText ? { content: contentText } : {}),
      ...usage,
    });
  }

  return entries;
}
