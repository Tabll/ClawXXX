import type { KernelId } from '@shared/kernels/contracts';
import { getAllSettings, setSetting } from '../utils/store';
import type { KernelAutoStartPolicies } from './runtime-lifecycle-coordinator';

function validPolicies(value: unknown): KernelAutoStartPolicies {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([kernelId, enabled]) => kernelId.length > 0 && typeof enabled === 'boolean'),
  ) as KernelAutoStartPolicies;
}

/** Read-through migration keeps existing gatewayAutoStart behavior intact. */
export async function getKernelAutoStartPolicies(): Promise<KernelAutoStartPolicies> {
  const settings = await getAllSettings();
  const stored = validPolicies(settings.kernelAutoStartPolicies);
  return {
    openclaw: stored.openclaw ?? settings.gatewayAutoStart,
    'deepseek-harness': stored['deepseek-harness'] ?? false,
    ...stored,
  };
}

export async function setKernelAutoStartPolicy(kernelId: KernelId, enabled: boolean): Promise<void> {
  const current = await getKernelAutoStartPolicies();
  await setSetting('kernelAutoStartPolicies', { ...current, [kernelId]: enabled });
  // Maintain the old key until M15 removes the legacy Settings toggle.
  if (kernelId === 'openclaw') await setSetting('gatewayAutoStart', enabled);
}

export async function synchronizeLegacyGatewayAutoStart(enabled: boolean): Promise<void> {
  const current = await getKernelAutoStartPolicies();
  await setSetting('kernelAutoStartPolicies', { ...current, openclaw: enabled });
}
