import type { GatewayManager } from '../gateway/manager';
import type { ClawHubService, ClawHubInstallParams, ClawHubSearchParams, ClawHubUninstallParams } from '../gateway/clawhub';
import type { CompleteHostServiceRegistry } from '../main/ipc/host-contract';
import { getAllSkillConfigs, getSkillConfig, updateSkillConfig, updateSkillConfigs } from '../utils/skill-config';
import {
  collectQuickAccessSkills,
  filterEnabledQuickAccessSkills,
  type QuickAccessRuntimeSkillStatus,
} from '../utils/skill-quick-access';
import { listLocalSkills } from './skills/local-skill-service';
import { isRecord } from './payload-utils';
import type { CanonicalSkill, SkillMutationResult, SkillMutationTarget } from '@shared/domains/skills';
import type { KernelId } from '@shared/kernels/contracts';
import type { Skill } from '@shared/types/skill';
import type { CanonicalSkillService, SkillDesiredMutation } from '../domains/skills/skill-service';
import {
  projectionResultsToMutation,
  type SkillProjectionReconciler,
} from '../domains/skills/skill-projection-reconciler';

type SkillConfigPayload = {
  skillKey?: unknown;
  enabled?: unknown;
  apiKey?: unknown;
  env?: unknown;
};

type SkillConfigsPayload = {
  updates?: unknown;
};

type NormalizedSkillConfigUpdate = {
  skillKey: string;
  enabled?: boolean;
  apiKey?: string;
  env?: Record<string, string>;
};

type QuickAccessPayload = {
  workspace?: unknown;
};

type SkillOpenPayload = {
  slug?: unknown;
  skillKey?: unknown;
  baseDir?: unknown;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getSkillKey(payload: unknown): string {
  const body = isRecord(payload) ? payload as SkillConfigPayload : {};
  if (typeof body.skillKey !== 'string' || !body.skillKey.trim()) {
    throw new Error('skillKey is required');
  }
  return body.skillKey.trim();
}

function getEnv(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

function getConfigUpdate(payload: unknown): NormalizedSkillConfigUpdate {
  const body = isRecord(payload) ? payload as SkillConfigPayload : {};
  return {
    skillKey: getSkillKey(payload),
    enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
    apiKey: typeof body.apiKey === 'string' ? body.apiKey : undefined,
    env: getEnv(body.env),
  };
}

function getConfigUpdates(payload: unknown): NormalizedSkillConfigUpdate[] {
  const body = isRecord(payload) ? payload as SkillConfigsPayload : {};
  if (!Array.isArray(body.updates)) return [];
  return body.updates.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const skillKey = typeof entry.skillKey === 'string' ? entry.skillKey.trim() : '';
    if (!skillKey) return [];
    return [{
      skillKey,
      enabled: typeof entry.enabled === 'boolean' ? entry.enabled : undefined,
      apiKey: typeof entry.apiKey === 'string' ? entry.apiKey : undefined,
      env: getEnv(entry.env),
    }];
  });
}

const CURRENT_KERNELS = new Set<KernelId>(['openclaw', 'deepseek-harness']);

function canonicalSkillToLegacy(skill: CanonicalSkill): Skill {
  return {
    id: skill.id,
    slug: skill.slug,
    name: skill.displayName,
    description: skill.description,
    enabled: skill.enabledForKernels.length > 0,
    icon: skill.icon ?? '📦',
    version: skill.version,
    author: skill.author,
    config: skill.config,
    isCore: skill.isCore,
    isBundled: skill.source.kind === 'bundled',
    source: `canonical-${skill.source.kind}`,
    baseDir: skill.source.locator,
    filePath: `${skill.source.locator}/SKILL.md`,
    revision: skill.revision,
    installedForKernels: skill.installedForKernels,
    enabledForKernels: skill.enabledForKernels,
    compatibility: skill.compatibility,
    projections: skill.projections,
  };
}

function mutationPayload(payload: unknown): {
  skillId: string;
  mutation: SkillDesiredMutation | 'update';
  target: SkillMutationTarget;
} {
  if (!isRecord(payload)) throw new Error('Canonical Skill mutation payload is required');
  const skillId = typeof payload.skillId === 'string' ? payload.skillId.trim() : '';
  const mutation = payload.mutation;
  const target = payload.target;
  if (!skillId) throw new Error('skillId is required');
  if (mutation !== 'install' && mutation !== 'uninstall' && mutation !== 'update'
    && mutation !== 'enable' && mutation !== 'disable') throw new Error('Invalid canonical Skill mutation');
  if (target !== 'all-installed' && (typeof target !== 'string' || !CURRENT_KERNELS.has(target as KernelId))) {
    throw new Error('Invalid canonical Skill target');
  }
  return { skillId, mutation, target: target as SkillMutationTarget };
}

function payloadTarget(payload: unknown, fallback: SkillMutationTarget = 'openclaw'): SkillMutationTarget {
  const value = isRecord(payload) ? payload.target : undefined;
  if (value === 'all-installed') return value;
  if (typeof value === 'string' && CURRENT_KERNELS.has(value as KernelId)) return value as KernelId;
  return fallback;
}

function targetKernels(
  skill: CanonicalSkill,
  target: SkillMutationTarget,
  mutation: SkillDesiredMutation | 'update',
  reconciler: SkillProjectionReconciler,
): KernelId[] {
  if (target !== 'all-installed') return [target];
  if (mutation === 'install') return reconciler.kernelIds();
  return skill.installedForKernels.length > 0 ? skill.installedForKernels : reconciler.kernelIds();
}

function requireCanonical(input: {
  service?: CanonicalSkillService;
  reconciler?: SkillProjectionReconciler;
}): { service: CanonicalSkillService; reconciler: SkillProjectionReconciler } {
  if (!input.service || !input.reconciler) throw new Error('Canonical Skills service is unavailable');
  return { service: input.service, reconciler: input.reconciler };
}

export function createSkillsApi({
  clawHubService,
  gatewayManager,
  canonicalService,
  projectionReconciler,
}: {
  clawHubService: ClawHubService;
  gatewayManager: GatewayManager;
  canonicalService?: CanonicalSkillService;
  projectionReconciler?: SkillProjectionReconciler;
}): CompleteHostServiceRegistry['skills'] {
  const reconcileMutation = async (
    skill: CanonicalSkill,
    mutation: SkillDesiredMutation | 'update',
    target: SkillMutationTarget,
  ): Promise<SkillMutationResult> => {
    const { reconciler } = requireCanonical({ service: canonicalService, reconciler: projectionReconciler });
    const kernels = targetKernels(skill, target, mutation, reconciler);
    return projectionResultsToMutation(skill.id, await reconciler.reconcileSkill(skill.id, kernels));
  };

  return {
    catalog: async () => {
      const { service } = requireCanonical({ service: canonicalService, reconciler: projectionReconciler });
      return { success: true, skills: await service.list() };
    },
    mutate: async (payload) => {
      const { service, reconciler } = requireCanonical({ service: canonicalService, reconciler: projectionReconciler });
      const input = mutationPayload(payload);
      const existing = await service.get(input.skillId);
      if (!existing) throw new Error(`Skill not found: ${input.skillId}`);
      const kernels = targetKernels(existing, input.target, input.mutation, reconciler);
      let skill = existing;
      if (input.mutation === 'update') {
        if (existing.source.kind === 'marketplace') {
          await clawHubService.install({ slug: existing.slug, force: true });
          const record = (await listLocalSkills()).find(candidate => candidate.slug === existing.slug || candidate.id === existing.id);
          if (!record) throw new Error(`Updated Skill package was not found: ${existing.slug}`);
          skill = await service.importLocalSkill(record, {
            sourceKind: existing.source.kind,
            installedForKernels: existing.installedForKernels,
            enabledForKernels: existing.enabledForKernels,
          });
          if (!existing.installedForKernels.includes('openclaw')) await clawHubService.uninstall({ slug: existing.slug });
        }
      } else {
        skill = await service.mutateDesired(existing.id, input.mutation, kernels);
      }
      return projectionResultsToMutation(skill.id, await reconciler.reconcileSkill(skill.id, kernels));
    },
    retry: async (payload) => {
      if (!isRecord(payload)
        || typeof payload.skillId !== 'string'
        || typeof payload.kernelId !== 'string'
        || !CURRENT_KERNELS.has(payload.kernelId as KernelId)) throw new Error('Invalid Skill retry payload');
      const { service, reconciler } = requireCanonical({ service: canonicalService, reconciler: projectionReconciler });
      const skill = await service.get(payload.skillId);
      if (!skill) throw new Error(`Skill not found: ${payload.skillId}`);
      const results = await reconciler.reconcileSkill(skill.id, [payload.kernelId as KernelId]);
      return projectionResultsToMutation(skill.id, results);
    },
    local: async () => canonicalService
      ? { success: true, skills: (await canonicalService.list()).map(canonicalSkillToLegacy) }
      : { success: true, skills: await listLocalSkills() },
    configs: async () => getAllSkillConfigs(),
    allConfigs: async () => getAllSkillConfigs(),
    getConfig: async (payload) => {
      const config = await getSkillConfig(getSkillKey(payload));
      return config ? { ...config } : undefined;
    },
    updateConfig: async (payload) => {
      const { skillKey, ...updates } = getConfigUpdate(payload);
      const result = await updateSkillConfig(skillKey, updates);
      if (canonicalService && projectionReconciler && typeof updates.enabled === 'boolean') {
        const skill = await canonicalService.get(skillKey) ?? await canonicalService.findBySlug(skillKey);
        if (skill) {
          const kernels = skill.installedForKernels;
          if (kernels.length > 0) {
            await canonicalService.mutateDesired(skill.id, updates.enabled ? 'enable' : 'disable', kernels);
            await projectionReconciler.reconcileSkill(skill.id, kernels);
          }
        }
      }
      return result;
    },
    updateConfigs: async (payload) => {
      const updates = getConfigUpdates(payload);
      const result = await updateSkillConfigs(updates);
      if (canonicalService && projectionReconciler) {
        for (const update of updates) {
          if (typeof update.enabled !== 'boolean') continue;
          const skill = await canonicalService.get(update.skillKey) ?? await canonicalService.findBySlug(update.skillKey);
          if (!skill || skill.installedForKernels.length === 0) continue;
          await canonicalService.mutateDesired(skill.id, update.enabled ? 'enable' : 'disable', skill.installedForKernels);
          await projectionReconciler.reconcileSkill(skill.id, skill.installedForKernels);
        }
      }
      return result;
    },
    status: async () => gatewayManager.rpc('skills.status'),
    update: async (payload) => gatewayManager.rpc('skills.update', isRecord(payload) ? payload : {}),
    quickAccess: async (payload) => {
      const body = isRecord(payload) ? payload as QuickAccessPayload : {};
      const [scannedSkills, configs] = await Promise.all([
        collectQuickAccessSkills({
          workspace: typeof body.workspace === 'string' ? body.workspace : undefined,
        }),
        getAllSkillConfigs(),
      ]);
      let runtimeSkills: QuickAccessRuntimeSkillStatus[] | undefined;
      if (gatewayManager.getStatus().state === 'running') {
        try {
          const runtimeStatus = await gatewayManager.rpc<{ skills?: QuickAccessRuntimeSkillStatus[] }>('skills.status');
          runtimeSkills = runtimeStatus.skills || [];
        } catch {
          runtimeSkills = undefined;
        }
      }
      return {
        success: true,
        skills: filterEnabledQuickAccessSkills(scannedSkills, runtimeSkills, configs),
      };
    },
    clawhubCapability: async () => {
      try {
        return { success: true, capability: await clawHubService.getMarketplaceCapability() };
      } catch (error) {
        return { success: false, error: errorMessage(error) };
      }
    },
    clawhubList: async () => {
      try {
        return { success: true, results: await clawHubService.listInstalled() };
      } catch (error) {
        return { success: false, error: errorMessage(error) };
      }
    },
    clawhubSearch: async (payload) => {
      try {
        return { success: true, results: await clawHubService.search((isRecord(payload) ? payload : {}) as ClawHubSearchParams) };
      } catch (error) {
        return { success: false, error: errorMessage(error) };
      }
    },
    clawhubInstall: async (payload) => {
      try {
        const body = (isRecord(payload) ? payload : {}) as ClawHubInstallParams;
        await clawHubService.install(body);
        if (!canonicalService || !projectionReconciler) return { success: true };
        const slug = typeof body.slug === 'string' ? body.slug.trim() : '';
        const record = (await listLocalSkills()).find(candidate => candidate.slug === slug || candidate.id === slug);
        if (!record) throw new Error(`Installed Skill package was not found: ${slug}`);
        const target = payloadTarget(payload);
        const existing = await canonicalService.findBySlug(slug, true);
        const kernels = target === 'all-installed' ? projectionReconciler.kernelIds() : [target];
        const installed = [...new Set([...(existing?.installedForKernels ?? []), ...kernels])];
        const enabled = [...new Set([...(existing?.enabledForKernels ?? []), ...kernels])];
        const skill = await canonicalService.importLocalSkill(record, {
          sourceKind: 'marketplace',
          installedForKernels: installed,
          enabledForKernels: enabled,
        });
        if (!installed.includes('openclaw')) await clawHubService.uninstall({ slug });
        return { success: true, mutation: await reconcileMutation(skill, 'install', target) };
      } catch (error) {
        return { success: false, error: errorMessage(error) };
      }
    },
    clawhubUninstall: async (payload) => {
      try {
        const body = (isRecord(payload) ? payload : {}) as ClawHubUninstallParams;
        const target = payloadTarget(payload);
        if (!canonicalService || !projectionReconciler) {
          await clawHubService.uninstall(body);
          return { success: true };
        }
        const skill = await canonicalService.findBySlug(body.slug);
        if (!skill) {
          await clawHubService.uninstall(body);
          return { success: true };
        }
        const kernels = targetKernels(skill, target, 'uninstall', projectionReconciler);
        const next = await canonicalService.mutateDesired(skill.id, 'uninstall', kernels);
        const mutation = projectionResultsToMutation(
          next.id,
          await projectionReconciler.reconcileSkill(next.id, kernels),
        );
        if (kernels.includes('openclaw')) await clawHubService.uninstall(body);
        return { success: true, mutation };
      } catch (error) {
        return { success: false, error: errorMessage(error) };
      }
    },
    clawhubOpenSkillReadme: async (payload) => {
      try {
        const body = isRecord(payload) ? payload as SkillOpenPayload : {};
        const skillKey = typeof body.skillKey === 'string' ? body.skillKey : '';
        const slug = typeof body.slug === 'string' ? body.slug : undefined;
        const baseDir = typeof body.baseDir === 'string' ? body.baseDir : undefined;
        await clawHubService.openSkillReadme(skillKey || slug || '', slug, baseDir);
        return { success: true };
      } catch (error) {
        return { success: false, error: errorMessage(error) };
      }
    },
    clawhubOpenSkillPath: async (payload) => {
      try {
        const body = isRecord(payload) ? payload as SkillOpenPayload : {};
        const skillKey = typeof body.skillKey === 'string' ? body.skillKey : '';
        const slug = typeof body.slug === 'string' ? body.slug : undefined;
        const baseDir = typeof body.baseDir === 'string' ? body.baseDir : undefined;
        await clawHubService.openSkillPath(skillKey || slug || '', slug, baseDir);
        return { success: true };
      } catch (error) {
        return { success: false, error: errorMessage(error) };
      }
    },
  };
}
