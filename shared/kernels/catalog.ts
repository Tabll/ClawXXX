import type { KernelId } from './contracts';

export type KernelPlatform = 'darwin' | 'linux' | 'win32';
export type KernelArchitecture = 'arm64' | 'x64';

export type SignedDescriptor = {
  algorithm: 'Ed25519';
  keyId: string;
  signature: string;
};

export type KernelArtifactDescriptorV1 = {
  schemaVersion: 1;
  kernelId: KernelId;
  displayName: string;
  upstreamVersion: string;
  upstreamCommit: string;
  patchRevision: number;
  artifactVersion: string;
  platform: KernelPlatform;
  arch: KernelArchitecture;
  minHostVersion: string;
  maxHostVersion: string;
  capabilityContractVersion: 1;
  protocols: {
    chat: { name: string; min: number; max: number };
    control: { name: 'clawx-kernel'; min: number; max: number };
    conversationStore: { name: 'clawx-conversation-store'; min: number; max: number };
  };
  checkpointCodecs: Array<{ id: string; schemaVersion: number; portable: false }>;
  storage: {
    authority: 'clawx-data-service';
    nativeDurableHistory: false;
    regressionReportSha256: string;
  };
  node: {
    version: string;
    moduleAbi: number;
    distributionSha256: string;
  };
  archive: {
    format: 'tar.zst';
    url: string;
    sha256: string;
    compressedSize: number;
    unpackedSize: number;
    fileCount: number;
  };
  entrypoints: Record<string, string>;
  supplyChain: {
    sourceSha256: string;
    lockfileSha256: string;
    patchSeriesSha256: string;
    fileManifestSha256: string;
    sbomSha256: string;
    noticesSha256: string;
    provenanceSha256: string;
    testReportSha256: string;
    licenseReportSha256?: string;
    platformSecurityReportSha256?: string;
  };
  budgets: {
    coldReadyMs: number;
    idleRssBytes: number;
  };
  publishedAt: string;
  expiresAt: string;
  descriptorSignature: SignedDescriptor;
};

export type EmergencyRollbackAuthorizationV1 = {
  schemaVersion: 1;
  authorizationId: string;
  fromSequence: number;
  toSequence: number;
  catalogSha256: string;
  reason: string;
  issuedAt: string;
  expiresAt: string;
  signing: SignedDescriptor;
};

export type KernelCatalogEnvelopeV1 = {
  schemaVersion: 1;
  channel: 'staging' | 'production';
  sequence: number;
  issuedAt: string;
  expiresAt: string;
  artifacts: KernelArtifactDescriptorV1[];
  revokedArtifactIdentities: string[];
  emergencyRollback?: EmergencyRollbackAuthorizationV1;
  catalogSignature: SignedDescriptor;
};

export type KernelSigningPurpose = 'artifact' | 'catalog' | 'rollback';

export type KernelTrustKeyV1 = {
  keyId: string;
  algorithm: 'Ed25519';
  purposes: KernelSigningPurpose[];
  publicKeyPem: string;
  notBefore: string;
  notAfter: string;
  revokedAt?: string;
};

export type KernelTrustStoreV1 = {
  schemaVersion: 1;
  keys: KernelTrustKeyV1[];
};

export type CatalogVerificationStateV1 = {
  schemaVersion: 1;
  highestSequence: number;
  highestCatalogSha256?: string;
};

export function kernelArtifactIdentity(
  artifact: Pick<KernelArtifactDescriptorV1, 'kernelId' | 'artifactVersion' | 'platform' | 'arch'>,
): string {
  return `${artifact.kernelId}/${artifact.artifactVersion}/${artifact.platform}-${artifact.arch}`;
}
