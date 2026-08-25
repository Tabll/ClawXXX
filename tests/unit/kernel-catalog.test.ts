import { generateKeyPairSync, sign } from 'node:crypto';
import {
  canonicalJson,
  catalogRollbackTargetSha256,
  unsignedArtifactDescriptor,
  unsignedCatalogEnvelope,
  unsignedRollbackAuthorization,
  verifyKernelCatalog,
} from '@electron/kernels/catalog';
import type {
  EmergencyRollbackAuthorizationV1,
  KernelArtifactDescriptorV1,
  KernelCatalogEnvelopeV1,
  KernelSigningPurpose,
  KernelTrustStoreV1,
} from '@shared/kernels/catalog';
import { describe, expect, it } from 'vitest';

type KeyMaterial = ReturnType<typeof key>;

describe('signed kernel catalog', () => {
  it('strictly verifies catalog and artifact signatures and advances anti-rollback state', () => {
    const keys = createKeys();
    const artifact = signedArtifact(keys.artifact);
    const catalog = signedCatalog({ sequence: 7, artifacts: [artifact] }, keys.catalog);
    const result = verifyKernelCatalog(catalog, trustStore(keys), { schemaVersion: 1, highestSequence: 6 }, now());

    expect(result.usedEmergencyRollback).toBe(false);
    expect(result.state.highestSequence).toBe(7);
    expect(result.catalog.artifacts[0].artifactVersion).toBe('2026.7.1-2+clawx.1');
  });

  it('rejects unknown fields, tampering, key-purpose confusion, expiry, and sequence equivocation', () => {
    const keys = createKeys();
    const artifact = signedArtifact(keys.artifact);
    const catalog = signedCatalog({ sequence: 7, artifacts: [artifact] }, keys.catalog);

    expect(() => verifyKernelCatalog({ ...catalog, surprise: true }, trustStore(keys), undefined, now())).toThrow();

    const tamperedArtifact = { ...artifact, displayName: 'Tampered' };
    const tamperedCatalog = signedCatalog({ sequence: 7, artifacts: [tamperedArtifact] }, keys.catalog);
    expect(() => verifyKernelCatalog(tamperedCatalog, trustStore(keys), undefined, now())).toThrowError(
      expect.objectContaining({ code: 'bad-signature' }),
    );

    const confused = signedCatalog({ sequence: 7, artifacts: [artifact] }, keys.artifact);
    expect(() => verifyKernelCatalog(confused, trustStore(keys), undefined, now())).toThrowError(
      expect.objectContaining({ code: 'wrong-key-purpose' }),
    );

    expect(() => verifyKernelCatalog(catalog, trustStore(keys), undefined, new Date('2027-02-01T00:00:00.000Z'))).toThrowError(
      expect.objectContaining({ code: 'expired' }),
    );

    const accepted = verifyKernelCatalog(catalog, trustStore(keys), undefined, now()).state;
    const replacement = signedCatalog({ sequence: 7, artifacts: [signedArtifact(keys.artifact, { arch: 'x64' })] }, keys.catalog);
    expect(() => verifyKernelCatalog(replacement, trustStore(keys), accepted, now())).toThrowError(
      expect.objectContaining({ code: 'sequence-equivocation' }),
    );
  });

  it('allows an exact emergency downgrade only with a scoped rollback-key authorization', () => {
    const keys = createKeys();
    const artifact = signedArtifact(keys.artifact);
    const unsignedTarget = baseCatalog(9, [artifact]);
    const targetSha256 = catalogRollbackTargetSha256({
      ...unsignedTarget,
      catalogSignature: placeholderSignature(keys.catalog.keyId),
    });
    const unsignedAuthorization: Omit<EmergencyRollbackAuthorizationV1, 'signing'> = {
      schemaVersion: 1,
      authorizationId: 'security-incident-2026-08-23',
      fromSequence: 10,
      toSequence: 9,
      catalogSha256: targetSha256,
      reason: 'Sequence 10 contains a confirmed remote-code-execution regression.',
      issuedAt: '2026-08-23T00:00:00.000Z',
      expiresAt: '2026-08-24T00:00:00.000Z',
    };
    const authorization: EmergencyRollbackAuthorizationV1 = {
      ...unsignedAuthorization,
      signing: signature(unsignedRollbackAuthorization({
        ...unsignedAuthorization,
        signing: placeholderSignature(keys.rollback.keyId),
      }), keys.rollback),
    };
    const catalog = signedCatalog({ sequence: 9, artifacts: [artifact], emergencyRollback: authorization }, keys.catalog);
    const result = verifyKernelCatalog(catalog, trustStore(keys), {
      schemaVersion: 1,
      highestSequence: 10,
      highestCatalogSha256: 'f'.repeat(64),
    }, now());

    expect(result.usedEmergencyRollback).toBe(true);
    expect(result.state.highestSequence).toBe(10);

    const wrongScope = {
      ...catalog,
      emergencyRollback: { ...authorization, fromSequence: 11 },
    };
    const resigned = {
      ...wrongScope,
      catalogSignature: signature(unsignedCatalogEnvelope(wrongScope), keys.catalog),
    };
    expect(() => verifyKernelCatalog(resigned, trustStore(keys), { schemaVersion: 1, highestSequence: 10 }, now())).toThrow();
  });
});

function baseArtifact(overrides: Partial<KernelArtifactDescriptorV1> = {}): KernelArtifactDescriptorV1 {
  const hash = 'a'.repeat(64);
  return {
    schemaVersion: 1,
    kernelId: 'openclaw' as KernelArtifactDescriptorV1['kernelId'],
    displayName: 'OpenClaw',
    upstreamVersion: '2026.7.1-2',
    upstreamCommit: '0'.repeat(40),
    patchRevision: 1,
    artifactVersion: '2026.7.1-2+clawx.1',
    platform: 'darwin',
    arch: 'arm64',
    minHostVersion: '0.6.0',
    maxHostVersion: '0.6.x',
    capabilityContractVersion: 1,
    protocols: {
      chat: { name: 'acp', min: 1, max: 1 },
      control: { name: 'clawx-kernel', min: 1, max: 1 },
      conversationStore: { name: 'clawx-conversation-store', min: 1, max: 1 },
    },
    checkpointCodecs: [{ id: 'openclaw-managed-session', schemaVersion: 1, portable: false }],
    storage: { authority: 'clawx-data-service', nativeDurableHistory: false, regressionReportSha256: hash },
    node: { version: '24.15.0', moduleAbi: 137, distributionSha256: hash },
    archive: {
      format: 'tar.zst',
      url: 'https://artifacts.example.test/openclaw.tar.zst',
      sha256: hash,
      compressedSize: 100,
      unpackedSize: 200,
      fileCount: 3,
    },
    entrypoints: { chat: 'runtime/kernel/chat.mjs' },
    supplyChain: {
      sourceSha256: hash,
      lockfileSha256: hash,
      patchSeriesSha256: hash,
      fileManifestSha256: hash,
      sbomSha256: hash,
      noticesSha256: hash,
      provenanceSha256: hash,
      testReportSha256: hash,
    },
    budgets: { coldReadyMs: 30_000, idleRssBytes: 512 * 1024 * 1024 },
    publishedAt: '2026-08-01T00:00:00.000Z',
    expiresAt: '2027-01-01T00:00:00.000Z',
    descriptorSignature: placeholderSignature('placeholder'),
    ...overrides,
  };
}

function signedArtifact(keyMaterial: KeyMaterial, overrides: Partial<KernelArtifactDescriptorV1> = {}): KernelArtifactDescriptorV1 {
  const artifact = baseArtifact(overrides);
  return { ...artifact, descriptorSignature: signature(unsignedArtifactDescriptor(artifact), keyMaterial) };
}

function baseCatalog(sequence: number, artifacts: KernelArtifactDescriptorV1[]): Omit<KernelCatalogEnvelopeV1, 'catalogSignature'> {
  return {
    schemaVersion: 1,
    channel: 'production',
    sequence,
    issuedAt: '2026-08-23T00:00:00.000Z',
    expiresAt: '2026-08-24T00:00:00.000Z',
    artifacts,
    revokedArtifactIdentities: [],
  };
}

function signedCatalog(
  input: { sequence: number; artifacts: KernelArtifactDescriptorV1[]; emergencyRollback?: EmergencyRollbackAuthorizationV1 },
  keyMaterial: KeyMaterial,
): KernelCatalogEnvelopeV1 {
  const unsigned = { ...baseCatalog(input.sequence, input.artifacts), ...(input.emergencyRollback ? { emergencyRollback: input.emergencyRollback } : {}) };
  return { ...unsigned, catalogSignature: signature(unsigned, keyMaterial) };
}

function signature(value: unknown, keyMaterial: KeyMaterial) {
  return {
    algorithm: 'Ed25519' as const,
    keyId: keyMaterial.keyId,
    signature: sign(null, Buffer.from(canonicalJson(value)), keyMaterial.privateKey).toString('base64url'),
  };
}

function placeholderSignature(keyId: string) {
  return { algorithm: 'Ed25519' as const, keyId, signature: 'a'.repeat(86) };
}

function key(purpose: KernelSigningPurpose) {
  const pair = generateKeyPairSync('ed25519');
  return { ...pair, purpose, keyId: `${purpose}-2026-01` };
}

function createKeys() {
  return { artifact: key('artifact'), catalog: key('catalog'), rollback: key('rollback') };
}

function trustStore(keys: ReturnType<typeof createKeys>): KernelTrustStoreV1 {
  return {
    schemaVersion: 1,
    keys: Object.values(keys).map((material) => ({
      keyId: material.keyId,
      algorithm: 'Ed25519',
      purposes: [material.purpose],
      publicKeyPem: material.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      notBefore: '2026-01-01T00:00:00.000Z',
      notAfter: '2027-01-01T00:00:00.000Z',
    })),
  };
}

function now() {
  return new Date('2026-08-23T12:00:00.000Z');
}
