import type { KernelArtifactDescriptorV1, KernelCatalogEnvelopeV1 } from './catalog';
import type { KernelId } from './contracts';

export type KernelPackageLifecycleState =
  | 'not-installed'
  | 'resolving'
  | 'downloading'
  | 'verifying'
  | 'staging'
  | 'smoke-testing'
  | 'installed'
  | 'error';

export type KernelRuntimeVersionState = 'verified' | 'quarantined' | 'trash';

export type KernelCatalogStateRecord = {
  channel: 'staging' | 'production';
  highestSequence: number;
  highestCatalogSha256?: string;
  cachedCatalog?: KernelCatalogEnvelopeV1;
  cachedCatalogSha256?: string;
  etag?: string;
  sourceUrl?: string;
  fetchedAt?: string;
  updatedAt: string;
};

export type KernelInstallationRecord = {
  kernelId: KernelId;
  desiredVersion?: string;
  activeVersion?: string;
  lastKnownGoodVersion?: string;
  state: KernelPackageLifecycleState;
  manifest?: KernelArtifactDescriptorV1;
  lastError?: string;
  updatedAt: string;
};

export type KernelRuntimeVersionRecord = {
  kernelId: KernelId;
  artifactVersion: string;
  platform: string;
  arch: string;
  archiveSha256: string;
  state: KernelRuntimeVersionState;
  manifest: KernelArtifactDescriptorV1;
  installedAt: string;
  verifiedAt: string;
  lastScanAt?: string;
  quarantineReason?: string;
};

export type KernelActivationHistoryRecord = {
  id: number;
  kernelId: KernelId;
  fromVersion?: string;
  toVersion: string;
  reason: 'install' | 'update' | 'rollback' | 'repair' | 'recovery';
  createdAt: string;
};

export type KernelHostCompatibility = {
  hostVersion: string;
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  capabilityContractVersion: 1;
  chatProtocol: { name: string; version: number };
  controlProtocol: { name: 'clawx-kernel'; version: number };
  conversationStoreProtocol: { name: 'clawx-conversation-store'; version: number };
  supportedNodeModuleAbis: number[];
};

export type KernelCompatibilityFailure =
  | 'kernel-not-found'
  | 'platform'
  | 'architecture'
  | 'host-version'
  | 'capability-contract'
  | 'chat-protocol'
  | 'control-protocol'
  | 'conversation-store-protocol'
  | 'node-module-abi'
  | 'expired';

export type KernelCatalogLoadResult = {
  catalog: KernelCatalogEnvelopeV1;
  source: 'network' | 'cache';
  stale: boolean;
  installAllowed: boolean;
  emergencyRollbackAuthorized: boolean;
  sourceUrl?: string;
  warning?: string;
};

export type KernelDownloadProgress = {
  kernelId: KernelId;
  artifactVersion: string;
  phase: 'resolving' | 'downloading' | 'verifying' | 'staging' | 'smoke-testing' | 'activating';
  receivedBytes: number;
  totalBytes: number;
  resumed: boolean;
  sourceUrl?: string;
};

export type KernelInstallResult = {
  installation: KernelInstallationRecord;
  version: KernelRuntimeVersionRecord;
  activated: boolean;
};

export type KernelUninstallResult = {
  kernelId: KernelId;
  removedVersions: string[];
  deferredToTrash: string[];
  canonicalDataPreserved: true;
};
