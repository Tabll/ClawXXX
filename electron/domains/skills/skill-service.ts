import type { CanonicalSkill } from '@shared/domains/skills';
import { asSkillId } from '@shared/domains/identity';
import type { KernelId } from '@shared/kernels/contracts';
import type { LocalSkillRecord } from '../../services/skills/local-skill-service';
import { evaluateSkillCompatibility } from './skill-compatibility';
import type { CanonicalSkillPackageStore } from './skill-package-store';

export type SkillDataClient = {
  call<T = unknown>(method: string, ...args: unknown[]): Promise<T>;
};

export type CanonicalSkillSourceKind = CanonicalSkill['source']['kind'];
export type SkillDesiredMutation = 'install' | 'uninstall' | 'enable' | 'disable';

const KERNEL_ORDER: KernelId[] = ['openclaw', 'deepseek-harness'];

function orderedKernelIds(values: Iterable<KernelId>): KernelId[] {
  const unique = new Set(values);
  return [
    ...KERNEL_ORDER.filter(kernelId => unique.delete(kernelId)),
    ...[...unique].sort(),
  ];
}

function canonicalSegment(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 128);
  return normalized && /^[a-z0-9]/.test(normalized) ? normalized : 'skill';
}

function normalizedText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

export function inferCanonicalSkillSourceKind(record: LocalSkillRecord): CanonicalSkillSourceKind {
  if (record.isBundled) return 'bundled';
  if (record.marketplace || record.source === 'openclaw-managed') return 'marketplace';
  return 'local';
}

export class CanonicalSkillService {
  constructor(
    private readonly data: SkillDataClient,
    private readonly packages: CanonicalSkillPackageStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  list(includeDeleted = false): Promise<CanonicalSkill[]> {
    return this.data.call('listSkills', includeDeleted);
  }

  get(id: string, includeDeleted = false): Promise<CanonicalSkill | undefined> {
    return this.data.call('getSkill', id, includeDeleted);
  }

  async findBySlug(slug: string, includeDeleted = false): Promise<CanonicalSkill | undefined> {
    const normalized = canonicalSegment(slug);
    return (await this.list(includeDeleted)).find(skill => skill.slug === normalized || skill.id === normalized);
  }

  /** Imports/adopts a native Skill into the kernel-neutral immutable package store. */
  async importLocalSkill(
    record: LocalSkillRecord,
    input: {
      sourceKind?: CanonicalSkillSourceKind;
      installedForKernels?: KernelId[];
      enabledForKernels?: KernelId[];
    } = {},
  ): Promise<CanonicalSkill> {
    if (!record.baseDir) throw new Error(`Skill ${record.id || record.name} has no package directory`);
    const slug = canonicalSegment(record.slug || record.id || record.name);
    const existing = await this.findBySlug(slug, true);
    const id = existing?.id ?? asSkillId(slug);
    const imported = await this.packages.importPackage(id, record.baseDir);
    const sourceKind = input.sourceKind ?? inferCanonicalSkillSourceKind(record);
    const compatibility = await evaluateSkillCompatibility({
      slug,
      sourceKind,
      packageRoot: imported.locator,
      packages: this.packages,
    });
    const contentChanged = existing?.source.digestSha256 !== imported.digestSha256;
    const timestamp = this.now().toISOString();
    const installedForKernels = orderedKernelIds(
      input.installedForKernels ?? existing?.installedForKernels ?? ['openclaw'],
    );
    const enabledForKernels = orderedKernelIds(
      (input.enabledForKernels ?? existing?.enabledForKernels ?? (record.enabled ? installedForKernels : []))
        .filter(kernelId => installedForKernels.includes(kernelId)),
    );
    const skill: CanonicalSkill = {
      id,
      slug,
      displayName: normalizedText(record.name) ?? slug,
      description: normalizedText(record.description) ?? 'No description available.',
      ...(normalizedText(record.icon) ? { icon: normalizedText(record.icon) } : {}),
      ...(normalizedText(record.author) ? { author: normalizedText(record.author) } : {}),
      ...(record.isCore === undefined ? {} : { isCore: record.isCore }),
      version: normalizedText(record.version) ?? existing?.version ?? 'unknown',
      revision: existing ? existing.revision + (contentChanged ? 1 : 0) : 1,
      source: {
        kind: sourceKind,
        locator: imported.locator,
        digestSha256: imported.digestSha256,
      },
      installedForKernels,
      enabledForKernels,
      compatibility,
      projections: existing?.projections ?? [],
      ...(record.config ? { config: structuredClone(record.config) } : existing?.config ? { config: existing.config } : {}),
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: existing && !contentChanged
        && existing.displayName === (normalizedText(record.name) ?? slug)
        && existing.description === (normalizedText(record.description) ?? 'No description available.')
        ? existing.updatedAt
        : timestamp,
    };
    await this.data.call('putSkill', skill);
    return skill;
  }

  async mutateDesired(id: string, mutation: SkillDesiredMutation, kernelIds: KernelId[]): Promise<CanonicalSkill> {
    const existing = await this.get(id);
    if (!existing) throw new Error(`Skill not found: ${id}`);
    const targets = orderedKernelIds(kernelIds);
    if (targets.length === 0) throw new Error('At least one Skill target kernel is required');
    const installed = new Set(existing.installedForKernels);
    const enabled = new Set(existing.enabledForKernels);
    for (const kernelId of targets) {
      if (mutation === 'install') {
        installed.add(kernelId);
        enabled.add(kernelId);
      } else if (mutation === 'uninstall') {
        installed.delete(kernelId);
        enabled.delete(kernelId);
      } else if (mutation === 'enable') {
        if (!installed.has(kernelId)) throw new Error(`Skill is not installed for kernel ${kernelId}`);
        enabled.add(kernelId);
      } else {
        enabled.delete(kernelId);
      }
    }
    if (existing.isCore && mutation === 'disable') throw new Error('Cannot disable a core Skill');
    const next: CanonicalSkill = {
      ...existing,
      installedForKernels: orderedKernelIds(installed),
      enabledForKernels: orderedKernelIds(enabled),
      revision: existing.revision + 1,
      updatedAt: this.now().toISOString(),
    };
    await this.data.call('putSkill', next);
    return next;
  }

  async softDelete(id: string): Promise<CanonicalSkill> {
    const existing = await this.get(id);
    if (!existing) throw new Error(`Skill not found: ${id}`);
    const deletedAt = this.now().toISOString();
    if (!await this.data.call<boolean>('deleteSkill', id, deletedAt)) throw new Error(`Skill not found: ${id}`);
    return {
      ...existing,
      installedForKernels: [],
      enabledForKernels: [],
      revision: existing.revision + 1,
      updatedAt: deletedAt,
      deletedAt,
    };
  }
}
