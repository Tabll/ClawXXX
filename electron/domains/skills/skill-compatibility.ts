import type { SkillCompatibility } from '@shared/domains/skills';
import type { KernelId } from '@shared/kernels/contracts';
import type { CanonicalSkillPackageStore } from './skill-package-store';

export type BundledSkillCompatibilityEntry = {
  slug: string;
  openclaw: 'native';
  deepSeekHarness: 'converted' | 'unsupported';
  reason?: string;
};

const DOCUMENT_RUNTIME_REASON = 'Requires auxiliary document runtime files that are not yet packaged for DeepSeek Harness.';

/** Checked-in policy for ClawX-owned Skills; unknown Skills are inspected. */
export const BUNDLED_SKILL_COMPATIBILITY_MATRIX: readonly BundledSkillCompatibilityEntry[] = Object.freeze([
  { slug: 'skill-creator', openclaw: 'native', deepSeekHarness: 'converted' },
  { slug: 'pdf', openclaw: 'native', deepSeekHarness: 'unsupported', reason: DOCUMENT_RUNTIME_REASON },
  { slug: 'xlsx', openclaw: 'native', deepSeekHarness: 'unsupported', reason: DOCUMENT_RUNTIME_REASON },
  { slug: 'docx', openclaw: 'native', deepSeekHarness: 'unsupported', reason: DOCUMENT_RUNTIME_REASON },
  { slug: 'pptx', openclaw: 'native', deepSeekHarness: 'unsupported', reason: DOCUMENT_RUNTIME_REASON },
]);

const METADATA_FILES = new Set([
  'SKILL.md',
  'manifest.json',
  '.clawx-preinstalled.json',
  '.clawhub/origin.json',
]);

export function stripSkillFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
}

export async function evaluateSkillCompatibility(input: {
  slug: string;
  sourceKind: 'bundled' | 'marketplace' | 'local';
  packageRoot: string;
  packages: CanonicalSkillPackageStore;
}): Promise<SkillCompatibility[]> {
  const openclaw: SkillCompatibility = {
    kernelId: 'openclaw',
    compatible: true,
    mode: 'native',
  };
  const fixed = input.sourceKind === 'bundled'
    ? BUNDLED_SKILL_COMPATIBILITY_MATRIX.find(entry => entry.slug === input.slug)
    : undefined;
  if (fixed?.deepSeekHarness === 'unsupported') {
    return [openclaw, {
      kernelId: 'deepseek-harness',
      compatible: false,
      mode: 'unsupported',
      reason: fixed.reason ?? 'This bundled Skill is not available in DeepSeek Harness.',
    }];
  }

  const files = await input.packages.listPackageFiles(input.packageRoot);
  const auxiliary = files.filter(file => !METADATA_FILES.has(file));
  if (auxiliary.length > 0) {
    const sample = auxiliary.slice(0, 3).join(', ');
    return [openclaw, {
      kernelId: 'deepseek-harness',
      compatible: false,
      mode: 'unsupported',
      reason: `DeepSeek Harness instruction conversion cannot preserve auxiliary files (${sample}${auxiliary.length > 3 ? ', …' : ''}).`,
    }];
  }

  const instructions = stripSkillFrontmatter(await input.packages.readInstructions(input.packageRoot));
  if (!instructions) {
    return [openclaw, {
      kernelId: 'deepseek-harness',
      compatible: false,
      mode: 'unsupported',
      reason: 'SKILL.md has no instruction body after metadata conversion.',
    }];
  }
  return [openclaw, {
    kernelId: 'deepseek-harness',
    compatible: true,
    mode: 'converted',
    reason: 'SKILL.md frontmatter is removed and its instruction body is registered through ctx.skills.',
  }];
}

export function compatibilityForKernel(
  compatibility: SkillCompatibility[],
  kernelId: KernelId,
): SkillCompatibility | undefined {
  return compatibility.find(entry => entry.kernelId === kernelId);
}
