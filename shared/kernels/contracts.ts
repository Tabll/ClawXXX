import type { CanonicalContentBlock, ConversationId, RunId, TurnId } from '../conversations/contracts';
import type { ConversationStoreProtocolClient } from '../conversations/store-protocol';
import type { CanonicalAgent } from '../domains/agents';
import type { CanonicalChannelAccount, CanonicalChannelBinding } from '../domains/channels';
import type { CanonicalCronJob } from '../domains/cron';
import type { CanonicalProviderAccount } from '../domains/providers';
import type { CanonicalSkill } from '../domains/skills';
import type { CanonicalUsage, UsageQuery } from '../domains/usage';

export type KernelId = 'openclaw' | 'deepseek-harness' | (string & {});

export type KernelGeneration = number;

export const KERNEL_CONTRACT_PROTOCOL = 'clawx.kernel/v1' as const;

export type KernelLifecycleState =
  | 'not-installed'
  | 'installed'
  | 'starting'
  | 'ready'
  | 'stopping'
  | 'stopped'
  | 'degraded'
  | 'crash-loop'
  | 'failed'
  | 'incompatible';

export type KernelProcessOwnership = 'clawx-owned' | 'external';

export type KernelRuntimeExit = {
  at: string;
  code?: number | null;
  signal?: NodeJS.Signals | null;
  unexpected: boolean;
  message?: string;
};

export type KernelRollbackSuggestion = {
  at: string;
  artifactVersion?: string;
  reason: 'crash-loop' | 'health-failure';
  crashCount: number;
};

export type KernelCapabilities = {
  chat: boolean;
  cancel: boolean;
  permissions: boolean;
  resume: boolean;
  configuration: boolean;
  agents: boolean;
  providers: boolean;
  skills: boolean;
  channels: boolean;
  cron: boolean;
  usage: boolean;
  checkpointCodecs: string[];
};

export type KernelDefinition = {
  id: KernelId;
  displayName: string;
  contractVersion: 1;
  storeProtocolRange: string;
  capabilities: KernelCapabilities;
};

export type KernelRuntimeSnapshot = {
  kernelId: KernelId;
  state: KernelLifecycleState;
  generation: KernelGeneration;
  version?: string;
  artifactVersion?: string;
  pid?: number;
  ownership?: KernelProcessOwnership;
  autoStart?: boolean;
  autoRestart?: boolean;
  restartCount?: number;
  restartBudget?: number;
  restartWindowMs?: number;
  nextRestartAt?: string;
  rollbackSuggested?: KernelRollbackSuggestion;
  lastExit?: KernelRuntimeExit;
  lastError?: string;
  startedAt?: string;
  lastHealthAt?: string;
  startupDurationMs?: number;
  rssBytes?: number;
  runtimeTransport?: 'in-process-driver' | 'stdio-jsonl';
  capabilities?: KernelCapabilities;
  diagnostics: string[];
};

export type KernelEventKind =
  | 'assistant.delta'
  | 'assistant.final'
  | 'reasoning.visibility'
  | 'tool.start'
  | 'tool.progress'
  | 'tool.result'
  | 'permission.request'
  | 'permission.resolved'
  | 'usage'
  | 'diagnostic'
  | 'cancel.acknowledged'
  | 'run.terminal';

export type KernelEventEnvelopeV1<T = unknown> = {
  protocol: typeof KERNEL_CONTRACT_PROTOCOL;
  conversationId: string;
  turnId: string;
  runId: string;
  kernelId: KernelId;
  generation: KernelGeneration;
  eventSeq: number;
  emittedAt: string;
  nativeEventId?: string;
  event: {
    kind: KernelEventKind;
    payload: T;
  };
};

export type KernelDriver = {
  readonly definition: KernelDefinition;
  initialize(host: KernelDriverHost): Promise<void>;
  start(): Promise<KernelRuntimeSnapshot>;
  stop(): Promise<void>;
  health(): Promise<KernelRuntimeSnapshot>;
  execute(input: KernelRunRequest): Promise<KernelRunAcceptance>;
  cancel(input: KernelRunIdentity): Promise<{ acknowledged: boolean }>;
  resolvePermission(input: KernelPermissionResolution): Promise<void>;
  updateRunConfiguration(input: KernelRunConfiguration): Promise<void>;
  readonly control: KernelControlPlane;
};

export type KernelRunIdentity = {
  conversationId: ConversationId;
  turnId: TurnId;
  runId: RunId;
  kernelId: KernelId;
  generation: KernelGeneration;
};

export type KernelRunRequest = KernelRunIdentity & {
  context: CanonicalContentBlock[];
  agentId: string;
  workspaceUri: string;
  providerId?: string;
  modelId?: string;
  permissionMode?: 'default' | 'ask' | 'deny';
  attachments?: Array<{ blockId: string; blobHash: string; accessGrantId: string }>;
};

export type KernelRunAcceptance = KernelRunIdentity & {
  acceptedAt: string;
  nativeSessionId?: string;
};

export type KernelPermissionResolution = KernelRunIdentity & {
  requestId: string;
  decision: 'allow-once' | 'reject-once';
  /** Selected runtime option for ask-user style interactions. */
  optionId?: string;
  /** Optional free-form answer. Never used for secrets. */
  answer?: string;
};

export type KernelRunConfiguration = KernelRunIdentity & {
  providerId?: string;
  modelId?: string;
  permissionMode?: 'default' | 'ask' | 'deny';
};

export type KernelDriverHost = {
  readonly store: ConversationStoreProtocolClient;
  emit(event: KernelEventEnvelopeV1): Promise<void>;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>): void;
  requestCredential(input: {
    kernelId: KernelId;
    generation: KernelGeneration;
    accountId: string;
    purpose: 'model-request' | 'channel-connect' | 'provider-validate';
  }): Promise<string>;
};

export type CanonicalEntityController<T extends { id: string }> = {
  list(): Promise<T[]>;
  upsert(entity: T, operationId: string): Promise<T>;
  remove(id: T['id'], operationId: string): Promise<void>;
};

export type CanonicalProviderController = CanonicalEntityController<CanonicalProviderAccount> & {
  setDefault?(input: { accountId: string; modelId?: string }, operationId: string): Promise<void>;
};

export type KernelControlPlane = {
  agents: CanonicalEntityController<CanonicalAgent>;
  providers: CanonicalProviderController;
  skills: CanonicalEntityController<CanonicalSkill>;
  channels: {
    accounts: CanonicalEntityController<CanonicalChannelAccount>;
    bindings: CanonicalEntityController<CanonicalChannelBinding>;
  };
  cron: CanonicalEntityController<CanonicalCronJob>;
  usage: { query(input: UsageQuery): Promise<CanonicalUsage[]> };
  diagnostics(): Promise<Record<string, unknown>>;
};
