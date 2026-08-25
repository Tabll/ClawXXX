import { randomUUID } from 'node:crypto';
import type { CanonicalSkill, SkillMutationResult } from '@shared/domains/skills';
import type { KernelId } from '@shared/kernels/contracts';
import type { CanonicalSkillPackageStore } from './skill-package-store';
import { compatibilityForKernel, stripSkillFrontmatter } from './skill-compatibility';

export type SkillProjectionDataClient = {
  call<T = unknown>(method: string, ...args: unknown[]): Promise<T>;
};

export type SkillProjectionPayload = Omit<CanonicalSkill, 'projections' | 'deletedAt'> & {
  enabled: boolean;
  instructionBody: string;
};

export interface SkillKernelProjectionAdapter {
  readonly kernelId: KernelId;
  available(): boolean | Promise<boolean>;
  upsert(skill: SkillProjectionPayload, operationId: string): Promise<{ nativeId?: string; partial?: boolean }>;
  remove(nativeId: string, operationId: string): Promise<void>;
}

export type SkillProjectionResult = {
  kernelId: KernelId;
  skillId: string;
  status: 'ready' | 'partial' | 'pending' | 'failed' | 'unsupported';
  nativeId?: string;
  error?: { code: string; message: string; retryable: boolean };
};

function resultError(code: string, message: string, retryable: boolean): SkillProjectionResult['error'] {
  return { code, message, retryable };
}

export function projectionResultsToMutation(
  skillId: CanonicalSkill['id'],
  results: SkillProjectionResult[],
): SkillMutationResult {
  return {
    skillId,
    results: results.map(result => ({
      kernelId: result.kernelId,
      ok: result.status === 'ready',
      ...(result.status === 'ready' ? {} : {
        error: result.error ?? resultError(
          result.status === 'partial' ? 'SKILL_PARTIAL' : `SKILL_${result.status.toUpperCase()}`,
          result.status === 'partial'
            ? 'The kernel applied only part of the Skill projection.'
            : `Skill projection is ${result.status}.`,
          result.status !== 'unsupported',
        ),
      }),
    })),
  };
}

export class SkillProjectionReconciler {
  private readonly adapters = new Map<KernelId, SkillKernelProjectionAdapter>();

  constructor(
    private readonly data: SkillProjectionDataClient,
    private readonly packages: CanonicalSkillPackageStore,
    adapters: SkillKernelProjectionAdapter[],
    private readonly now: () => Date = () => new Date(),
  ) {
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.kernelId)) throw new Error(`Duplicate Skill projection adapter: ${adapter.kernelId}`);
      this.adapters.set(adapter.kernelId, adapter);
    }
  }

  kernelIds(): KernelId[] {
    return [...this.adapters.keys()];
  }

  async reconcileSkill(skillId: string, kernelIds = this.kernelIds()): Promise<SkillProjectionResult[]> {
    const skill = await this.data.call<CanonicalSkill | undefined>('getSkill', skillId);
    if (!skill) throw new Error(`Skill not found: ${skillId}`);
    return Promise.all(kernelIds.map(kernelId => this.reconcileOne(skill, kernelId)));
  }

  async reconcileAll(kernelId?: KernelId): Promise<SkillProjectionResult[]> {
    const skills = await this.data.call<CanonicalSkill[]>('listSkills');
    const kernels = kernelId ? [kernelId] : this.kernelIds();
    return Promise.all(skills.flatMap(skill => kernels.map(candidate => this.reconcileOne(skill, candidate))));
  }

  async reconcileDeleted(kernelId?: KernelId): Promise<SkillProjectionResult[]> {
    const skills = await this.data.call<CanonicalSkill[]>('listSkills', true);
    const deleted = skills.filter(skill => skill.deletedAt);
    return Promise.all(deleted.flatMap(skill => {
      const projections = kernelId
        ? skill.projections.filter(projection => projection.kernelId === kernelId)
        : skill.projections;
      return projections.map(projection => this.removeOne(skill, projection.kernelId));
    }));
  }

  async removeSkill(skill: CanonicalSkill): Promise<SkillProjectionResult[]> {
    return Promise.all(skill.projections.map(projection => this.removeOne(skill, projection.kernelId)));
  }

  private async reconcileOne(skill: CanonicalSkill, kernelId: KernelId): Promise<SkillProjectionResult> {
    const existing = skill.projections.find(projection => projection.kernelId === kernelId);
    const adapter = this.adapters.get(kernelId);
    if (!skill.installedForKernels.includes(kernelId)) return this.removeOne(skill, kernelId);

    const compatibility = compatibilityForKernel(skill.compatibility, kernelId);
    if (!compatibility?.compatible) {
      if (existing?.nativeId && adapter && await adapter.available()) {
        try { await adapter.remove(existing.nativeId, randomUUID()); } catch { /* retain canonical diagnostic below */ }
      }
      const message = compatibility?.reason ?? `Skill compatibility is not declared for ${kernelId}`;
      await this.writeProjection(skill, kernelId, 'unsupported', undefined, message);
      return {
        kernelId,
        skillId: skill.id,
        status: 'unsupported',
        error: resultError('SKILL_INCOMPATIBLE', message, false),
      };
    }
    if (!adapter) {
      const message = `No Skill adapter is registered for ${kernelId}`;
      await this.writeProjection(skill, kernelId, 'unsupported', existing?.nativeId, message);
      return { kernelId, skillId: skill.id, status: 'unsupported', error: resultError('SKILL_ADAPTER_MISSING', message, false) };
    }
    if (!await adapter.available()) {
      const message = `Kernel ${kernelId} is not installed or ready`;
      await this.writeProjection(skill, kernelId, 'pending', existing?.nativeId, message);
      return { kernelId, skillId: skill.id, status: 'pending', error: resultError('KERNEL_UNAVAILABLE', message, true) };
    }

    await this.writeProjection(skill, kernelId, 'applying', existing?.nativeId);
    try {
      const instructions = stripSkillFrontmatter(await this.packages.readInstructions(skill.source.locator));
      const { projections: _projections, deletedAt: _deletedAt, ...canonical } = skill;
      const applied = await adapter.upsert({
        ...canonical,
        enabled: skill.enabledForKernels.includes(kernelId),
        instructionBody: instructions,
      }, randomUUID());
      const status = applied.partial ? 'partial' : 'ready';
      const nativeId = applied.nativeId ?? skill.slug;
      await this.writeProjection(skill, kernelId, status, nativeId);
      return {
        kernelId,
        skillId: skill.id,
        status,
        nativeId,
        ...(status === 'partial'
          ? { error: resultError('SKILL_PARTIAL', 'The kernel reported a partial Skill projection.', true) }
          : {}),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.writeProjection(skill, kernelId, 'failed', existing?.nativeId, message);
      return {
        kernelId,
        skillId: skill.id,
        status: 'failed',
        error: resultError('SKILL_PROJECTION_FAILED', message, true),
      };
    }
  }

  private async removeOne(skill: CanonicalSkill, kernelId: KernelId): Promise<SkillProjectionResult> {
    const projection = skill.projections.find(candidate => candidate.kernelId === kernelId);
    if (!projection) return { kernelId, skillId: skill.id, status: 'ready' };
    if (!projection.nativeId) {
      await this.data.call('deleteProjection', 'skill', skill.id, kernelId);
      return { kernelId, skillId: skill.id, status: 'ready' };
    }
    const adapter = this.adapters.get(kernelId);
    if (!adapter) {
      const message = `No Skill adapter is registered for ${kernelId}`;
      await this.writeProjection(skill, kernelId, 'unsupported', projection.nativeId, message);
      return { kernelId, skillId: skill.id, status: 'unsupported', error: resultError('SKILL_ADAPTER_MISSING', message, false) };
    }
    if (!await adapter.available()) {
      const message = `Kernel ${kernelId} is not installed or ready`;
      await this.writeProjection(skill, kernelId, 'pending', projection.nativeId, message);
      return { kernelId, skillId: skill.id, status: 'pending', error: resultError('KERNEL_UNAVAILABLE', message, true) };
    }
    try {
      await adapter.remove(projection.nativeId, randomUUID());
      await this.data.call('deleteProjection', 'skill', skill.id, kernelId);
      return { kernelId, skillId: skill.id, status: 'ready', nativeId: projection.nativeId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.writeProjection(skill, kernelId, 'failed', projection.nativeId, message);
      return {
        kernelId,
        skillId: skill.id,
        status: 'failed',
        nativeId: projection.nativeId,
        error: resultError('SKILL_REMOVE_FAILED', message, true),
      };
    }
  }

  private async writeProjection(
    skill: CanonicalSkill,
    kernelId: KernelId,
    status: string,
    nativeId?: string,
    error?: string,
  ): Promise<void> {
    await this.data.call('upsertProjection', {
      entityType: 'skill',
      entityId: skill.id,
      kernelId,
      desiredVersion: skill.revision,
      ...(status === 'ready' || status === 'partial' ? { appliedVersion: skill.revision } : {}),
      status,
      ...(nativeId ? { nativeId } : {}),
      ...(error ? { error } : {}),
      updatedAt: this.now().toISOString(),
    });
  }
}
