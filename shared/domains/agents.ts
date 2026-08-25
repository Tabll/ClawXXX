import type { KernelId } from '../kernels/contracts';
import type { AgentId, KernelEntityProjection } from './identity';

export type CanonicalModelSelection = {
  providerAccountId?: string;
  providerId: string;
  modelId: string;
  parameters?: Record<string, string | number | boolean>;
};

export type CanonicalAgent = {
  id: AgentId;
  displayName: string;
  description?: string;
  persona?: string;
  /** Optional native composition/preset selected by adapters that support it. */
  presetId?: string;
  workspaceUri: string;
  model?: CanonicalModelSelection;
  enabled: boolean;
  supportedKernels: KernelId[];
  defaultForKernels: KernelId[];
  projections: KernelEntityProjection[];
  version: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
};

export type KernelAgentDefault = {
  kernelId: KernelId;
  agentId: AgentId;
  updatedAt: string;
};

export type AgentRunSnapshot = {
  agentId: AgentId;
  displayName: string;
  kernelId: KernelId;
  workspaceUri: string;
  persona?: string;
  presetId?: string;
  model?: CanonicalModelSelection;
  canonicalVersion: number;
  /** Set only when rendering a historical run whose canonical Agent was later deleted. */
  deletedReference?: boolean;
};
