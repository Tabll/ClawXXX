import type { KernelId } from '../kernels/contracts';

declare const agentIdBrand: unique symbol;
declare const providerAccountIdBrand: unique symbol;
declare const skillIdBrand: unique symbol;
declare const channelAccountIdBrand: unique symbol;
declare const channelBindingIdBrand: unique symbol;
declare const cronJobIdBrand: unique symbol;

export type AgentId = string & { readonly [agentIdBrand]: true };
export type ProviderAccountId = string & { readonly [providerAccountIdBrand]: true };
export type SkillId = string & { readonly [skillIdBrand]: true };
export type ChannelAccountId = string & { readonly [channelAccountIdBrand]: true };
export type ChannelBindingId = string & { readonly [channelBindingIdBrand]: true };
export type CronJobId = string & { readonly [cronJobIdBrand]: true };

export type KernelScopedEntityIdentity = {
  kernelId: KernelId;
  /** Absent until a projection has created or discovered its native entity. */
  nativeId?: string;
};

export type KernelProjectionState = 'pending' | 'applying' | 'ready' | 'partial' | 'failed' | 'unsupported';

export type KernelEntityProjection = KernelScopedEntityIdentity & {
  state: KernelProjectionState;
  desiredVersion: number;
  appliedVersion?: number;
  error?: { code: string; message: string; retryable: boolean };
  updatedAt: string;
};

export const asAgentId = (value: string) => value as AgentId;
export const asProviderAccountId = (value: string) => value as ProviderAccountId;
export const asSkillId = (value: string) => value as SkillId;
export const asChannelAccountId = (value: string) => value as ChannelAccountId;
export const asChannelBindingId = (value: string) => value as ChannelBindingId;
export const asCronJobId = (value: string) => value as CronJobId;
