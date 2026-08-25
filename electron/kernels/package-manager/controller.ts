import type { KernelCatalogEnvelopeV1 } from '@shared/kernels/catalog';
import type { KernelId, KernelRuntimeSnapshot } from '@shared/kernels/contracts';
import type {
  KernelCatalogEntry,
  KernelCatalogSnapshot,
  KernelDirectoryKind,
  KernelPackageMutationResult,
  KernelUninstallMutationResult,
} from '@shared/host-api/kernels';
import type {
  KernelCatalogStateRecord,
  KernelCompatibilityFailure,
  KernelDownloadProgress,
  KernelHostCompatibility,
  KernelInstallationRecord,
  KernelRuntimeVersionRecord,
} from '@shared/kernels/package-manager';
import type { KernelSupervisorRegistry } from '../supervisor-registry';
import { compatibilityFailures, resolveCompatibleArtifact } from './catalog-client';
import type { KernelPackageManager } from './index';
import type { KernelPackageStateStore } from './state';

const BUILTIN_KERNELS: ReadonlyArray<{ kernelId: KernelId; displayName: string }> = [
  { kernelId: 'openclaw', displayName: 'OpenClaw' },
  { kernelId: 'deepseek-harness', displayName: 'DeepSeek Harness' },
];

export type KernelPackageControllerOptions = {
  manager?: KernelPackageManager;
  unavailableReason?: string;
  state: KernelPackageStateStore;
  supervisors: KernelSupervisorRegistry;
  host: KernelHostCompatibility;
  channel?: KernelCatalogStateRecord['channel'];
  catalogUrls?: string[];
  mirrorBaseUrls?: string[];
  now?: () => Date;
  onProgress?: (progress: KernelDownloadProgress) => void;
  onChanged?: () => void;
  onActivated?: (kernelId: KernelId, installation: KernelInstallationRecord) => Promise<{ restartRequired?: boolean } | void>;
  onUninstalled?: (kernelId: KernelId) => Promise<void>;
  openDirectory?: (kernelId: KernelId, kind: KernelDirectoryKind) => Promise<void> | void;
};

/**
 * Main-owned package/catalog facade. Renderer sees a stable catalog regardless
 * of which concrete runtimes are installed and never receives runtime paths,
 * trust roots, catalog URLs, or package-manager transport details.
 */
export class KernelPackageController {
  private readonly channel: KernelCatalogStateRecord['channel'];
  private readonly catalogUrls: string[];
  private readonly now: () => Date;

  constructor(private readonly options: KernelPackageControllerOptions) {
    this.channel = options.channel ?? 'production';
    this.catalogUrls = [...(options.catalogUrls ?? [])];
    this.now = options.now ?? (() => new Date());
  }

  async catalog(refresh = false): Promise<KernelCatalogSnapshot> {
    let catalog: KernelCatalogEnvelopeV1 | undefined;
    let source: KernelCatalogSnapshot['source'] = 'builtin';
    let stale = false;
    let warning = this.options.unavailableReason;

    if (refresh && this.options.manager && this.catalogUrls.length > 0) {
      const manager = this.options.manager;
      const loaded = await manager.loadCatalog({ channel: this.channel, urls: this.catalogUrls });
      catalog = loaded.catalog;
      source = loaded.source;
      stale = loaded.stale;
      warning = loaded.warning;
    } else {
      const cached = await this.options.state.getKernelCatalogState(this.channel);
      catalog = cached?.cachedCatalog;
      if (catalog) {
        source = 'cache';
        stale = Date.parse(catalog.expiresAt) <= this.now().getTime();
        if (stale) warning = 'The cached kernel catalog is expired; installation and update are disabled.';
      }
    }

    const installations = await this.options.state.listKernelInstallations();
    const installationByKernel = new Map(installations.map(item => [item.kernelId, item]));
    const catalogKernels = new Map(BUILTIN_KERNELS.map(item => [item.kernelId, item.displayName]));
    for (const artifact of catalog?.artifacts ?? []) {
      if (!catalogKernels.has(artifact.kernelId)) catalogKernels.set(artifact.kernelId, artifact.displayName);
    }

    const entries = [...catalogKernels].map(([kernelId, displayName]) => {
      const installation = installationByKernel.get(kernelId) ?? notInstalled(kernelId, this.now());
      const runtime = normalizeRuntime(this.options.supervisors.status(kernelId), installation);
      const candidate = compatibleCandidate(catalog, kernelId, this.options.host, this.now());
      const failures = candidate.failures;
      const installAllowed = Boolean(
        this.options.manager
        && this.catalogUrls.length > 0
        && catalog
        && !stale
        && candidate.artifact,
      );
      return {
        kernelId,
        displayName: candidate.artifact?.displayName ?? displayName,
        installation,
        runtime,
        ...(candidate.artifact ? { availableVersion: candidate.artifact.artifactVersion } : {}),
        updateAvailable: Boolean(
          candidate.artifact
          && installation.activeVersion
          && installation.activeVersion !== candidate.artifact.artifactVersion,
        ),
        installAllowed,
        compatibilityFailures: failures,
      } satisfies KernelCatalogEntry;
    });

    return {
      entries,
      source,
      stale,
      ...(warning ? { warning } : {}),
      refreshedAt: this.now().toISOString(),
    };
  }

  async install(kernelId: KernelId): Promise<KernelPackageMutationResult> {
    const result = await this.requireManager().installFromCatalog({
      kernelId,
      channel: this.channel,
      catalogUrls: this.catalogUrls,
      ...(this.options.mirrorBaseUrls ? { mirrorBaseUrls: this.options.mirrorBaseUrls } : {}),
      activate: true,
      onProgress: this.options.onProgress,
    });
    const activation = result.activated
      ? await this.options.onActivated?.(kernelId, result.installation)
      : undefined;
    this.options.onChanged?.();
    return {
      installation: result.installation,
      runtime: normalizeRuntime(this.options.supervisors.status(kernelId), result.installation),
      ...(activation?.restartRequired || !result.activated ? { restartRequired: true } : {}),
    };
  }

  update(kernelId: KernelId): Promise<KernelPackageMutationResult> {
    return this.install(kernelId);
  }

  async repair(kernelId: KernelId): Promise<KernelPackageMutationResult> {
    const result = await this.requireManager().repair(kernelId);
    const activation = result.activated
      ? await this.options.onActivated?.(kernelId, result.installation)
      : undefined;
    this.options.onChanged?.();
    return {
      installation: result.installation,
      runtime: normalizeRuntime(this.options.supervisors.status(kernelId), result.installation),
      ...(activation?.restartRequired || !result.activated ? { restartRequired: true } : {}),
    };
  }

  async rollback(kernelId: KernelId): Promise<KernelPackageMutationResult> {
    const installation = await this.requireManager().rollback(kernelId);
    const activation = await this.options.onActivated?.(kernelId, installation);
    this.options.onChanged?.();
    return {
      installation,
      runtime: normalizeRuntime(this.options.supervisors.status(kernelId), installation),
      ...(activation?.restartRequired ? { restartRequired: true } : {}),
    };
  }

  async uninstall(kernelId: KernelId): Promise<KernelUninstallMutationResult> {
    await this.options.supervisors.stop(kernelId);
    const result = await this.requireManager().uninstall(kernelId);
    await this.options.onUninstalled?.(kernelId);
    this.options.onChanged?.();
    const installation = await this.options.state.getKernelInstallation(kernelId) ?? notInstalled(kernelId, this.now());
    return {
      ...result,
      installation,
      runtime: normalizeRuntime(this.options.supervisors.status(kernelId), installation),
    };
  }

  async versions(kernelId: KernelId): Promise<KernelRuntimeVersionRecord[]> {
    return this.options.state.listKernelRuntimeVersions(kernelId);
  }

  async openDirectory(kernelId: KernelId, kind: KernelDirectoryKind): Promise<void> {
    if (!this.options.openDirectory) throw new Error('Kernel directory access is unavailable');
    await this.options.openDirectory(kernelId, kind);
  }

  private requireManager(): KernelPackageManager {
    if (!this.options.manager) {
      throw new Error(this.options.unavailableReason || 'Kernel package distribution is not configured');
    }
    if (this.catalogUrls.length === 0) throw new Error('No kernel catalog URL is configured');
    return this.options.manager;
  }
}

function notInstalled(kernelId: KernelId, now: Date): KernelInstallationRecord {
  return { kernelId, state: 'not-installed', updatedAt: now.toISOString() };
}

function normalizeRuntime(
  runtime: KernelRuntimeSnapshot,
  installation: KernelInstallationRecord,
): KernelRuntimeSnapshot {
  if (runtime.state !== 'stopped') return runtime;
  if (installation.state === 'not-installed') return { ...runtime, state: 'not-installed' };
  if (installation.state === 'installed') return { ...runtime, state: 'installed' };
  return runtime;
}

function compatibleCandidate(
  catalog: KernelCatalogEnvelopeV1 | undefined,
  kernelId: KernelId,
  host: KernelHostCompatibility,
  now: Date,
): {
  artifact?: KernelCatalogEnvelopeV1['artifacts'][number];
  failures: KernelCompatibilityFailure[];
} {
  if (!catalog) return { failures: [] };
  try {
    return { artifact: resolveCompatibleArtifact(catalog, kernelId, host, now), failures: [] };
  } catch {
    const candidates = catalog.artifacts.filter(artifact => artifact.kernelId === kernelId);
    const failures = new Set<KernelCompatibilityFailure>();
    for (const artifact of candidates) {
      for (const failure of compatibilityFailures(artifact, host, now)) failures.add(failure);
    }
    if (candidates.length === 0) failures.add('kernel-not-found');
    return { failures: [...failures] };
  }
}
