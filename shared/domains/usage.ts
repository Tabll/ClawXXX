import type { ConversationId, RunId } from '../conversations/contracts';
import type { KernelId } from '../kernels/contracts';

export type UsageSource = 'runtime-event' | 'provider-response';

/**
 * One billable model call reported by a managed runtime. Optional numeric
 * fields are intentionally not defaulted: an unknown value is different from
 * a provider-reported zero.
 */
export type CanonicalUsage = {
  id: string;
  eventKey: string;
  runId: RunId;
  kernelId: KernelId;
  conversationId?: ConversationId;
  agentId?: string;
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
  source: UsageSource;
  recordedAt: string;
};

export type UsageQuery = {
  from: string;
  to: string;
  kernelIds?: KernelId[];
  agentIds?: string[];
  providerIds?: string[];
  modelIds?: string[];
  timeZone?: string;
};

export type UsageAggregate = {
  kernelId?: KernelId;
  agentId?: string;
  providerId?: string;
  modelId?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  cost?: number;
  currency?: string;
  runCount: number;
  entryCount: number;
};
