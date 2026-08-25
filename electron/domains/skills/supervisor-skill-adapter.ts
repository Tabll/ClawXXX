import type { KernelId } from '@shared/kernels/contracts';
import type { KernelSupervisorRegistry } from '../../kernels/supervisor-registry';
import type { SkillKernelProjectionAdapter } from './skill-projection-reconciler';

export function createSupervisorSkillProjectionAdapter(
  supervisors: KernelSupervisorRegistry,
  kernelId: KernelId,
): SkillKernelProjectionAdapter {
  return {
    kernelId,
    available: () => supervisors.status(kernelId).state === 'ready',
    async upsert(skill, operationId) {
      const result = await supervisors.request<{ id?: string }>(
        kernelId,
        'control.skills.upsert',
        { entity: skill, operationId },
      );
      return { nativeId: result?.id ?? skill.slug };
    },
    remove: (nativeId, operationId) => supervisors.request(
      kernelId,
      'control.skills.remove',
      { id: nativeId, operationId },
    ),
  };
}
