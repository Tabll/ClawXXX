import type { KernelCapabilities, KernelId, KernelLifecycleState, KernelProcessOwnership } from '../kernels/contracts';
import type { KernelArtifactDescriptorV1 } from '../kernels/catalog';
import type { KernelPackageLifecycleState } from '../kernels/package-manager';

export type KernelArtifactDiagnostics = {
  installationState: KernelPackageLifecycleState | 'unknown';
  activeVersion?: string;
  desiredVersion?: string;
  lastKnownGoodVersion?: string;
  artifactVersion?: string;
  upstreamVersion?: string;
  upstreamCommit?: string;
  patchRevision?: number;
  platform?: string;
  arch?: string;
  archiveSha256?: string;
  fileManifestSha256?: string;
  patchSeriesSha256?: string;
  licenseReportSha256?: string;
  platformSecurityReportSha256?: string;
};

export type KernelProtocolDiagnostics = {
  kernelContract: 'clawx.kernel/v1';
  runtimeTransport?: 'in-process-driver' | 'stdio-jsonl';
  chat?: KernelArtifactDescriptorV1['protocols']['chat'];
  control?: KernelArtifactDescriptorV1['protocols']['control'];
  conversationStore?: KernelArtifactDescriptorV1['protocols']['conversationStore'];
};

export type KernelProcessDiagnostics = {
  state: KernelLifecycleState;
  generation: number;
  pid?: number;
  ownership?: KernelProcessOwnership;
  runtimeVersion?: string;
  artifactVersion?: string;
  startedAt?: string;
  startupDurationMs?: number;
  rssBytes?: number;
};

export type KernelHealthDiagnostics = {
  state: KernelLifecycleState;
  lastHealthAt?: string;
  lastError?: string;
  crashCount: number;
  restartCount: number;
  restartBudget?: number;
  rollbackSuggested: boolean;
};

export type KernelDiagnosticsSnapshot = {
  capturedAt: string;
  kernelId: KernelId;
  artifact: KernelArtifactDiagnostics;
  protocol: KernelProtocolDiagnostics;
  process: KernelProcessDiagnostics;
  health: KernelHealthDiagnostics;
  capabilities?: KernelCapabilities;
  logs: {
    directory?: string;
    entryCount: number;
    lastSequence?: number;
  };
};

export type DiagnosticsSnapshotResult = {
  capturedAt: string;
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  kernels: KernelDiagnosticsSnapshot[];
};
