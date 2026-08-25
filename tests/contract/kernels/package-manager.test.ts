import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assembleKernelArtifact } from '../../../scripts/kernel-runtime/lib/artifact.mjs';
import { ClawXDataService } from '@electron/data/clawx-data-service';
import { canonicalJson } from '@electron/kernels/catalog';
import { KernelCatalogClient, resolveCompatibleArtifact } from '@electron/kernels/package-manager/catalog-client';
import { KernelArtifactDownloader } from '@electron/kernels/package-manager/downloader';
import { KernelPackageError } from '@electron/kernels/package-manager/errors';
import {
  assertSelectiveDataDeletionConfirmation,
  KernelPackageManager,
} from '@electron/kernels/package-manager';
import { KernelPackageLayout } from '@electron/kernels/package-manager/layout';
import { SafeKernelArtifactExtractor } from '@electron/kernels/package-manager/safe-extractor';
import type { KernelArtifactDescriptorV1, KernelCatalogEnvelopeV1, KernelTrustStoreV1 } from '@shared/kernels/catalog';
import type { KernelHostCompatibility } from '@shared/kernels/package-manager';

const testNow = new Date('2026-08-24T00:00:00.000Z');
const abundantStatfs = async () => ({
  type: 0, bsize: 4096, blocks: 10_000_000, bfree: 9_000_000, bavail: 9_000_000,
  files: 10_000_000, ffree: 9_000_000,
});

let fixtureRoot: string;
let artifacts: [BuiltArtifact, BuiltArtifact];
let artifactPrivateKeyPem: string;
let catalogPrivateKeyPem: string;
let trustStore: KernelTrustStoreV1;

beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), 'clawx-package-manager-fixture-'));
  const artifactKeys = generateKeyPairSync('ed25519');
  const catalogKeys = generateKeyPairSync('ed25519');
  artifactPrivateKeyPem = artifactKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  catalogPrivateKeyPem = catalogKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  trustStore = {
    schemaVersion: 1,
    keys: [
      {
        keyId: 'artifact-test-1',
        algorithm: 'Ed25519',
        purposes: ['artifact'],
        publicKeyPem: artifactKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        notBefore: '2026-01-01T00:00:00.000Z',
        notAfter: '2028-01-01T00:00:00.000Z',
      },
      {
        keyId: 'catalog-test-1',
        algorithm: 'Ed25519',
        purposes: ['catalog'],
        publicKeyPem: catalogKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        notBefore: '2026-01-01T00:00:00.000Z',
        notAfter: '2028-01-01T00:00:00.000Z',
      },
    ],
  };
  await createFixtureRepository(fixtureRoot);
  artifacts = [
    await buildArtifact(fixtureRoot, '1.0.0', 1, 1_787_428_800, 'first'),
    await buildArtifact(fixtureRoot, '1.1.0', 2, 1_787_515_200, 'second'),
  ];
}, 60_000);

afterAll(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

describe('KernelPackageManager catalog and compatibility', () => {
  it('verifies and caches a monotonic catalog, falls back offline, and never replaces it with a downgrade', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clawx-catalog-contract-'));
    const service = new ClawXDataService(join(root, 'state.sqlite'));
    const state = service.connect({ role: 'main' });
    const currentCatalog = signedCatalog([artifacts[1].descriptor], 2);
    let responseMode: 'current' | 'offline' | 'downgrade' = 'current';
    const client = new KernelCatalogClient({
      state,
      trustStore,
      now: () => testNow,
      fetcher: async () => {
        if (responseMode === 'offline') throw new Error('network offline');
        const value = responseMode === 'current' ? currentCatalog : signedCatalog([artifacts[0].descriptor], 1);
        return new Response(JSON.stringify(value), { status: 200, headers: { ETag: '"catalog-v2"' } });
      },
    });
    try {
      const online = await client.load({ channel: 'production', urls: ['https://cdn.example.test/catalog.json'] });
      expect(online).toMatchObject({ source: 'network', installAllowed: true, stale: false });
      expect(online.catalog.sequence).toBe(2);

      responseMode = 'offline';
      const offline = await client.load({ channel: 'production', urls: ['https://cdn.example.test/catalog.json'] });
      expect(offline).toMatchObject({ source: 'cache', installAllowed: true, stale: false });
      expect(offline.catalog.sequence).toBe(2);

      responseMode = 'downgrade';
      const protectedResult = await client.load({ channel: 'production', urls: ['https://mirror.example.test/catalog.json'] });
      expect(protectedResult.source).toBe('cache');
      expect(protectedResult.catalog.sequence).toBe(2);
      expect((await state.getKernelCatalogState('production'))?.highestSequence).toBe(2);

      const staleClient = new KernelCatalogClient({
        state,
        trustStore,
        now: () => new Date('2028-02-01T00:00:00.000Z'),
        fetcher: async () => { throw new Error('offline'); },
      });
      await expect(staleClient.load({ channel: 'production', urls: ['https://cdn.example.test/catalog.json'] }))
        .resolves.toMatchObject({ source: 'cache', stale: true, installAllowed: false });
    } finally {
      state.disconnect();
      await service.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves host/protocol/platform/architecture/ABI compatibility before install', () => {
    const catalog = signedCatalog([artifacts[0].descriptor], 1);
    expect(resolveCompatibleArtifact(catalog, 'openclaw', compatibleHost(), testNow).artifactVersion)
      .toBe(artifacts[0].descriptor.artifactVersion);
    expect(() => resolveCompatibleArtifact(catalog, 'openclaw', {
      ...compatibleHost(),
      supportedNodeModuleAbis: [999],
    }, testNow)).toThrow(/node-module-abi/);
    expect(() => resolveCompatibleArtifact(catalog, 'openclaw', {
      ...compatibleHost(),
      hostVersion: '0.7.0',
    }, testNow)).toThrow(/host-version/);
  });
});

describe('KernelPackageManager download transport', () => {
  it('retains a truncated partial and resumes only with matching Range, ETag, and artifact identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clawx-download-resume-'));
    const layout = new KernelPackageLayout(root);
    const bytes = await readFile(artifacts[0].archivePath);
    const split = Math.floor(bytes.length / 2);
    let request = 0;
    let sawRange = false;
    const downloader = new KernelArtifactDownloader(layout, {
      fetcher: async (_url, init) => {
        request += 1;
        if (request === 1) {
          let emitted = false;
          const body = new ReadableStream<Uint8Array>({
            pull(controller) {
              if (!emitted) {
                emitted = true;
                controller.enqueue(bytes.subarray(0, split));
              } else {
                controller.error(new Error('connection reset'));
              }
            },
          });
          return new Response(body, { status: 200, headers: { ETag: '"artifact-v1"' } });
        }
        const headers = new Headers(init?.headers);
        sawRange = headers.get('range') === `bytes=${split}-` && headers.get('if-range') === '"artifact-v1"';
        return new Response(bytes.subarray(split), {
          status: 206,
          headers: {
            ETag: '"artifact-v1"',
            'Content-Range': `bytes ${split}-${bytes.length - 1}/${bytes.length}`,
          },
        });
      },
    });
    try {
      await expect(downloader.download(artifacts[0].descriptor)).rejects.toThrow(/source failed/);
      expect((await stat(layout.partialPath(artifacts[0].descriptor))).size).toBe(split);
      const progress: boolean[] = [];
      const downloaded = await downloader.download(artifacts[0].descriptor, {
        onProgress: value => progress.push(value.resumed),
      });
      expect(sawRange).toBe(true);
      expect(progress).toContain(true);
      expect(await readFile(downloaded)).toEqual(bytes);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects tampering, supports cancellation, and falls back to a configured mirror', async () => {
    const bytes = await readFile(artifacts[0].archivePath);
    const tampered = Buffer.from(bytes);
    tampered[tampered.length - 1] ^= 0xff;
    const tamperRoot = await mkdtemp(join(tmpdir(), 'clawx-download-tamper-'));
    const tamperDownloader = new KernelArtifactDownloader(new KernelPackageLayout(tamperRoot), {
      fetcher: async () => new Response(tampered, { status: 200, headers: { ETag: '"tampered"' } }),
    });
    await expect(tamperDownloader.download(artifacts[0].descriptor)).rejects.toThrow(/SHA-256/);

    const cancelledRoot = await mkdtemp(join(tmpdir(), 'clawx-download-cancel-'));
    const cancelled = new AbortController();
    cancelled.abort();
    const cancelledDownloader = new KernelArtifactDownloader(new KernelPackageLayout(cancelledRoot), {
      fetcher: async () => { throw new Error('must not fetch'); },
    });
    await expect(cancelledDownloader.download(artifacts[0].descriptor, { signal: cancelled.signal }))
      .rejects.toMatchObject({ code: 'download-cancelled' });

    const mirrorRoot = await mkdtemp(join(tmpdir(), 'clawx-download-mirror-'));
    const requested: string[] = [];
    const mirrorDownloader = new KernelArtifactDownloader(new KernelPackageLayout(mirrorRoot), {
      fetcher: async (url) => {
        requested.push(String(url));
        return String(url).startsWith('https://primary.example.test/')
          ? new Response('unavailable', { status: 503 })
          : new Response(bytes, { status: 200, headers: { ETag: '"mirror-v1"' } });
      },
    });
    const descriptor = {
      ...artifacts[0].descriptor,
      archive: { ...artifacts[0].descriptor.archive, url: `https://primary.example.test/${artifacts[0].descriptor.archive.sha256}.tar.zst` },
    };
    await expect(mirrorDownloader.download(descriptor, { mirrorBaseUrls: ['https://cn.example.test/kernels/'] }))
      .resolves.toBeTruthy();
    expect(requested).toHaveLength(2);
    expect(requested[1]).toContain('cn.example.test/kernels/');
    await Promise.all([tamperRoot, cancelledRoot, mirrorRoot].map(path => rm(path, { recursive: true, force: true })));
  });
});

describe('KernelPackageManager safe extraction', () => {
  it.each([
    ['traversal', '../escape', '0'],
    ['symlink', 'runtime/link', '2'],
    ['hardlink', 'runtime/link', '1'],
    ['device', 'runtime/device', '3'],
  ])('rejects %s archive entries before activation', async (_label, path, type) => {
    const root = await mkdtemp(join(tmpdir(), 'clawx-unsafe-archive-'));
    const bytes = zstdCompressSync(simpleTar(path, type, type === '0' ? Buffer.from('x') : Buffer.alloc(0)));
    const archivePath = join(root, 'unsafe.tar.zst');
    await writeFile(archivePath, bytes);
    const descriptor = descriptorForBytes(artifacts[0].descriptor, bytes, 1, 1);
    try {
      await expect(new SafeKernelArtifactExtractor().scanArchive(archivePath, descriptor))
        .rejects.toMatchObject({ code: 'archive-unsafe' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a decompression/file-size bomb against signed limits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clawx-archive-bomb-'));
    const bytes = zstdCompressSync(simpleTar('runtime/big.bin', '0', Buffer.alloc(64 * 1024)));
    const archivePath = join(root, 'bomb.tar.zst');
    await writeFile(archivePath, bytes);
    const descriptor = descriptorForBytes(artifacts[0].descriptor, bytes, 1, 1);
    try {
      await expect(new SafeKernelArtifactExtractor().scanArchive(archivePath, descriptor))
        .rejects.toMatchObject({ code: 'archive-bomb' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('KernelPackageManager immutable lifecycle', () => {
  it('installs, updates, retains LKG, quarantines corruption, crash-recovers, and uninstalls without deleting canonical data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clawx-package-lifecycle-'));
    const service = new ClawXDataService(join(root, 'state', 'clawx.sqlite'));
    const state = service.connect({ role: 'main' });
    await state.createConversation({ id: 'conversation-preserved' as never, title: 'Preserve me', createdAt: testNow.toISOString() });
    let runtimeInUse = false;
    let kernelBusy = false;
    const manager = managerFor(root, state, {
      isVersionInUse: () => runtimeInUse,
      isKernelBusy: () => kernelBusy,
    });
    try {
      const first = await manager.importOffline({ descriptorPath: artifacts[0].descriptorPath, archivePath: artifacts[0].archivePath });
      expect(first).toMatchObject({ activated: true, installation: { activeVersion: '1.0.0+clawx.1' } });
      const second = await manager.importOffline({ descriptorPath: artifacts[1].descriptorPath, archivePath: artifacts[1].archivePath });
      expect(second.installation).toMatchObject({
        activeVersion: '1.1.0+clawx.2',
        lastKnownGoodVersion: '1.0.0+clawx.1',
      });
      await expect(manager.rollback('openclaw')).resolves.toMatchObject({ activeVersion: '1.0.0+clawx.1' });
      await expect(manager.activate('openclaw', artifacts[1].descriptor.artifactVersion))
        .resolves.toMatchObject({ activeVersion: '1.1.0+clawx.2', lastKnownGoodVersion: '1.0.0+clawx.1' });
      await expect(manager.importOffline({ descriptorPath: artifacts[0].descriptorPath, archivePath: artifacts[0].archivePath }))
        .rejects.toMatchObject({ code: 'artifact-downgrade' });

      const corrupted = join(manager.layout.installPath(artifacts[1].descriptor), 'runtime', 'kernel', 'chat.mjs');
      await chmod(corrupted, 0o644);
      await appendFile(corrupted, '\ntampered\n');
      await expect(manager.rescan('openclaw', artifacts[1].descriptor.artifactVersion))
        .rejects.toMatchObject({ code: 'artifact-integrity' });
      expect((await state.getKernelInstallation('openclaw'))?.activeVersion).toBe(artifacts[0].descriptor.artifactVersion);
      expect((await state.getKernelRuntimeVersion('openclaw', artifacts[1].descriptor.artifactVersion))?.state).toBe('quarantined');

      await manager.importOffline({ descriptorPath: artifacts[1].descriptorPath, archivePath: artifacts[1].archivePath });
      const activeSecondPath = manager.layout.installPath(artifacts[1].descriptor);
      const missingAfterCrash = manager.layout.trashPath('openclaw', artifacts[1].descriptor.artifactVersion, 'deadbeef-0000');
      await rename(activeSecondPath, missingAfterCrash);
      await mkdir(join(manager.layout.staging, 'orphan'), { recursive: true });
      await manager.recoverInterruptedOperations();
      expect((await state.getKernelInstallation('openclaw'))?.activeVersion).toBe(artifacts[0].descriptor.artifactVersion);
      await expect(stat(join(manager.layout.staging, 'orphan'))).rejects.toThrow();

      const damagedLkg = join(manager.layout.installPath(artifacts[0].descriptor), 'runtime', 'kernel', 'chat.mjs');
      await chmod(damagedLkg, 0o644);
      await appendFile(damagedLkg, '\nrepair-me\n');
      await expect(manager.repair('openclaw')).resolves.toMatchObject({
        activated: true,
        installation: { activeVersion: '1.0.0+clawx.1' },
      });
      await expect(manager.rescan('openclaw', artifacts[0].descriptor.artifactVersion))
        .resolves.toMatchObject({ state: 'verified' });

      kernelBusy = true;
      await expect(manager.activate('openclaw', artifacts[0].descriptor.artifactVersion))
        .rejects.toMatchObject({ code: 'state-conflict' });
      kernelBusy = false;
      runtimeInUse = true;
      await expect(manager.uninstall('openclaw')).rejects.toMatchObject({ code: 'runtime-in-use' });
      runtimeInUse = false;
      const uninstalled = await manager.uninstall('openclaw');
      expect(uninstalled.canonicalDataPreserved).toBe(true);
      expect((await state.getKernelInstallation('openclaw'))?.state).toBe('not-installed');
      expect(await state.getConversation('conversation-preserved' as never)).toMatchObject({ title: 'Preserve me' });
    } finally {
      state.disconnect();
      await service.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('quarantines smoke failures, refuses disk-full installs, and defers locked trash to next-launch cleanup', async () => {
    const smokeRoot = await mkdtemp(join(tmpdir(), 'clawx-smoke-quarantine-'));
    const smokeService = new ClawXDataService(join(smokeRoot, 'state.sqlite'));
    const smokeState = smokeService.connect({ role: 'main' });
    const smokeManager = managerFor(smokeRoot, smokeState, {
      smokeTester: { test: async () => { throw new KernelPackageError('smoke-failed', 'fixture smoke failed'); } },
    });
    await expect(smokeManager.importOffline({ descriptorPath: artifacts[0].descriptorPath, archivePath: artifacts[0].archivePath }))
      .rejects.toMatchObject({ code: 'smoke-failed' });
    expect((await smokeState.getKernelRuntimeVersion('openclaw', artifacts[0].descriptor.artifactVersion))?.state)
      .toBe('quarantined');
    expect((await smokeState.getKernelInstallation('openclaw'))?.activeVersion).toBeUndefined();
    smokeState.disconnect();
    await smokeService.close();

    const diskRoot = await mkdtemp(join(tmpdir(), 'clawx-disk-full-'));
    const diskService = new ClawXDataService(join(diskRoot, 'state.sqlite'));
    const diskState = diskService.connect({ role: 'main' });
    const diskManager = managerFor(diskRoot, diskState, {
      statfsImpl: (async () => ({ ...await abundantStatfs(), bavail: 0 })) as never,
    });
    await expect(diskManager.importOffline({ descriptorPath: artifacts[0].descriptorPath, archivePath: artifacts[0].archivePath }))
      .rejects.toMatchObject({ code: 'disk-space' });
    expect((await diskState.getKernelInstallation('openclaw'))?.activeVersion).toBeUndefined();
    diskState.disconnect();
    await diskService.close();

    const lockedRoot = await mkdtemp(join(tmpdir(), 'clawx-locked-runtime-'));
    const lockedService = new ClawXDataService(join(lockedRoot, 'state.sqlite'));
    const lockedState = lockedService.connect({ role: 'main' });
    const lockedManager = managerFor(lockedRoot, lockedState, {
      removeTrashPath: async () => { throw Object.assign(new Error('locked'), { code: 'EBUSY' }); },
    });
    await lockedManager.importOffline({ descriptorPath: artifacts[0].descriptorPath, archivePath: artifacts[0].archivePath });
    const result = await lockedManager.uninstall('openclaw');
    expect(result.deferredToTrash).toHaveLength(1);
    expect((await lockedState.getKernelInstallation('openclaw'))?.state).toBe('not-installed');
    const cleanupManager = managerFor(lockedRoot, lockedState);
    await expect(cleanupManager.cleanupTrash()).resolves.toMatchObject({ retained: [] });
    lockedState.disconnect();
    await lockedService.close();

    await Promise.all([smokeRoot, diskRoot, lockedRoot].map(path => rm(path, { recursive: true, force: true })));
  }, 60_000);

  it('requires a separate exact confirmation for selective canonical-data deletion', () => {
    expect(() => assertSelectiveDataDeletionConfirmation({
      kernelId: 'openclaw', categories: ['conversations'], confirmation: 'delete',
    })).toThrow(/separate from runtime uninstall/);
    expect(() => assertSelectiveDataDeletionConfirmation({
      kernelId: 'openclaw', categories: ['conversations'], confirmation: 'DELETE openclaw DATA',
    })).not.toThrow();
  });
});

type BuiltArtifact = {
  descriptor: KernelArtifactDescriptorV1;
  descriptorPath: string;
  archivePath: string;
};

async function createFixtureRepository(root: string): Promise<void> {
  await mkdir(join(root, 'kernels', 'openclaw', 'patches'), { recursive: true });
  await mkdir(join(root, 'payload'), { recursive: true });
  await mkdir(join(root, 'node-runtime', process.platform === 'win32' ? '.' : 'bin'), { recursive: true });
  await writeFile(join(root, 'THIRD_PARTY_NOTICES.md'), '# Fixture notices\n');
  await writeFile(join(root, 'kernels', 'openclaw', 'patches', 'series'), 'fixture.patch\n');
  await writeFile(join(root, 'payload', 'chat.mjs'), 'export const chat = true;\n');
  await writeFile(join(root, 'payload', 'control.mjs'), 'export const control = true;\n');
  await writeFile(join(root, 'payload', 'package.json'), JSON.stringify({ name: 'fixture-kernel', version: '1.0.0', license: 'MIT' }));
  const nodePath = join(root, 'node-runtime', process.platform === 'win32' ? 'node.exe' : join('bin', 'node'));
  await writeFile(nodePath, process.platform === 'win32' ? 'fixture' : '#!/bin/sh\nexit 0\n');
  if (process.platform !== 'win32') chmodSync(nodePath, 0o755);
  await writeFile(join(root, 'node-runtime', 'LICENSE'), 'Fixture Node license\n');
  await writeFile(join(root, 'tests.json'), JSON.stringify({ schemaVersion: 1, ok: true }));
  await writeFile(join(root, 'storage.json'), JSON.stringify({
    schemaVersion: 1,
    ok: true,
    authority: 'clawx-data-service',
    nativeDurableHistory: false,
    scenarios: { new: true, prompt: true, cancel: true, compact: true, branch: true, restart: true, cron: true, channel: true },
    scannedPaths: [],
    violations: [],
  }));
  await writeFile(join(root, 'licenses.json'), JSON.stringify({
    schemaVersion: 1,
    ok: true,
    kernelId: 'openclaw',
    packages: [{ name: 'fixture-kernel', version: '1.0.0', license: 'MIT' }],
  }));
  await writeFile(join(root, 'platform-security.json'), JSON.stringify({
    schemaVersion: 1,
    ok: true,
    platform: process.platform,
    arch: process.arch,
    codeSigning: { fixture: true },
  }));
}

async function buildArtifact(root: string, upstreamVersion: string, patchRevision: number, epoch: number, name: string): Promise<BuiltArtifact> {
  const artifactVersion = `${upstreamVersion}+clawx.${patchRevision}`;
  const sha = 'a'.repeat(64);
  await writeFile(join(root, 'kernels', 'node-runtime.json'), JSON.stringify({
    schemaVersion: 1,
    version: '24.15.0',
    moduleAbi: 137,
    assets: [{ platform: process.platform, arch: process.arch, filename: 'node-fixture', archiveRoot: 'node-fixture', sha256: sha }],
  }));
  await writeFile(join(root, 'kernels', 'openclaw', 'runtime.json'), JSON.stringify({
    schemaVersion: 1,
    kernelId: 'openclaw',
    displayName: 'OpenClaw Fixture',
    artifactVersion,
    patchRevision,
    minHostVersion: '0.6.0',
    maxHostVersion: '0.6.x',
    capabilityContractVersion: 1,
    protocols: {
      chat: { name: 'acp', min: 1, max: 1 },
      control: { name: 'clawx-kernel', min: 1, max: 1 },
      conversationStore: { name: 'clawx-conversation-store', min: 1, max: 1 },
    },
    checkpointCodecs: [{ id: 'fixture', schemaVersion: 1, portable: false }],
    entrypoints: { chat: 'runtime/kernel/chat.mjs', control: 'runtime/kernel/control.mjs' },
    nativePayloadAllowlist: { [`${process.platform}-${process.arch}`]: [] },
    budgets: {
      compressedBytes: 16 * 1024 * 1024,
      unpackedBytes: 16 * 1024 * 1024,
      fileCount: 1_000,
      coldReadyMs: 5_000,
      idleRssBytes: 256 * 1024 * 1024,
    },
  }));
  await writeFile(join(root, 'kernels', 'openclaw', 'source.json'), JSON.stringify({
    schemaVersion: 1,
    kernelId: 'openclaw',
    displayName: 'OpenClaw Fixture',
    upstream: 'https://example.test/openclaw',
    version: upstreamVersion,
    git: { commit: String(patchRevision).repeat(40).slice(0, 40) },
    license: 'MIT',
    artifactVersion,
    patchRevision,
    sourceDateEpoch: epoch,
    lockfile: { contentPath: 'fixture-lock.yaml', contentSha256: 'b'.repeat(64) },
    patchSeries: { path: 'kernels/openclaw/patches/series' },
    runtime: { path: 'kernels/openclaw/runtime.json' },
    nodeRuntime: { path: 'kernels/node-runtime.json' },
  }));
  const output = join(root, `output-${name}`);
  const result = await assembleKernelArtifact({
    repositoryRoot: root,
    kernelId: 'openclaw',
    platform: process.platform,
    arch: process.arch,
    payloadDir: join(root, 'payload'),
    nodeDir: join(root, 'node-runtime'),
    nodeDistributionSha256: sha,
    testReportPath: join(root, 'tests.json'),
    storageReportPath: join(root, 'storage.json'),
    licenseReportPath: join(root, 'licenses.json'),
    platformSecurityReportPath: join(root, 'platform-security.json'),
    outputDir: output,
    artifactBaseUrl: 'https://artifacts.example.test/production',
    artifactSigningKeyId: 'artifact-test-1',
    artifactSigningPrivateKey: artifactPrivateKeyPem,
  });
  return { descriptor: result.descriptor, descriptorPath: result.descriptorPath, archivePath: result.archivePath };
}

function signedCatalog(descriptors: KernelArtifactDescriptorV1[], sequence: number): KernelCatalogEnvelopeV1 {
  const unsigned = {
    schemaVersion: 1 as const,
    channel: 'production' as const,
    sequence,
    issuedAt: '2026-08-23T00:00:00.000Z',
    expiresAt: '2027-01-01T00:00:00.000Z',
    artifacts: descriptors,
    revokedArtifactIdentities: [],
  };
  return {
    ...unsigned,
    catalogSignature: {
      algorithm: 'Ed25519',
      keyId: 'catalog-test-1',
      signature: sign(null, Buffer.from(canonicalJson(unsigned)), catalogPrivateKeyPem).toString('base64url'),
    },
  };
}

function compatibleHost(): KernelHostCompatibility {
  return {
    hostVersion: '0.6.0',
    platform: process.platform,
    arch: process.arch,
    capabilityContractVersion: 1,
    chatProtocol: { name: 'acp', version: 1 },
    controlProtocol: { name: 'clawx-kernel', version: 1 },
    conversationStoreProtocol: { name: 'clawx-conversation-store', version: 1 },
    supportedNodeModuleAbis: [137],
  };
}

function managerFor(
  root: string,
  state: ConstructorParameters<typeof KernelPackageManager>[0]['state'],
  overrides: Partial<ConstructorParameters<typeof KernelPackageManager>[0]> = {},
): KernelPackageManager {
  return new KernelPackageManager({
    root: join(root, 'kernels'),
    state,
    trustStore,
    host: compatibleHost(),
    now: () => testNow,
    statfsImpl: abundantStatfs as never,
    smokeTester: { test: async () => ({ readyMs: 1, rssBytes: 1, pid: 1 }) },
    ...overrides,
  });
}

function descriptorForBytes(
  base: KernelArtifactDescriptorV1,
  compressed: Buffer,
  fileCount: number,
  unpackedSize: number,
): KernelArtifactDescriptorV1 {
  const digest = createHash('sha256').update(compressed).digest('hex');
  return {
    ...base,
    archive: {
      ...base.archive,
      sha256: digest,
      compressedSize: compressed.byteLength,
      fileCount,
      unpackedSize,
    },
  };
}

function simpleTar(path: string, type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, 'utf8');
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, data.byteLength);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, 'ascii');
  if (type === '1' || type === '2') header.write('runtime/target', 157, 100, 'utf8');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  const checksum = [...header].reduce((sum, value) => sum + value, 0).toString(8).padStart(6, '0');
  header.write(checksum, 148, 6, 'ascii');
  header[154] = 0;
  header[155] = 0x20;
  const padding = Buffer.alloc((512 - data.byteLength % 512) % 512);
  return Buffer.concat([header, data, padding, Buffer.alloc(1_024)]);
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, '0');
  buffer.write(text, offset, length - 1, 'ascii');
  buffer[offset + length - 1] = 0;
}
