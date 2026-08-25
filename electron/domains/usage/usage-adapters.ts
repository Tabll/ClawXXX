import { createHash } from 'node:crypto';
import type { RunId } from '@shared/conversations/contracts';
import type { KernelId } from '@shared/kernels/contracts';
import type { UsageSource } from '@shared/domains/usage';

export type CanonicalUsageEventPayload = {
  eventKey: string;
  source: UsageSource;
  providerId?: string;
  modelId?: string;
  requestId?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  cost?: number;
  currency?: string;
};

export type UsageAdapterContext = {
  kernelId: KernelId;
  runId: RunId;
  eventSeq: number;
  nativeEventId?: string;
  providerId?: string;
  modelId?: string;
};

export type KernelUsageAdapter = {
  readonly kernelId: KernelId;
  normalize(payload: unknown, context: UsageAdapterContext): CanonicalUsageEventPayload;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function candidateRecords(payload: unknown): Record<string, unknown>[] {
  const root = record(payload);
  if (!root) return [];
  const meta = record(root._meta);
  return [
    root,
    record(root.usage),
    record(root.tokens),
    record(meta?.clawx),
    record(meta?.usage),
  ].filter((entry): entry is Record<string, unknown> => entry !== undefined);
}

function finiteNonNegative(records: Record<string, unknown>[], aliases: string[]): number | undefined {
  for (const source of records) {
    for (const alias of aliases) {
      const value = source[alias];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
    }
  }
  return undefined;
}

function nonEmptyString(records: Record<string, unknown>[], aliases: string[]): string | undefined {
  for (const source of records) {
    for (const alias of aliases) {
      const value = source[alias];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  return undefined;
}

function boundedIdentity(value: string): string {
  if (value.length <= 256) return value;
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function reportedCost(records: Record<string, unknown>[]): { cost?: number; currency?: string } {
  const cost = finiteNonNegative(records, ['cost', 'costAmount', 'cost_amount', 'costUsd', 'cost_usd']);
  let currency = nonEmptyString(records, ['currency']);
  for (const source of records) {
    const nested = record(source.cost);
    if (!nested) continue;
    const amount = finiteNonNegative([nested], ['amount', 'total', 'value']);
    const nestedCurrency = nonEmptyString([nested], ['currency']);
    if (amount !== undefined) {
      return {
        cost: amount,
        ...(nestedCurrency ? { currency: nestedCurrency.toUpperCase() } : { currency: 'USD' }),
      };
    }
  }
  if (cost === undefined) return {};
  if (!currency && records.some(source => source.costUsd !== undefined || source.cost_usd !== undefined)) {
    currency = 'USD';
  }
  return { cost, ...(currency ? { currency: currency.toUpperCase() } : {}) };
}

function normalize(
  payload: unknown,
  context: UsageAdapterContext,
  defaultSource: UsageSource,
): CanonicalUsageEventPayload {
  const records = candidateRecords(payload);
  const inputTokens = finiteNonNegative(records, ['inputTokens', 'input_tokens', 'input', 'promptTokens', 'prompt_tokens']);
  const outputTokens = finiteNonNegative(records, ['outputTokens', 'output_tokens', 'output', 'completionTokens', 'completion_tokens']);
  const cacheReadTokens = finiteNonNegative(records, ['cacheReadTokens', 'cache_read_tokens', 'cacheRead', 'cachedInputTokens']);
  const cacheWriteTokens = finiteNonNegative(records, ['cacheWriteTokens', 'cache_write_tokens', 'cacheWrite', 'cacheCreationTokens']);
  const explicitTotal = finiteNonNegative(records, ['totalTokens', 'total_tokens', 'total']);
  const totalTokens = explicitTotal ?? (
    inputTokens !== undefined
    && outputTokens !== undefined
    && cacheReadTokens !== undefined
    && cacheWriteTokens !== undefined
      ? inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
      : undefined
  );
  const requestId = nonEmptyString(records, [
    'requestId', 'request_id', 'responseId', 'response_id', 'callId', 'call_id',
  ]);
  const rawEventKey = nonEmptyString(records, ['eventKey', 'event_key'])
    ?? requestId
    ?? context.nativeEventId
    ?? `${context.kernelId}:${context.runId}:${context.eventSeq}`;
  const reportedSource = nonEmptyString(records, ['source']);
  const source: UsageSource = reportedSource === 'provider-response' || reportedSource === 'runtime-event'
    ? reportedSource
    : defaultSource;
  return {
    eventKey: boundedIdentity(rawEventKey),
    source,
    ...(nonEmptyString(records, ['providerId', 'provider_id', 'provider']) ?? context.providerId
      ? { providerId: nonEmptyString(records, ['providerId', 'provider_id', 'provider']) ?? context.providerId }
      : {}),
    ...(nonEmptyString(records, ['modelId', 'model_id', 'model']) ?? context.modelId
      ? { modelId: nonEmptyString(records, ['modelId', 'model_id', 'model']) ?? context.modelId }
      : {}),
    ...(requestId ? { requestId } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...reportedCost(records),
  };
}

export const openClawUsageAdapter: KernelUsageAdapter = {
  kernelId: 'openclaw',
  normalize: (payload, context) => normalize(payload, context, 'provider-response'),
};

export const deepSeekHarnessUsageAdapter: KernelUsageAdapter = {
  kernelId: 'deepseek-harness',
  normalize: (payload, context) => normalize(payload, context, 'runtime-event'),
};

export class UsageAdapterRegistry {
  private readonly adapters = new Map<KernelId, KernelUsageAdapter>();

  constructor(adapters: KernelUsageAdapter[] = [openClawUsageAdapter, deepSeekHarnessUsageAdapter]) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: KernelUsageAdapter): void {
    if (this.adapters.has(adapter.kernelId)) throw new Error(`Usage adapter already registered: ${adapter.kernelId}`);
    this.adapters.set(adapter.kernelId, adapter);
  }

  normalize(payload: unknown, context: UsageAdapterContext): CanonicalUsageEventPayload {
    const adapter = this.adapters.get(context.kernelId);
    if (!adapter) return normalize(payload, context, 'runtime-event');
    return adapter.normalize(payload, context);
  }
}
