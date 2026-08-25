import type { KernelDriver, KernelId, KernelRuntimeSnapshot } from '../kernels/contracts';
import type { KernelRuntimeDiagnostics } from '../host-api/kernels';
import type { KernelInstallationRecord, KernelRuntimeVersionRecord } from '../kernels/package-manager';

export type SupportedKernelsDeclaration = 'all' | readonly KernelId[];

export type KernelCapabilityContribution = {
  id: string;
  supportedKernels: SupportedKernelsDeclaration;
  capability: 'agents' | 'providers' | 'skills' | 'channels' | 'cron' | 'usage' | 'diagnostics';
};

export type ExtensionHostKernelApi = {
  list(): Promise<KernelRuntimeSnapshot[]>;
  getDriver(kernelId: KernelId): KernelDriver | undefined;
  diagnostics(kernelId: KernelId): KernelRuntimeDiagnostics;
  getInstallation(kernelId: KernelId): Promise<KernelInstallationRecord | undefined>;
  getRuntimeVersion(kernelId: KernelId, artifactVersion: string): Promise<KernelRuntimeVersionRecord | undefined>;
  registerContribution(contribution: KernelCapabilityContribution): () => void;
};

export type KernelAwareExtensionDeclaration = {
  supportedKernels: SupportedKernelsDeclaration;
};

/**
 * Temporary boundary for extensions written against the pre-v1 singleton.
 * It is deliberately OpenClaw-only and cannot be used to claim DSH support.
 */
export type LegacyOpenClawExtensionBoundary<TGateway> = {
  readonly kernelId: 'openclaw';
  readonly gateway: TGateway;
};
