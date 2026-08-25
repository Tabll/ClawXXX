import type { CompleteHostServiceRegistry } from '../main/ipc/host-contract';
import type { RemoteDataServiceClient } from '../data/data-service-utility-host';
import type { UsageHistoryEntry } from '@shared/host-api/contract';
import type { KernelId } from '@shared/kernels/contracts';

type CanonicalDataClient = Pick<RemoteDataServiceClient, 'call'>;

function safeLimit(payload: unknown): number {
  const raw = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as { limit?: unknown }).limit
    : payload;
  const value = typeof raw === 'number' ? raw : Number(raw ?? 5_000);
  return Number.isFinite(value) ? Math.min(Math.max(Math.floor(value), 1), 20_000) : 5_000;
}

function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function toUsageEntry(row: Record<string, unknown>): UsageHistoryEntry {
  const inputTokens = numeric(row.inputTokens);
  const outputTokens = numeric(row.outputTokens);
  const cacheReadTokens = numeric(row.cacheReadTokens);
  const cacheWriteTokens = numeric(row.cacheWriteTokens);
  const explicitTotal = numeric(row.totalTokens);
  const totalTokens = explicitTotal ?? (
    [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens].every(value => value !== undefined)
      ? inputTokens! + outputTokens! + cacheReadTokens! + cacheWriteTokens!
      : undefined
  );
  const cost = numeric(row.cost) ?? numeric(row.costUsd);
  const currency = typeof row.currency === 'string' && row.currency.trim()
    ? row.currency.trim().toUpperCase()
    : numeric(row.costUsd) !== undefined ? 'USD' : undefined;
  const available = [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens, cost]
    .some(value => value !== undefined);
  return {
    id: String(row.id),
    eventKey: String(row.eventKey),
    runId: String(row.runId),
    kernelId: String(row.kernelId) as KernelId,
    timestamp: String(row.recordedAt),
    sessionId: String(row.conversationId ?? row.runId),
    agentId: String(row.agentId ?? 'unknown'),
    ...(typeof row.requestId === 'string' ? { requestId: row.requestId } : {}),
    source: row.source === 'provider-response' ? 'provider-response' : 'runtime-event',
    ...(typeof row.modelId === 'string' ? { model: row.modelId } : {}),
    ...(typeof row.providerId === 'string' ? { provider: row.providerId } : {}),
    usageStatus: available ? 'available' : 'missing',
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cost !== undefined ? { cost } : {}),
    ...(currency ? { currency } : {}),
    ...(cost !== undefined && currency === 'USD' ? { costUsd: cost } : {}),
    sessionMeta: {
      key: String(row.conversationId ?? row.runId),
      usageFamilyKey: String(row.kernelId ?? 'unknown'),
    },
  };
}

function dateBoundary(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error('Usage query date boundary is invalid');
  }
  return new Date(value).toISOString();
}

function stringList(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string' || !entry.trim())) {
    throw new Error(`Usage query ${field} is invalid`);
  }
  const unique = [...new Set(value.map(entry => String(entry).trim()))];
  if (unique.length > 100) throw new Error(`Usage query ${field} exceeds the selection limit`);
  return unique;
}

function queryOf(payload: unknown, defaults: { from: string; to: string }) {
  const body = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
  const from = dateBoundary(body.from, defaults.from);
  const to = dateBoundary(body.to, defaults.to);
  if (Date.parse(from) >= Date.parse(to)) throw new Error('Usage query range must be increasing');
  const kernelIds = stringList(body.kernelIds, 'kernelIds') as KernelId[] | undefined;
  const agentIds = stringList(body.agentIds, 'agentIds');
  const providerIds = stringList(body.providerIds, 'providerIds');
  const modelIds = stringList(body.modelIds, 'modelIds');
  return {
    from,
    to,
    ...(kernelIds ? { kernelIds } : {}),
    ...(agentIds ? { agentIds } : {}),
    ...(providerIds ? { providerIds } : {}),
    ...(modelIds ? { modelIds } : {}),
  };
}

/** Canonical usage compatibility API. Runtime transcripts are never scanned. */
export function createUsageApi(options: { dataClient?: CanonicalDataClient } = {}): CompleteHostServiceRegistry['usage'] {
  return {
    recentTokenHistory: async payload => {
      if (!options.dataClient) throw new Error('Canonical Usage DataService is unavailable');
      const query = queryOf(payload, {
        from: '1970-01-01T00:00:00.000Z',
        to: '9999-12-31T23:59:59.999Z',
      });
      const rows = await options.dataClient.call<Array<Record<string, unknown>>>('listUsage', {
        ...query,
      });
      return rows.slice(-safeLimit(payload)).map(toUsageEntry);
    },
    query: async payload => {
      if (!options.dataClient) throw new Error('Canonical Usage DataService is unavailable');
      const query = queryOf(payload, { from: payload.from, to: payload.to });
      const rows = await options.dataClient.call<Array<Record<string, unknown>>>('listUsage', query);
      return rows.slice(-safeLimit(payload)).map(toUsageEntry);
    },
  };
}
