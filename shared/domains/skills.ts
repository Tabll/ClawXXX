import type { KernelId } from '../kernels/contracts';
import type { KernelEntityProjection, SkillId } from './identity';

export type SkillCompatibility = {
  kernelId: KernelId;
  compatible: boolean;
  mode: 'native' | 'converted' | 'patched' | 'unsupported';
  reason?: string;
};

export type CanonicalSkill = {
  id: SkillId;
  slug: string;
  displayName: string;
  description: string;
  icon?: string;
  author?: string;
  isCore?: boolean;
  version: string;
  /** Monotonic canonical metadata/content revision used by projections. */
  revision: number;
  source: {
    kind: 'bundled' | 'marketplace' | 'local';
    /** Canonical package root. Kernel roots must never be used as this locator. */
    locator: string;
    digestSha256?: string;
  };
  /** Desired native installation set; projection rows record observed state. */
  installedForKernels: KernelId[];
  enabledForKernels: KernelId[];
  compatibility: SkillCompatibility[];
  projections: KernelEntityProjection[];
  configSchema?: unknown;
  config?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
};

export type SkillMutationTarget = KernelId | 'all-installed';

export type SkillMutationResult = {
  skillId: SkillId;
  results: Array<{
    kernelId: KernelId;
    ok: boolean;
    error?: { code: string; message: string; retryable: boolean };
  }>;
};
