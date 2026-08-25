// @vitest-environment node

import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson } from '../../scripts/kernel-runtime/lib/canonical.mjs';
import {
  assertGitHubDistributionTarget,
  resolvePreviousProductionCatalog,
} from '../../scripts/kernel-runtime/resolve-previous-catalog.mjs';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('production kernel catalog promotion continuity', () => {
  it('keeps the checked-in production distribution bound to Tabll/ClawXXX', () => {
    const distribution = JSON.parse(readFileSync(
      join(process.cwd(), 'resources/kernels/distribution.json'),
      'utf8',
    ));
    expect(() => assertGitHubDistributionTarget(distribution, 'Tabll/ClawXXX', 'kernel-runtimes'))
      .not.toThrow();
  });

  it('binds the configured GitHub mirrors to the repository and release tag that will receive writes', () => {
    const distribution = {
      catalogUrls: [
        'https://oss.example.invalid/catalog.json',
        'https://github.com/Tabll/ClawXXX/releases/download/kernel-runtimes/kernel-catalog.production.json',
      ],
      mirrorBaseUrls: [
        'https://oss.example.invalid/',
        'https://github.com/Tabll/ClawXXX/releases/download/kernel-runtimes/',
      ],
    };
    expect(() => assertGitHubDistributionTarget(distribution, 'Tabll/ClawXXX', 'kernel-runtimes'))
      .not.toThrow();
    expect(() => assertGitHubDistributionTarget(distribution, 'ValueCell-ai/ClawX', 'kernel-runtimes'))
      .toThrow(/not bound/);
    expect(() => assertGitHubDistributionTarget(distribution, 'Tabll/ClawXXX', 'other-tag'))
      .toThrow(/not bound/);
  });

  it('requires both mirrors to return the exact signed N-1 catalog', async () => {
    const fixture = signingFixture();
    const previous = signedCatalog(fixture, 3);
    const urls = ['https://oss.example.invalid/catalog.json', 'https://github.example.invalid/catalog.json'];
    const fetcher = vi.fn(async () => new Response(JSON.stringify(previous), {
      status: 200,
      headers: { ETag: '"catalog-3"' },
    }));

    const result = await resolvePreviousProductionCatalog({
      distribution: { catalogUrls: urls },
      trustStore: fixture.trustStore,
      nextSequence: 4,
      fetcher,
      attempts: 1,
      retryDelayMs: 0,
      now: new Date('2026-09-01T00:00:00.000Z'),
    });

    expect(result.previousCatalog).toEqual(previous);
    expect(result.evidence).toMatchObject({
      ok: true,
      mode: 'continuation',
      previousSequence: 3,
      nextSequence: 4,
      mirrors: [{ url: urls[0], status: 200 }, { url: urls[1], status: 200 }],
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('fails closed on a mirror fork or incomplete bootstrap authorization', async () => {
    const fixture = signingFixture();
    const first = signedCatalog(fixture, 1);
    const fork = signedCatalog(fixture, 1, { revokedArtifactIdentities: ['openclaw/old+clawx.1/linux-x64'] });
    let request = 0;
    await expect(resolvePreviousProductionCatalog({
      distribution: { catalogUrls: ['https://one.invalid/catalog.json', 'https://two.invalid/catalog.json'] },
      trustStore: fixture.trustStore,
      nextSequence: 2,
      fetcher: async () => new Response(JSON.stringify(request++ === 0 ? first : fork), { status: 200 }),
      attempts: 1,
      retryDelayMs: 0,
      now: new Date('2026-09-01T00:00:00.000Z'),
    })).rejects.toThrow(/different signed previous catalogs/);

    const absent = async () => new Response('', { status: 404 });
    await expect(resolvePreviousProductionCatalog({
      distribution: { catalogUrls: ['https://one.invalid/catalog.json', 'https://two.invalid/catalog.json'] },
      trustStore: fixture.trustStore,
      nextSequence: 1,
      bootstrap: false,
      fetcher: absent,
    })).rejects.toThrow(/explicit protected bootstrap authorization/);
    await expect(resolvePreviousProductionCatalog({
      distribution: { catalogUrls: ['https://one.invalid/catalog.json', 'https://two.invalid/catalog.json'] },
      trustStore: fixture.trustStore,
      nextSequence: 1,
      bootstrap: true,
      fetcher: absent,
    })).resolves.toMatchObject({ previousCatalog: undefined, evidence: { mode: 'bootstrap' } });
  });

  it('idempotently resolves a trusted N/N-1 partial publication and rejects changed retry intent', async () => {
    const fixture = signingFixture();
    const previous = signedCatalog(fixture, 1);
    const published = signedCatalog(fixture, 2, {
      issuedAt: '2026-09-01T00:00:00.000Z',
      expiresAt: '2026-10-01T00:00:00.000Z',
      revokedArtifactIdentities: ['openclaw/old+clawx.1/linux-x64'],
    });
    let request = 0;
    const input = {
      distribution: { catalogUrls: ['https://one.invalid/catalog.json', 'https://two.invalid/catalog.json'] },
      trustStore: fixture.trustStore,
      nextSequence: 2,
      fetcher: async () => new Response(JSON.stringify(request++ === 0 ? previous : published), { status: 200 }),
      attempts: 1,
      retryDelayMs: 0,
      now: new Date('2026-09-02T00:00:00.000Z'),
      expectedIssuedAt: '2026-09-01T00:00:00.000Z',
      expectedExpiresAt: '2026-10-01T00:00:00.000Z',
      requiredRevocations: ['openclaw/old+clawx.1/linux-x64'],
    };
    await expect(resolvePreviousProductionCatalog(input)).resolves.toMatchObject({
      previousCatalog: { sequence: 1 },
      publishedCatalog: { sequence: 2 },
      evidence: { mode: 'resume-publication' },
    });

    request = 0;
    await expect(resolvePreviousProductionCatalog({
      ...input,
      expectedExpiresAt: '2026-11-01T00:00:00.000Z',
    })).rejects.toThrow(/expiresAt does not match/);
  });

  it('extends only a verified previous catalog and emits a sequence N catalog', () => {
    const fixture = signingFixture();
    const root = temporaryRoot();
    const descriptorPath = writeJson(root, 'descriptor.json', fixture.descriptor);
    const previousPath = writeJson(root, 'previous.json', signedCatalog(fixture, 1));
    const trustPath = writeJson(root, 'trust.json', fixture.trustStore);
    const output = join(root, 'catalog.production.json');

    runPromotion([
      '--descriptor', descriptorPath,
      '--sequence', '2',
      '--channel', 'production',
      '--issued-at', '2026-09-01T00:00:00.000Z',
      '--expires-at', '2026-10-01T00:00:00.000Z',
      '--previous', previousPath,
      '--trust-store', trustPath,
      '--bootstrap', 'false',
      '--output', output,
    ], fixture);

    expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({
      channel: 'production',
      sequence: 2,
      artifacts: [{ kernelId: 'openclaw', artifactVersion: fixture.descriptor.artifactVersion }],
    });
  });

  it('rejects unsigned continuity, unknown revocations, sequence resets and validity-window gaps', () => {
    const fixture = signingFixture();
    const root = temporaryRoot();
    const descriptorPath = writeJson(root, 'descriptor.json', fixture.descriptor);
    const tampered = { ...signedCatalog(fixture, 1), sequence: 7 };
    const tamperedPath = writeJson(root, 'tampered.json', tampered);
    const trustPath = writeJson(root, 'trust.json', fixture.trustStore);
    const common = (selectedTrustPath: string) => [
      '--descriptor', descriptorPath,
      '--channel', 'production',
      '--issued-at', '2026-09-01T00:00:00.000Z',
      '--expires-at', '2026-10-01T00:00:00.000Z',
      '--trust-store', selectedTrustPath,
      '--bootstrap', 'false',
    ];

    expect(() => runPromotion([
      ...common(trustPath), '--sequence', '8', '--previous', tamperedPath, '--output', join(root, 'tampered-output.json'),
    ], fixture)).toThrow();
    expect(() => runPromotion([
      ...common(trustPath), '--sequence', '1', '--output', join(root, 'reset-output.json'),
    ], fixture)).toThrow();

    const previousPath = writeJson(root, 'previous.json', signedCatalog(fixture, 1));
    expect(() => runPromotion([
      ...common(trustPath),
      '--sequence', '2',
      '--previous', previousPath,
      '--revoke', 'unknown/1.0.0+clawx.1/linux-x64',
      '--output', join(root, 'unknown-revoke-output.json'),
    ], fixture)).toThrow();

    const shortTrust = {
      ...fixture.trustStore,
      keys: fixture.trustStore.keys.map(key => (
        key.keyId === fixture.catalogKeyId ? { ...key, notAfter: '2026-09-15T00:00:00.000Z' } : key
      )),
    };
    const shortTrustPath = writeJson(root, 'short-trust.json', shortTrust);
    expect(() => runPromotion([
      ...common(shortTrustPath),
      '--sequence', '2',
      '--previous', previousPath,
      '--output', join(root, 'short-window-output.json'),
    ], fixture)).toThrow();
  });
});

function signingFixture() {
  const artifact = generateKeyPairSync('ed25519');
  const catalog = generateKeyPairSync('ed25519');
  const artifactKeyId = 'artifact-release-2026-08';
  const catalogKeyId = 'catalog-release-2026-08';
  const unsignedDescriptor = {
    schemaVersion: 1,
    kernelId: 'openclaw',
    artifactVersion: '2026.7.1-2+clawx.6',
    platform: 'linux',
    arch: 'x64',
    archive: {
      format: 'tar.zst',
      url: 'https://oss.example.invalid/openclaw.tar.zst',
    },
    storage: { authority: 'clawx-data-service', nativeDurableHistory: false },
    supplyChain: {},
    publishedAt: '2026-08-20T00:00:00.000Z',
    expiresAt: '2027-08-20T00:00:00.000Z',
  };
  const descriptor = {
    ...unsignedDescriptor,
    descriptorSignature: signature(unsignedDescriptor, artifact.privateKey, artifactKeyId),
  };
  const trustStore = {
    schemaVersion: 1,
    keys: [
      trustKey(artifactKeyId, ['artifact'], artifact.publicKey),
      trustKey(catalogKeyId, ['catalog'], catalog.publicKey),
    ],
  };
  return {
    artifactKeyId,
    catalogKeyId,
    catalogPrivateKey: catalog.privateKey,
    catalogPrivateKeyPem: catalog.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    descriptor,
    trustStore,
  };
}

function signedCatalog(
  fixture: ReturnType<typeof signingFixture>,
  sequence: number,
  overrides: Record<string, unknown> = {},
) {
  const unsigned = {
    schemaVersion: 1,
    channel: 'production',
    sequence,
    issuedAt: '2026-08-24T00:00:00.000Z',
    expiresAt: '2026-12-01T00:00:00.000Z',
    artifacts: [fixture.descriptor],
    revokedArtifactIdentities: [],
    ...overrides,
  };
  return { ...unsigned, catalogSignature: signature(unsigned, fixture.catalogPrivateKey, fixture.catalogKeyId) };
}

function signature(value: unknown, privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'], keyId: string) {
  return {
    algorithm: 'Ed25519',
    keyId,
    signature: sign(null, Buffer.from(canonicalJson(value)), privateKey).toString('base64url'),
  };
}

function trustKey(
  keyId: string,
  purposes: string[],
  publicKey: ReturnType<typeof generateKeyPairSync>['publicKey'],
) {
  return {
    keyId,
    algorithm: 'Ed25519',
    purposes,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    notBefore: '2026-01-01T00:00:00.000Z',
    notAfter: '2028-01-01T00:00:00.000Z',
  };
}

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), 'clawx-catalog-promotion-'));
  roots.push(root);
  return root;
}

function writeJson(root: string, name: string, value: unknown) {
  const path = join(root, name);
  writeFileSync(path, `${JSON.stringify(value)}\n`);
  return path;
}

function runPromotion(args: string[], fixture: ReturnType<typeof signingFixture>) {
  return execFileSync(process.execPath, ['scripts/kernel-runtime/promote-catalog.mjs', ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLAWX_CATALOG_SIGNING_KEY_ID: fixture.catalogKeyId,
      CLAWX_CATALOG_SIGNING_PRIVATE_KEY_B64: Buffer.from(fixture.catalogPrivateKeyPem).toString('base64'),
    },
    encoding: 'utf8',
    stdio: 'pipe',
  });
}
