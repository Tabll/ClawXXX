import type { GatewayManager } from '../gateway/manager';
import type {
  ExtensionHostKernelApi,
  KernelCapabilityContribution,
  LegacyOpenClawExtensionBoundary,
} from '@shared/extensions/kernel-api';
import type { KernelDriver, KernelId, KernelRuntimeSnapshot } from '@shared/kernels/contracts';
import type { KernelRuntimeDiagnostics } from '@shared/host-api/kernels';
import type { KernelInstallationRecord, KernelRuntimeVersionRecord } from '@shared/kernels/package-manager';

export class OpenClawLegacyExtensionAdapter {
  private readonly contributions = new Map<string, KernelCapabilityContribution>();

  constructor(private readonly options: {
    gateway: GatewayManager;
    list: () => Promise<KernelRuntimeSnapshot[]>;
    getDriver: (kernelId: KernelId) => KernelDriver | undefined;
    diagnostics: (kernelId: KernelId) => KernelRuntimeDiagnostics;
    getInstallation: (kernelId: KernelId) => Promise<KernelInstallationRecord | undefined>;
    getRuntimeVersion: (kernelId: KernelId, artifactVersion: string) => Promise<KernelRuntimeVersionRecord | undefined>;
  }) {}

  createKernelApi(): ExtensionHostKernelApi & {
    legacyOpenClaw: LegacyOpenClawExtensionBoundary<GatewayManager>;
  } {
    const legacyOpenClaw = Object.freeze({
      kernelId: 'openclaw' as const,
      gateway: this.options.gateway,
    });
    return Object.freeze({
      list: this.options.list,
      getDriver: this.options.getDriver,
      diagnostics: this.options.diagnostics,
      getInstallation: this.options.getInstallation,
      getRuntimeVersion: this.options.getRuntimeVersion,
      registerContribution: (contribution: KernelCapabilityContribution) => {
        if (!contribution.id.trim()) throw new Error('Kernel extension contribution ID is required');
        if (this.contributions.has(contribution.id)) {
          throw new Error(`Kernel extension contribution already exists: ${contribution.id}`);
        }
        this.contributions.set(contribution.id, structuredClone(contribution));
        return () => this.contributions.delete(contribution.id);
      },
      legacyOpenClaw,
    });
  }
}
