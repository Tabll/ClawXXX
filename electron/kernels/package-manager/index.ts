import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import type { statfs } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  KernelArtifactDescriptorV1,
  KernelCatalogEnvelopeV1,
  KernelTrustStoreV1,
} from '@shared/kernels/catalog';
import type { KernelId } from '@shared/kernels/contracts';
import type {
  KernelCatalogLoadResult,
  KernelDownloadProgress,
  KernelHostCompatibility,
  KernelInstallationRecord,
  KernelInstallResult,
  KernelRuntimeVersionRecord,
  KernelUninstallResult,
} from '@shared/kernels/package-manager';
import {
  verifyKernelArtifactDescriptor,
} from '../catalog';
import {
  compatibilityFailures,
  KernelCatalogClient,
  resolveCompatibleArtifact,
} from './catalog-client';
import { assertKernelInstallDiskSpace } from './disk-space';
import { KernelArtifactDownloader, sha256File } from './downloader';
import { KernelPackageError } from './errors';
import { KernelPackageLayout } from './layout';
import { SafeKernelArtifactExtractor, verifyExtractedArtifact } from './safe-extractor';
import { ControlBridgeSmokeTester, type KernelSmokeTester } from './smoke-test';
import type { KernelPackageStateStore } from './state';

type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type KernelPackageManagerOptions = {
  root: string;
  state: KernelPackageStateStore;
  trustStore: KernelTrustStoreV1;
  host: KernelHostCompatibility;
  fetcher?: Fetcher;
  smokeTester?: KernelSmokeTester;
  now?: () => Date;
  statfsImpl?: typeof statfs;
  isVersionInUse?: (kernelId: KernelId, artifactVersion: string) => boolean | Promise<boolean>;
  isKernelBusy?: (kernelId: KernelId) => boolean | Promise<boolean>;
  removeTrashPath?: (path: string) => Promise<void>;
};

export type InstallFromCatalogInput = {
  kernelId: KernelId;
  channel: 'staging' | 'production';
  catalogUrls: string[];
  mirrorBaseUrls?: string[];
  signal?: AbortSignal;
  activate?: boolean;
  onProgress?: (progress: KernelDownloadProgress) => void;
};

export class KernelPackageManager {
  readonly layout: KernelPackageLayout;
  readonly catalog: KernelCatalogClient;
  private readonly downloader: KernelArtifactDownloader;
  private readonly extractor = new SafeKernelArtifactExtractor();
  private readonly smokeTester: KernelSmokeTester;
  private readonly now: () => Date;
  private readonly operationTails = new Map<KernelId, Promise<void>>();

  constructor(private readonly options: KernelPackageManagerOptions) {
    this.layout = new KernelPackageLayout(options.root);
    this.now = options.now ?? (() => new Date());
    this.catalog = new KernelCatalogClient({
      state: options.state,
      trustStore: options.trustStore,
      ...(options.fetcher ? { fetcher: options.fetcher } : {}),
      now: this.now,
    });
    this.downloader = new KernelArtifactDownloader(this.layout, {
      ...(options.fetcher ? { fetcher: options.fetcher } : {}),
      now: this.now,
    });
    this.smokeTester = options.smokeTester ?? new ControlBridgeSmokeTester();
  }

  loadCatalog(input: {
    channel: 'staging' | 'production';
    urls: string[];
    signal?: AbortSignal;
  }): Promise<KernelCatalogLoadResult> {
    return this.catalog.load(input);
  }

  async installFromCatalog(input: InstallFromCatalogInput): Promise<KernelInstallResult> {
    const loaded = await this.catalog.load({ channel: input.channel, urls: input.catalogUrls, signal: input.signal });
    if (!loaded.installAllowed) {
      throw new KernelPackageError('catalog-stale', 'An expired offline catalog cannot authorize a new runtime installation');
    }
    const descriptor = resolveCompatibleArtifact(loaded.catalog, input.kernelId, this.options.host, this.now());
    return this.installDescriptor(descriptor, {
      mirrorBaseUrls: input.mirrorBaseUrls,
      signal: input.signal,
      activate: input.activate,
      onProgress: input.onProgress,
      allowDowngrade: loaded.emergencyRollbackAuthorized,
      reason: 'install',
    });
  }

  async importOffline(input: {
    descriptorPath: string;
    archivePath: string;
    activate?: boolean;
    onProgress?: (progress: KernelDownloadProgress) => void;
  }): Promise<KernelInstallResult> {
    const bytes = await readFile(input.descriptorPath);
    if (bytes.byteLength > 2 * 1024 * 1024) {
      throw new KernelPackageError('catalog-invalid', 'Offline runtime descriptor exceeds the size limit');
    }
    let raw: unknown;
    try {
      raw = JSON.parse(bytes.toString('utf8')) as unknown;
    } catch (error) {
      throw new KernelPackageError('catalog-invalid', 'Offline runtime descriptor is not valid JSON', error);
    }
    const descriptor = verifyKernelArtifactDescriptor(raw, this.options.trustStore, this.now());
    assertCompatible(descriptor, this.options.host, this.now(), false);
    await this.layout.ensure();
    const cachedArchive = await this.cacheOfflineArchive(input.archivePath, descriptor);
    return this.installDescriptor(descriptor, {
      archivePath: cachedArchive,
      activate: input.activate,
      onProgress: input.onProgress,
      allowDowngrade: false,
      reason: 'install',
    });
  }

  async activate(
    kernelId: KernelId,
    artifactVersion: string,
    reason: 'install' | 'update' | 'repair' = 'update',
  ): Promise<KernelInstallationRecord> {
    return this.withKernelLock(kernelId, () => this.withJournal('kernel.activate', kernelId, { artifactVersion, reason }, async () => {
      const version = await this.requireVerifiedVersion(kernelId, artifactVersion);
      await this.verifyInstalledVersion(version);
      if (await this.isKernelBusy(kernelId)) {
        throw new KernelPackageError('state-conflict', `Kernel ${kernelId} must be idle before activating a runtime update`);
      }
      const current = await this.options.state.getKernelInstallation(kernelId);
      const lastKnownGoodVersion = current?.activeVersion && current.activeVersion !== artifactVersion
        ? current.activeVersion
        : current?.lastKnownGoodVersion ?? artifactVersion;
      return this.options.state.commitKernelActivation({
        kernelId,
        activeVersion: artifactVersion,
        lastKnownGoodVersion,
        expectedActiveVersion: current?.activeVersion ?? null,
        reason,
        manifest: version.manifest,
        updatedAt: this.now().toISOString(),
      });
    }));
  }

  async rollback(kernelId: KernelId): Promise<KernelInstallationRecord> {
    return this.withKernelLock(kernelId, () => this.withJournal('kernel.rollback', kernelId, {}, async () => {
      const current = await this.options.state.getKernelInstallation(kernelId);
      const target = current?.lastKnownGoodVersion;
      if (!current?.activeVersion || !target || target === current.activeVersion) {
        throw new KernelPackageError('rollback-unavailable', `Kernel ${kernelId} has no distinct last-known-good version`);
      }
      const version = await this.requireVerifiedVersion(kernelId, target);
      await this.verifyInstalledVersion(version);
      if (await this.isKernelBusy(kernelId)) {
        throw new KernelPackageError('state-conflict', `Kernel ${kernelId} must be idle before rollback`);
      }
      return this.options.state.commitKernelActivation({
        kernelId,
        activeVersion: target,
        lastKnownGoodVersion: target,
        expectedActiveVersion: current.activeVersion,
        reason: 'rollback',
        manifest: version.manifest,
        updatedAt: this.now().toISOString(),
      });
    }));
  }

  async markLastKnownGood(kernelId: KernelId, artifactVersion: string): Promise<void> {
    await this.withKernelLock(kernelId, async () => {
      const current = await this.options.state.getKernelInstallation(kernelId);
      if (!current || current.activeVersion !== artifactVersion) {
        throw new KernelPackageError('state-conflict', 'Only the active runtime can become last-known-good');
      }
      await this.requireVerifiedVersion(kernelId, artifactVersion);
      await this.options.state.putKernelInstallation({
        ...current,
        lastKnownGoodVersion: artifactVersion,
        updatedAt: this.now().toISOString(),
      });
    });
  }

  async rescan(kernelId: KernelId, artifactVersion: string): Promise<KernelRuntimeVersionRecord> {
    return this.withKernelLock(kernelId, () => this.rescanUnlocked(kernelId, artifactVersion));
  }

  async repair(kernelId: KernelId): Promise<KernelInstallResult> {
    return this.withKernelLock(kernelId, async () => {
      const installation = await this.options.state.getKernelInstallation(kernelId);
      const target = installation?.activeVersion ?? installation?.desiredVersion ?? installation?.lastKnownGoodVersion;
      if (!target) throw new KernelPackageError('rollback-unavailable', `Kernel ${kernelId} has no recorded runtime to repair`);
      const version = await this.options.state.getKernelRuntimeVersion(kernelId, target);
      if (!version) throw new KernelPackageError('rollback-unavailable', `Kernel ${kernelId} has no repair descriptor`);
      try {
        const rescanned = await this.rescanUnlocked(kernelId, target);
        return {
          installation: (await this.options.state.getKernelInstallation(kernelId)) ?? installation!,
          version: rescanned,
          activated: installation?.activeVersion === target,
        };
      } catch {
        // Continue with the immutable cached archive after quarantine.
      }
      const archivePath = this.layout.archivePath(version.manifest);
      if (!await fileMatches(archivePath, version.manifest.archive.compressedSize, version.manifest.archive.sha256)) {
        throw new KernelPackageError('catalog-stale', 'Repair requires the verified cached archive or a fresh catalog update');
      }
      return this.installDescriptorUnlocked(version.manifest, {
        archivePath,
        activate: true,
        allowDowngrade: true,
        allowExpired: true,
        reason: 'repair',
      });
    });
  }

  async uninstall(kernelId: KernelId): Promise<KernelUninstallResult> {
    return this.withKernelLock(kernelId, () => this.withJournal('kernel.uninstall', kernelId, { dataPolicy: 'preserve' }, async () => {
      const versions = await this.options.state.listKernelRuntimeVersions(kernelId);
      for (const version of versions) {
        if (await this.isVersionInUse(kernelId, version.artifactVersion)) {
          throw new KernelPackageError('runtime-in-use', `Runtime ${kernelId}/${version.artifactVersion} is still in use`);
        }
      }
      const removedVersions: string[] = [];
      const deferredToTrash: string[] = [];
      for (const version of versions) {
        const path = this.layout.installPath(version.manifest);
        const trash = await this.moveRuntimeToTrash(kernelId, version.artifactVersion, path);
        if (trash) {
          try {
            await this.removeTrashPath(trash);
          } catch {
            deferredToTrash.push(trash);
          }
        }
        await rm(this.layout.archivePath(version.manifest), { force: true }).catch(() => undefined);
        await this.options.state.removeKernelRuntimeVersion(kernelId, version.artifactVersion);
        removedVersions.push(version.artifactVersion);
      }
      await this.options.state.putKernelInstallation({
        kernelId,
        state: 'not-installed',
        updatedAt: this.now().toISOString(),
      });
      return { kernelId, removedVersions, deferredToTrash, canonicalDataPreserved: true };
    }));
  }

  async cleanupTrash(): Promise<{ removed: string[]; retained: string[] }> {
    await this.layout.ensure();
    const removed: string[] = [];
    const retained: string[] = [];
    for (const entry of await readdir(this.layout.trash, { withFileTypes: true })) {
      const path = join(this.layout.trash, entry.name);
      try {
        if (this.options.removeTrashPath) await this.options.removeTrashPath(path);
        else await rm(path, { recursive: entry.isDirectory(), force: true, maxRetries: 3 });
        removed.push(path);
      } catch {
        retained.push(path);
      }
    }
    return { removed, retained };
  }

  async recoverInterruptedOperations(): Promise<void> {
    await this.layout.ensure();
    await this.cleanupTrash();
    for (const entry of await readdir(this.layout.staging, { withFileTypes: true })) {
      await rm(join(this.layout.staging, entry.name), { recursive: entry.isDirectory(), force: true, maxRetries: 3 });
    }
    for (const installation of await this.options.state.listKernelInstallations()) {
      if (!installation.activeVersion) continue;
      const active = await this.options.state.getKernelRuntimeVersion(installation.kernelId, installation.activeVersion);
      if (active && await pathExists(this.layout.installPath(active.manifest))) continue;
      const fallback = installation.lastKnownGoodVersion
        ? await this.options.state.getKernelRuntimeVersion(installation.kernelId, installation.lastKnownGoodVersion)
        : undefined;
      if (fallback?.state === 'verified' && await pathExists(this.layout.installPath(fallback.manifest))) {
        await this.options.state.commitKernelActivation({
          kernelId: installation.kernelId,
          activeVersion: fallback.artifactVersion,
          lastKnownGoodVersion: fallback.artifactVersion,
          expectedActiveVersion: installation.activeVersion,
          reason: 'recovery',
          manifest: fallback.manifest,
          updatedAt: this.now().toISOString(),
        });
      } else {
        await this.options.state.putKernelInstallation({
          ...installation,
          activeVersion: undefined,
          state: 'error',
          lastError: 'Active runtime is missing and no last-known-good runtime is available',
          updatedAt: this.now().toISOString(),
        });
      }
    }
  }

  private async installDescriptor(
    descriptor: KernelArtifactDescriptorV1,
    input: InstallDescriptorOptions,
  ): Promise<KernelInstallResult> {
    return this.withKernelLock(descriptor.kernelId, () => this.installDescriptorUnlocked(descriptor, input));
  }

  private async installDescriptorUnlocked(
    descriptorInput: KernelArtifactDescriptorV1,
    input: InstallDescriptorOptions,
  ): Promise<KernelInstallResult> {
    const descriptor = verifyKernelArtifactDescriptor(
      descriptorInput,
      this.options.trustStore,
      this.now(),
      { allowExpired: input.allowExpired ?? false },
    );
    assertCompatible(descriptor, this.options.host, this.now(), input.allowExpired ?? false);
    return this.withJournal(`kernel.${input.reason}`, descriptor.kernelId, {
      artifactVersion: descriptor.artifactVersion,
      archiveSha256: descriptor.archive.sha256,
    }, async () => {
      const previous = await this.options.state.getKernelInstallation(descriptor.kernelId);
      try {
        assertNotDowngrade(previous?.manifest, descriptor, input.allowDowngrade ?? false);
        await this.layout.ensure();
        await this.setLifecycle(descriptor.kernelId, 'resolving', descriptor.artifactVersion);
        const partialBytes = await fileSize(this.layout.partialPath(descriptor));
        await assertKernelInstallDiskSpace(this.layout.root, descriptor, {
          downloadedBytes: partialBytes,
          ...(this.options.statfsImpl ? { statfsImpl: this.options.statfsImpl } : {}),
        });
        input.onProgress?.(progress(descriptor, 'resolving', partialBytes));
        await this.setLifecycle(descriptor.kernelId, 'downloading', descriptor.artifactVersion);
        const archivePath = input.archivePath ?? await this.downloader.download(descriptor, {
          mirrorBaseUrls: input.mirrorBaseUrls,
          signal: input.signal,
          onProgress: input.onProgress,
        });
        input.onProgress?.(progress(descriptor, 'verifying', descriptor.archive.compressedSize));
        await this.setLifecycle(descriptor.kernelId, 'verifying', descriptor.artifactVersion);
        if (!await fileMatches(archivePath, descriptor.archive.compressedSize, descriptor.archive.sha256)) {
          throw new KernelPackageError('archive-digest', 'Runtime archive failed verification before staging');
        }
        await this.setLifecycle(descriptor.kernelId, 'staging', descriptor.artifactVersion);
        input.onProgress?.(progress(descriptor, 'staging', descriptor.archive.compressedSize));
        const stagingPath = this.layout.stagingPath(descriptor, randomUUID());
        await this.extractor.extract(archivePath, stagingPath, descriptor);
        await this.setLifecycle(descriptor.kernelId, 'smoke-testing', descriptor.artifactVersion);
        input.onProgress?.(progress(descriptor, 'smoke-testing', descriptor.archive.compressedSize));
        try {
          await this.smokeTester.test(stagingPath, descriptor);
        } catch (error) {
          await this.quarantineStaging(stagingPath, descriptor, error);
          throw error;
        }
        const finalPath = this.layout.installPath(descriptor);
        await mkdir(dirname(finalPath), { recursive: true, mode: 0o700 });
        if (await pathExists(finalPath)) {
          try {
            await verifyExtractedArtifact(finalPath, descriptor);
            await rm(stagingPath, { recursive: true, force: true, maxRetries: 3 });
          } catch {
            await this.quarantineExisting(finalPath, descriptor, 'Existing runtime failed integrity verification');
            await rename(stagingPath, finalPath);
          }
        } else {
          await rename(stagingPath, finalPath);
        }
        const timestamp = this.now().toISOString();
        const version: KernelRuntimeVersionRecord = {
          kernelId: descriptor.kernelId,
          artifactVersion: descriptor.artifactVersion,
          platform: descriptor.platform,
          arch: descriptor.arch,
          archiveSha256: descriptor.archive.sha256,
          state: 'verified',
          manifest: descriptor,
          installedAt: timestamp,
          verifiedAt: timestamp,
          lastScanAt: timestamp,
        };
        await this.options.state.upsertKernelRuntimeVersion(version);
        const activate = input.activate ?? true;
        if (!activate || await this.isKernelBusy(descriptor.kernelId)) {
          const current = await this.options.state.getKernelInstallation(descriptor.kernelId);
          const installation: KernelInstallationRecord = {
            kernelId: descriptor.kernelId,
            desiredVersion: descriptor.artifactVersion,
            ...(current?.activeVersion ? { activeVersion: current.activeVersion } : {}),
            ...(current?.lastKnownGoodVersion ? { lastKnownGoodVersion: current.lastKnownGoodVersion } : {}),
            state: 'installed',
            ...(current?.manifest ? { manifest: current.manifest } : {}),
            updatedAt: timestamp,
          };
          await this.options.state.putKernelInstallation(installation);
          return { installation, version, activated: false };
        }
        input.onProgress?.(progress(descriptor, 'activating', descriptor.archive.compressedSize));
        const current = await this.options.state.getKernelInstallation(descriptor.kernelId);
        const lastKnownGoodVersion = current?.activeVersion && current.activeVersion !== descriptor.artifactVersion
          ? current.activeVersion
          : current?.lastKnownGoodVersion ?? descriptor.artifactVersion;
        const reason = current?.activeVersion && current.activeVersion !== descriptor.artifactVersion && input.reason === 'install'
          ? 'update'
          : input.reason;
        const installation = await this.options.state.commitKernelActivation({
          kernelId: descriptor.kernelId,
          activeVersion: descriptor.artifactVersion,
          lastKnownGoodVersion,
          expectedActiveVersion: current?.activeVersion ?? null,
          reason,
          manifest: descriptor,
          updatedAt: timestamp,
        });
        return { installation, version, activated: true };
      } catch (error) {
        await this.setLifecycle(
          descriptor.kernelId,
          'error',
          descriptor.artifactVersion,
          error instanceof Error ? error.message : String(error),
        ).catch(() => undefined);
        throw error;
      }
    });
  }

  private async rescanUnlocked(kernelId: KernelId, artifactVersion: string): Promise<KernelRuntimeVersionRecord> {
    const version = await this.options.state.getKernelRuntimeVersion(kernelId, artifactVersion);
    if (!version) throw new KernelPackageError('rollback-unavailable', `Runtime ${kernelId}/${artifactVersion} is not recorded`);
    try {
      verifyKernelArtifactDescriptor(version.manifest, this.options.trustStore, this.now(), { allowExpired: true });
      await verifyExtractedArtifact(this.layout.installPath(version.manifest), version.manifest);
      const rescanned: KernelRuntimeVersionRecord = {
        ...version,
        state: 'verified',
        lastScanAt: this.now().toISOString(),
        quarantineReason: undefined,
      };
      await this.options.state.upsertKernelRuntimeVersion(rescanned);
      return rescanned;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const quarantined: KernelRuntimeVersionRecord = {
        ...version,
        state: 'quarantined',
        lastScanAt: this.now().toISOString(),
        quarantineReason: reason,
      };
      await this.options.state.upsertKernelRuntimeVersion(quarantined);
      const path = this.layout.installPath(version.manifest);
      if (!await this.isVersionInUse(kernelId, artifactVersion)) {
        await this.quarantineExisting(path, version.manifest, reason).catch(() => undefined);
      }
      await this.recoverFromQuarantinedActive(kernelId, artifactVersion, reason);
      throw new KernelPackageError('artifact-integrity', `Runtime integrity rescan failed: ${reason}`, error);
    }
  }

  private async recoverFromQuarantinedActive(kernelId: KernelId, artifactVersion: string, reason: string): Promise<void> {
    const installation = await this.options.state.getKernelInstallation(kernelId);
    if (installation?.activeVersion !== artifactVersion) return;
    const fallback = installation.lastKnownGoodVersion && installation.lastKnownGoodVersion !== artifactVersion
      ? await this.options.state.getKernelRuntimeVersion(kernelId, installation.lastKnownGoodVersion)
      : undefined;
    if (fallback?.state === 'verified') {
      try {
        await verifyExtractedArtifact(this.layout.installPath(fallback.manifest), fallback.manifest);
        await this.options.state.commitKernelActivation({
          kernelId,
          activeVersion: fallback.artifactVersion,
          lastKnownGoodVersion: fallback.artifactVersion,
          expectedActiveVersion: artifactVersion,
          reason: 'recovery',
          manifest: fallback.manifest,
          updatedAt: this.now().toISOString(),
        });
        return;
      } catch {
        // The explicit error state below prevents either damaged version from launching.
      }
    }
    await this.options.state.putKernelInstallation({
      ...installation,
      activeVersion: undefined,
      state: 'error',
      lastError: reason,
      updatedAt: this.now().toISOString(),
    });
  }

  private async verifyInstalledVersion(version: KernelRuntimeVersionRecord): Promise<void> {
    verifyKernelArtifactDescriptor(version.manifest, this.options.trustStore, this.now(), { allowExpired: true });
    await verifyExtractedArtifact(this.layout.installPath(version.manifest), version.manifest);
  }

  private async requireVerifiedVersion(kernelId: KernelId, artifactVersion: string): Promise<KernelRuntimeVersionRecord> {
    const version = await this.options.state.getKernelRuntimeVersion(kernelId, artifactVersion);
    if (version?.state !== 'verified') {
      throw new KernelPackageError('rollback-unavailable', `Runtime ${kernelId}/${artifactVersion} is not verified`);
    }
    return version;
  }

  private async cacheOfflineArchive(sourcePath: string, descriptor: KernelArtifactDescriptorV1): Promise<string> {
    const sourceStats = await stat(sourcePath);
    if (!sourceStats.isFile() || sourceStats.size !== descriptor.archive.compressedSize
      || await sha256File(sourcePath) !== descriptor.archive.sha256) {
      throw new KernelPackageError('archive-digest', 'Offline runtime archive failed signed size/SHA-256 verification');
    }
    const destination = this.layout.archivePath(descriptor);
    if (await fileMatches(destination, descriptor.archive.compressedSize, descriptor.archive.sha256)) return destination;
    const temporary = `${destination}.${randomUUID()}.import`;
    await copyFile(sourcePath, temporary, fsConstants.COPYFILE_EXCL);
    try {
      if (!await fileMatches(temporary, descriptor.archive.compressedSize, descriptor.archive.sha256)) {
        throw new KernelPackageError('archive-digest', 'Offline archive changed while importing');
      }
      await rm(destination, { force: true });
      await rename(temporary, destination);
      return destination;
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async quarantineStaging(path: string, descriptor: KernelArtifactDescriptorV1, error: unknown): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error);
    const destination = this.layout.quarantinePath(descriptor);
    await rm(destination, { recursive: true, force: true, maxRetries: 3 });
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    if (await pathExists(path)) await rename(path, destination);
    const timestamp = this.now().toISOString();
    await this.options.state.upsertKernelRuntimeVersion({
      kernelId: descriptor.kernelId,
      artifactVersion: descriptor.artifactVersion,
      platform: descriptor.platform,
      arch: descriptor.arch,
      archiveSha256: descriptor.archive.sha256,
      state: 'quarantined',
      manifest: descriptor,
      installedAt: timestamp,
      verifiedAt: timestamp,
      lastScanAt: timestamp,
      quarantineReason: reason,
    });
  }

  private async quarantineExisting(path: string, descriptor: KernelArtifactDescriptorV1, _reason: string): Promise<void> {
    if (!await pathExists(path)) return;
    const destination = this.layout.quarantinePath(descriptor);
    await rm(destination, { recursive: true, force: true, maxRetries: 3 });
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await rename(path, destination);
  }

  private async moveRuntimeToTrash(kernelId: KernelId, artifactVersion: string, path: string): Promise<string | undefined> {
    if (!await pathExists(path)) return undefined;
    const destination = this.layout.trashPath(kernelId, artifactVersion, randomUUID());
    await rename(path, destination);
    return destination;
  }

  private async setLifecycle(
    kernelId: KernelId,
    state: KernelInstallationRecord['state'],
    desiredVersion?: string,
    lastError?: string,
  ): Promise<void> {
    const current = await this.options.state.getKernelInstallation(kernelId);
    await this.options.state.putKernelInstallation({
      kernelId,
      ...(desiredVersion ? { desiredVersion } : current?.desiredVersion ? { desiredVersion: current.desiredVersion } : {}),
      ...(current?.activeVersion ? { activeVersion: current.activeVersion } : {}),
      ...(current?.lastKnownGoodVersion ? { lastKnownGoodVersion: current.lastKnownGoodVersion } : {}),
      state,
      ...(current?.manifest ? { manifest: current.manifest } : {}),
      ...(lastError ? { lastError } : {}),
      updatedAt: this.now().toISOString(),
    });
  }

  private async withJournal<T>(
    kind: string,
    kernelId: KernelId,
    desiredState: unknown,
    operation: () => Promise<T>,
  ): Promise<T> {
    const id = randomUUID();
    const createdAt = this.now().toISOString();
    await this.options.state.putOperation({
      id,
      kind,
      targetType: 'kernel',
      targetId: kernelId,
      desiredState,
      createdAt,
    });
    try {
      const result = await operation();
      await this.options.state.completeOperation({ id, ok: true, updatedAt: this.now().toISOString() });
      return result;
    } catch (error) {
      await this.options.state.completeOperation({
        id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        updatedAt: this.now().toISOString(),
      }).catch(() => undefined);
      throw error;
    }
  }

  private async withKernelLock<T>(kernelId: KernelId, operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTails.get(kernelId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(accept => { release = accept; });
    const tail = previous.then(() => gate, () => gate);
    this.operationTails.set(kernelId, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.operationTails.get(kernelId) === tail) this.operationTails.delete(kernelId);
    }
  }

  private isVersionInUse(kernelId: KernelId, artifactVersion: string): Promise<boolean> {
    return Promise.resolve(this.options.isVersionInUse?.(kernelId, artifactVersion) ?? false);
  }

  private isKernelBusy(kernelId: KernelId): Promise<boolean> {
    return Promise.resolve(this.options.isKernelBusy?.(kernelId) ?? false);
  }

  private removeTrashPath(path: string): Promise<void> {
    return this.options.removeTrashPath?.(path)
      ?? rm(path, { recursive: true, force: true, maxRetries: 3 });
  }
}

type InstallDescriptorOptions = {
  archivePath?: string;
  mirrorBaseUrls?: string[];
  signal?: AbortSignal;
  activate?: boolean;
  onProgress?: (progress: KernelDownloadProgress) => void;
  allowDowngrade?: boolean;
  allowExpired?: boolean;
  reason: 'install' | 'repair';
};

export function assertSelectiveDataDeletionConfirmation(input: {
  kernelId: KernelId;
  categories: Array<'conversations' | 'cron' | 'channels' | 'usage' | 'blobs' | 'credentials'>;
  confirmation: string;
}): void {
  if (input.categories.length === 0 || input.confirmation !== `DELETE ${input.kernelId} DATA`) {
    throw new KernelPackageError(
      'confirmation-required',
      `Canonical data deletion is separate from runtime uninstall and requires the exact confirmation: DELETE ${input.kernelId} DATA`,
    );
  }
}

function assertCompatible(
  descriptor: KernelArtifactDescriptorV1,
  host: KernelHostCompatibility,
  now: Date,
  allowExpired: boolean,
): void {
  const failures = compatibilityFailures(descriptor, host, now).filter(reason => !(allowExpired && reason === 'expired'));
  if (failures.length > 0) {
    throw new KernelPackageError('artifact-incompatible', `Runtime artifact is incompatible with this host: ${failures.join(', ')}`);
  }
}

function assertNotDowngrade(
  current: KernelArtifactDescriptorV1 | undefined,
  next: KernelArtifactDescriptorV1,
  allowed: boolean,
): void {
  if (!current || current.artifactVersion === next.artifactVersion || allowed) return;
  const currentOrder = artifactOrder(current);
  const nextOrder = artifactOrder(next);
  for (let index = 0; index < currentOrder.length; index += 1) {
    if (nextOrder[index] > currentOrder[index]) return;
    if (nextOrder[index] < currentOrder[index]) {
      throw new KernelPackageError('artifact-downgrade', 'Runtime artifact downgrade requires signed emergency authorization or installed LKG rollback');
    }
  }
  if (next.artifactVersion.localeCompare(current.artifactVersion) < 0) {
    throw new KernelPackageError('artifact-downgrade', 'Runtime artifact downgrade requires signed emergency authorization or installed LKG rollback');
  }
}

function artifactOrder(descriptor: KernelArtifactDescriptorV1): number[] {
  const upstream = /^(\d+)\.(\d+)\.(\d+)/.exec(descriptor.upstreamVersion);
  return [
    upstream ? Number(upstream[1]) : 0,
    upstream ? Number(upstream[2]) : 0,
    upstream ? Number(upstream[3]) : 0,
    descriptor.patchRevision,
    Date.parse(descriptor.publishedAt),
  ];
}

function progress(
  descriptor: KernelArtifactDescriptorV1,
  phase: KernelDownloadProgress['phase'],
  receivedBytes: number,
): KernelDownloadProgress {
  return {
    kernelId: descriptor.kernelId,
    artifactVersion: descriptor.artifactVersion,
    phase,
    receivedBytes,
    totalBytes: descriptor.archive.compressedSize,
    resumed: receivedBytes > 0 && receivedBytes < descriptor.archive.compressedSize,
  };
}

async function fileSize(path: string): Promise<number> {
  try {
    const value = await stat(path);
    return value.isFile() ? value.size : 0;
  } catch {
    return 0;
  }
}

async function fileMatches(path: string, size: number, sha256: string): Promise<boolean> {
  try {
    const value = await stat(path);
    return value.isFile() && value.size === size && await sha256File(path) === sha256;
  } catch {
    return false;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export type { KernelCatalogEnvelopeV1 };
