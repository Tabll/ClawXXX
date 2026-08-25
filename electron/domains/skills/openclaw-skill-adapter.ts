import type { KernelSupervisorRegistry } from '../../kernels/supervisor-registry';
import { getOpenClawSkillsDir } from '../../utils/paths';
import { updateSkillConfig } from '../../utils/skill-config';
import type { CanonicalSkillPackageStore } from './skill-package-store';
import type { SkillKernelProjectionAdapter } from './skill-projection-reconciler';

export function createOpenClawSkillProjectionAdapter(
  supervisors: KernelSupervisorRegistry,
  packages: CanonicalSkillPackageStore,
): SkillKernelProjectionAdapter {
  const root = getOpenClawSkillsDir();
  return {
    kernelId: 'openclaw',
    available: () => supervisors.isLaunchAvailable('openclaw'),
    async upsert(skill) {
      await packages.projectPackage({
        canonicalSkillId: skill.id,
        slug: skill.slug,
        packageRoot: skill.source.locator,
        kernelRoot: root,
      });
      await updateSkillConfig(skill.id, { enabled: skill.enabled });
      if (skill.slug !== skill.id) await updateSkillConfig(skill.slug, { enabled: skill.enabled });
      return { nativeId: skill.slug };
    },
    async remove(nativeId) {
      await packages.removeProjection(root, nativeId);
      await updateSkillConfig(nativeId, { enabled: false });
    },
  };
}
