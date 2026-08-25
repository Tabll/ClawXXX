import { createHash, createPublicKey, verify } from 'node:crypto';
import { z } from 'zod';
import type {
  CatalogVerificationStateV1,
  EmergencyRollbackAuthorizationV1,
  KernelArtifactDescriptorV1,
  KernelCatalogEnvelopeV1,
  KernelSigningPurpose,
  KernelTrustKeyV1,
  KernelTrustStoreV1,
  SignedDescriptor,
} from '@shared/kernels/catalog';
import { kernelArtifactIdentity } from '@shared/kernels/catalog';

const SHA256 = /^[a-f0-9]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;
const KERNEL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ARTIFACT_VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,126}\+clawx\.[1-9][0-9]*$/;
const SEMVER_RANGE = /^[0-9]+\.[0-9]+(?:\.[0-9]+|\.x)(?:-[0-9A-Za-z.-]+)?$/;

const isoDate = z.string().datetime({ offset: true });
const sha256 = z.string().regex(SHA256);
const positiveInt = z.number().int().positive();

const signedDescriptorSchema = z.strictObject({
  algorithm: z.literal('Ed25519'),
  keyId: z.string().min(1).max(128),
  signature: z.string().min(32).max(256).regex(BASE64URL),
});

const protocolRangeSchema = z.strictObject({
  name: z.string().min(1).max(128),
  min: positiveInt,
  max: positiveInt,
});

const artifactSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kernelId: z.string().regex(KERNEL_ID),
  displayName: z.string().min(1).max(128),
  upstreamVersion: z.string().min(1).max(128),
  upstreamCommit: z.string().regex(/^[a-f0-9]{40}$/),
  patchRevision: positiveInt,
  artifactVersion: z.string().regex(ARTIFACT_VERSION),
  platform: z.enum(['darwin', 'linux', 'win32']),
  arch: z.enum(['arm64', 'x64']),
  minHostVersion: z.string().regex(SEMVER_RANGE),
  maxHostVersion: z.string().regex(SEMVER_RANGE),
  capabilityContractVersion: z.literal(1),
  protocols: z.strictObject({
    chat: protocolRangeSchema,
    control: protocolRangeSchema.extend({ name: z.literal('clawx-kernel') }),
    conversationStore: protocolRangeSchema.extend({ name: z.literal('clawx-conversation-store') }),
  }),
  checkpointCodecs: z.array(z.strictObject({
    id: z.string().min(1).max(128),
    schemaVersion: positiveInt,
    portable: z.literal(false),
  })).max(32),
  storage: z.strictObject({
    authority: z.literal('clawx-data-service'),
    nativeDurableHistory: z.literal(false),
    regressionReportSha256: sha256,
  }),
  node: z.strictObject({
    version: z.string().regex(/^24\.[0-9]+\.[0-9]+$/),
    moduleAbi: positiveInt,
    distributionSha256: sha256,
  }),
  archive: z.strictObject({
    format: z.literal('tar.zst'),
    url: z.string().url().refine((value) => value.startsWith('https://'), 'archive URL must use HTTPS'),
    sha256,
    compressedSize: positiveInt,
    unpackedSize: positiveInt,
    fileCount: positiveInt,
  }),
  entrypoints: z.record(z.string().min(1), z.string().min(1)).refine(
    (entrypoints) => Object.values(entrypoints).every(isSafeRelativePath),
    'entrypoints must be normalized relative paths',
  ),
  supplyChain: z.strictObject({
    sourceSha256: sha256,
    lockfileSha256: sha256,
    patchSeriesSha256: sha256,
    fileManifestSha256: sha256,
    sbomSha256: sha256,
    noticesSha256: sha256,
    provenanceSha256: sha256,
    testReportSha256: sha256,
    licenseReportSha256: sha256.optional(),
    platformSecurityReportSha256: sha256.optional(),
  }),
  budgets: z.strictObject({
    coldReadyMs: positiveInt,
    idleRssBytes: positiveInt,
  }),
  publishedAt: isoDate,
  expiresAt: isoDate,
  descriptorSignature: signedDescriptorSchema,
});

const rollbackSchema = z.strictObject({
  schemaVersion: z.literal(1),
  authorizationId: z.string().min(1).max(128),
  fromSequence: positiveInt,
  toSequence: positiveInt,
  catalogSha256: sha256,
  reason: z.string().min(16).max(2_048),
  issuedAt: isoDate,
  expiresAt: isoDate,
  signing: signedDescriptorSchema,
});

const catalogSchema = z.strictObject({
  schemaVersion: z.literal(1),
  channel: z.enum(['staging', 'production']),
  sequence: positiveInt,
  issuedAt: isoDate,
  expiresAt: isoDate,
  artifacts: z.array(artifactSchema).max(1_000),
  revokedArtifactIdentities: z.array(z.string().min(1).max(512)).max(10_000),
  emergencyRollback: rollbackSchema.optional(),
  catalogSignature: signedDescriptorSchema,
});

const trustKeySchema = z.strictObject({
  keyId: z.string().min(1).max(128),
  algorithm: z.literal('Ed25519'),
  purposes: z.array(z.enum(['artifact', 'catalog', 'rollback'])).min(1),
  publicKeyPem: z.string().min(80).max(1_024),
  notBefore: isoDate,
  notAfter: isoDate,
  revokedAt: isoDate.optional(),
});

const trustStoreSchema = z.strictObject({
  schemaVersion: z.literal(1),
  keys: z.array(trustKeySchema).min(1).max(64),
});

export class KernelCatalogVerificationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'KernelCatalogVerificationError';
    this.code = code;
  }
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON rejects non-finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record).sort().map((key) => {
      const item = record[key];
      if (item === undefined) throw new TypeError(`Canonical JSON rejects undefined at ${key}`);
      return `${JSON.stringify(key)}:${canonicalJson(item)}`;
    });
    return `{${entries.join(',')}}`;
  }
  throw new TypeError(`Canonical JSON rejects ${typeof value}`);
}

export function parseKernelCatalog(input: unknown): KernelCatalogEnvelopeV1 {
  return catalogSchema.parse(input) as KernelCatalogEnvelopeV1;
}

export function parseKernelArtifactDescriptor(input: unknown): KernelArtifactDescriptorV1 {
  return artifactSchema.parse(input) as KernelArtifactDescriptorV1;
}

export function parseKernelTrustStore(input: unknown): KernelTrustStoreV1 {
  const store = trustStoreSchema.parse(input) as KernelTrustStoreV1;
  const keyIds = new Set<string>();
  for (const key of store.keys) {
    if (keyIds.has(key.keyId)) throw new KernelCatalogVerificationError('duplicate-key', `Duplicate key ID: ${key.keyId}`);
    keyIds.add(key.keyId);
    try {
      createPublicKey(key.publicKeyPem);
    } catch (error) {
      throw new KernelCatalogVerificationError('invalid-key', `Invalid public key ${key.keyId}: ${String(error)}`);
    }
  }
  return store;
}

export function unsignedArtifactDescriptor(
  artifact: KernelArtifactDescriptorV1,
): Omit<KernelArtifactDescriptorV1, 'descriptorSignature'> {
  const { descriptorSignature: _signature, ...unsigned } = artifact;
  return unsigned;
}

export function unsignedCatalogEnvelope(
  catalog: KernelCatalogEnvelopeV1,
): Omit<KernelCatalogEnvelopeV1, 'catalogSignature'> {
  const { catalogSignature: _signature, ...unsigned } = catalog;
  return unsigned;
}

export function unsignedRollbackAuthorization(
  authorization: EmergencyRollbackAuthorizationV1,
): Omit<EmergencyRollbackAuthorizationV1, 'signing'> {
  const { signing: _signature, ...unsigned } = authorization;
  return unsigned;
}

export function catalogContentSha256(catalog: KernelCatalogEnvelopeV1): string {
  return hashCanonical(unsignedCatalogEnvelope(catalog));
}

export function catalogRollbackTargetSha256(catalog: KernelCatalogEnvelopeV1): string {
  const { emergencyRollback: _authorization, ...target } = unsignedCatalogEnvelope(catalog);
  return hashCanonical(target);
}

export function artifactDescriptorSha256(artifact: KernelArtifactDescriptorV1): string {
  return hashCanonical(unsignedArtifactDescriptor(artifact));
}

export function verifyKernelArtifactDescriptor(
  input: unknown,
  trustInput: unknown,
  now = new Date(),
  options: { allowExpired?: boolean } = {},
): KernelArtifactDescriptorV1 {
  const artifact = parseKernelArtifactDescriptor(input);
  const trust = parseKernelTrustStore(trustInput);
  verifyArtifact(artifact, trust, now.getTime(), options.allowExpired ?? false);
  return artifact;
}

export function verifyKernelCatalog(
  input: unknown,
  trustInput: unknown,
  previous: CatalogVerificationStateV1 = { schemaVersion: 1, highestSequence: 0 },
  now = new Date(),
): { catalog: KernelCatalogEnvelopeV1; state: CatalogVerificationStateV1; usedEmergencyRollback: boolean } {
  const catalog = parseKernelCatalog(input);
  const trust = parseKernelTrustStore(trustInput);
  const nowMs = now.getTime();
  assertTimeWindow('catalog', catalog.issuedAt, catalog.expiresAt, nowMs);
  verifySignedPayload(unsignedCatalogEnvelope(catalog), catalog.catalogSignature, trust, 'catalog', nowMs);

  const identities = new Set<string>();
  for (const artifact of catalog.artifacts) {
    verifyArtifact(artifact, trust, nowMs, false);
    const identity = kernelArtifactIdentity(artifact);
    if (identities.has(identity)) throw new KernelCatalogVerificationError('duplicate-artifact', `Duplicate artifact: ${identity}`);
    identities.add(identity);
    if (catalog.revokedArtifactIdentities.includes(identity)) {
      throw new KernelCatalogVerificationError('revoked-artifact', `Catalog contains revoked artifact: ${identity}`);
    }
  }

  const digest = catalogContentSha256(catalog);
  let usedEmergencyRollback = false;
  if (catalog.sequence < previous.highestSequence) {
    const authorization = catalog.emergencyRollback;
    if (!authorization) throw new KernelCatalogVerificationError('catalog-rollback', 'Catalog sequence rollback rejected');
    assertTimeWindow('rollback authorization', authorization.issuedAt, authorization.expiresAt, nowMs);
    verifySignedPayload(unsignedRollbackAuthorization(authorization), authorization.signing, trust, 'rollback', nowMs);
    if (authorization.fromSequence !== previous.highestSequence
      || authorization.toSequence !== catalog.sequence
      || authorization.catalogSha256 !== catalogRollbackTargetSha256(catalog)) {
      throw new KernelCatalogVerificationError('rollback-scope', 'Emergency rollback authorization does not match this catalog');
    }
    usedEmergencyRollback = true;
  } else if (catalog.sequence === previous.highestSequence
    && previous.highestCatalogSha256
    && previous.highestCatalogSha256 !== digest) {
    throw new KernelCatalogVerificationError('sequence-equivocation', 'Catalog sequence was reused for different content');
  }

  return {
    catalog,
    usedEmergencyRollback,
    state: {
      schemaVersion: 1,
      highestSequence: Math.max(previous.highestSequence, catalog.sequence),
      highestCatalogSha256: catalog.sequence >= previous.highestSequence
        ? digest
        : previous.highestCatalogSha256,
    },
  };
}

function verifyArtifact(
  artifact: KernelArtifactDescriptorV1,
  trust: KernelTrustStoreV1,
  nowMs: number,
  allowExpired: boolean,
): void {
  const identity = kernelArtifactIdentity(artifact);
  if (allowExpired) {
    const publishedAtMs = Date.parse(artifact.publishedAt);
    const expiresAtMs = Date.parse(artifact.expiresAt);
    if (publishedAtMs > nowMs + 5 * 60_000 || expiresAtMs <= publishedAtMs) {
      throw new KernelCatalogVerificationError('artifact-time-window', `${identity} has an invalid time window`);
    }
    verifySignedPayload(
      unsignedArtifactDescriptor(artifact),
      artifact.descriptorSignature,
      trust,
      'artifact',
      publishedAtMs + 1,
    );
    const key = trust.keys.find(candidate => candidate.keyId === artifact.descriptorSignature.keyId);
    if (key?.revokedAt && Date.parse(key.revokedAt) <= nowMs) {
      throw new KernelCatalogVerificationError('revoked-key', `Key ${key.keyId} is revoked`);
    }
  } else {
    assertTimeWindow(identity, artifact.publishedAt, artifact.expiresAt, nowMs);
    verifySignedPayload(unsignedArtifactDescriptor(artifact), artifact.descriptorSignature, trust, 'artifact', nowMs);
  }
  if (artifact.protocols.chat.min > artifact.protocols.chat.max
    || artifact.protocols.control.min > artifact.protocols.control.max
    || artifact.protocols.conversationStore.min > artifact.protocols.conversationStore.max) {
    throw new KernelCatalogVerificationError('invalid-protocol-range', `Invalid protocol range for ${identity}`);
  }
}

function hashCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function verifySignedPayload(
  payload: unknown,
  signed: SignedDescriptor,
  trust: KernelTrustStoreV1,
  purpose: KernelSigningPurpose,
  nowMs: number,
): void {
  const key = trust.keys.find((candidate) => candidate.keyId === signed.keyId);
  if (!key) throw new KernelCatalogVerificationError('unknown-key', `Unknown signing key: ${signed.keyId}`);
  assertTrustedKey(key, purpose, nowMs);
  const valid = verify(null, Buffer.from(canonicalJson(payload)), createPublicKey(key.publicKeyPem), Buffer.from(signed.signature, 'base64url'));
  if (!valid) throw new KernelCatalogVerificationError('bad-signature', `Invalid ${purpose} signature from ${signed.keyId}`);
}

function assertTrustedKey(key: KernelTrustKeyV1, purpose: KernelSigningPurpose, nowMs: number): void {
  if (!key.purposes.includes(purpose)) {
    throw new KernelCatalogVerificationError('wrong-key-purpose', `Key ${key.keyId} cannot sign ${purpose} metadata`);
  }
  if (Date.parse(key.notBefore) > nowMs || Date.parse(key.notAfter) <= nowMs) {
    throw new KernelCatalogVerificationError('key-time-window', `Key ${key.keyId} is outside its trust window`);
  }
  if (key.revokedAt && Date.parse(key.revokedAt) <= nowMs) {
    throw new KernelCatalogVerificationError('revoked-key', `Key ${key.keyId} is revoked`);
  }
}

function assertTimeWindow(label: string, issuedAt: string, expiresAt: string, nowMs: number): void {
  const issuedAtMs = Date.parse(issuedAt);
  const expiresAtMs = Date.parse(expiresAt);
  if (issuedAtMs > nowMs + 5 * 60_000) {
    throw new KernelCatalogVerificationError('issued-in-future', `${label} was issued too far in the future`);
  }
  if (expiresAtMs <= issuedAtMs || expiresAtMs <= nowMs) {
    throw new KernelCatalogVerificationError('expired', `${label} metadata is expired or has an invalid time window`);
  }
}

function isSafeRelativePath(value: string): boolean {
  if (value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:/.test(value) || value.includes('\\')) return false;
  const segments = value.split('/');
  return segments.length > 0 && segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}
