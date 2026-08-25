export interface AgentSummary {
  id: string;
  name: string;
  modelDisplay: string;
  modelRef?: string | null;
  overrideModelRef?: string | null;
  inheritedModel: boolean;
  workspace: string;
  agentDir: string;
  mainSessionKey: string;
  channelTypes: string[];
  description?: string;
  persona?: string;
  presetId?: string;
  supportedKernels: string[];
  defaultForKernels: string[];
  projections: AgentKernelProjection[];
  version: number;
  deletedAt?: string;
}

export interface AgentKernelProjection {
  kernelId: string;
  status: 'pending' | 'applying' | 'ready' | 'partial' | 'failed' | 'unsupported';
  desiredVersion: number;
  appliedVersion?: number;
  nativeId?: string;
  error?: string;
  updatedAt: string;
}

export interface AgentKernelDefault {
  kernelId: string;
  agentId: string;
  updatedAt: string;
}

export interface AgentsSnapshot {
  agents: AgentSummary[];
  kernelDefaults: AgentKernelDefault[];
  /** @deprecated OpenClaw-only compatibility value; never used as Agent authority. */
  defaultModelRef?: string | null;
  configuredChannelTypes: string[];
  channelOwners: Record<string, string>;
  channelAccountOwners: Record<string, string>;
}
