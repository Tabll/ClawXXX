import type { KernelArtifactDescriptorV1, KernelCatalogEnvelopeV1, KernelTrustStoreV1 } from '@shared/kernels/catalog';
import type { KernelId } from '@shared/kernels/contracts';
import type {
  KernelCatalogLoadResult,
  KernelCompatibilityFailure,
  KernelHostCompatibility,
} from '@shared/kernels/package-manager';
import {
  catalogContentSha256,
  parseKernelCatalog,
  verifyKernelCatalog,
} from '../catalog';
import { proxyAwareFetch } from '../../utils/proxy-fetch';
import { KernelPackageError } from './errors';
import type { KernelPackageStateStore } from './state';

const MAX_CATALOG_BYTES = 8 * 1024 * 1024;

export type KernelCatalogClientOptions = {
  state: KernelPackageStateStore;
  trustStore: KernelTrustStoreV1;
  fetcher?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  now?: () => Date;
};

export class KernelCatalogClient {
  private readonly fetcher: (input: string | URL, init?: RequestInit) => Promise<Response>;
  private readonly now: () => Date;

  constructor(private readonly options: KernelCatalogClientOptions) {
    this.fetcher = options.fetcher ?? proxyAwareFetch;
    this.now = options.now ?? (() => new Date());
  }

  async load(input: {
    channel: 'staging' | 'production';
    urls: string[];
    signal?: AbortSignal;
  }): Promise<KernelCatalogLoadResult> {
    if (input.urls.length === 0) throw new KernelPackageError('catalog-unavailable', 'No kernel catalog URL is configured');
    const state = await this.options.state.getKernelCatalogState(input.channel);
    const failures: string[] = [];
    for (const rawUrl of input.urls) {
      let url: string;
      try {
        url = checkedHttpsUrl(rawUrl);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
        continue;
      }
      try {
        const headers = new Headers({ Accept: 'application/json' });
        if (state?.etag && state.sourceUrl === url) headers.set('If-None-Match', state.etag);
        const response = await this.fetcher(url, {
          method: 'GET',
          headers,
          redirect: 'follow',
          signal: input.signal,
          cache: 'no-store',
        });
        assertHttpsResponse(response);
        if (response.status === 304) {
          if (!state?.cachedCatalog) throw new Error('Catalog server returned 304 without a verified local cache');
          return this.cachedResult(state, input.channel, 'Server confirmed the cached catalog is unchanged');
        }
        if (!response.ok) throw new Error(`Catalog request returned HTTP ${response.status}`);
        const raw = await readBoundedJson(response, MAX_CATALOG_BYTES);
        const verified = verifyKernelCatalog(raw, this.options.trustStore, {
          schemaVersion: 1,
          highestSequence: state?.highestSequence ?? 0,
          ...(state?.highestCatalogSha256 ? { highestCatalogSha256: state.highestCatalogSha256 } : {}),
        }, this.now());
        if (verified.catalog.channel !== input.channel) throw new Error('Catalog channel does not match the requested channel');
        const digest = catalogContentSha256(verified.catalog);
        const timestamp = this.now().toISOString();
        await this.options.state.putKernelCatalogState({
          channel: input.channel,
          highestSequence: verified.state.highestSequence,
          ...(verified.state.highestCatalogSha256 ? { highestCatalogSha256: verified.state.highestCatalogSha256 } : {}),
          cachedCatalog: verified.catalog,
          cachedCatalogSha256: digest,
          ...(response.headers.get('etag') ? { etag: response.headers.get('etag')! } : {}),
          sourceUrl: url,
          fetchedAt: timestamp,
          updatedAt: timestamp,
        });
        return {
          catalog: verified.catalog,
          source: 'network',
          stale: false,
          installAllowed: true,
          emergencyRollbackAuthorized: verified.usedEmergencyRollback,
          sourceUrl: url,
          ...(verified.usedEmergencyRollback ? { warning: 'Catalog used a verified emergency rollback authorization' } : {}),
        };
      } catch (error) {
        if (input.signal?.aborted) throw error;
        failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (state?.cachedCatalog) {
      return this.cachedResult(state, input.channel, failures.join('; '));
    }
    throw new KernelPackageError('catalog-unavailable', `Kernel catalog is unavailable: ${failures.join('; ')}`);
  }

  private cachedResult(
    state: NonNullable<Awaited<ReturnType<KernelPackageStateStore['getKernelCatalogState']>>>,
    channel: 'staging' | 'production',
    warning: string,
  ): KernelCatalogLoadResult {
    if (!state.cachedCatalog || !state.cachedCatalogSha256) {
      throw new KernelPackageError('catalog-unavailable', 'The local kernel catalog cache is incomplete');
    }
    const parsed = parseKernelCatalog(state.cachedCatalog);
    if (parsed.channel !== channel || catalogContentSha256(parsed) !== state.cachedCatalogSha256) {
      throw new KernelPackageError('catalog-invalid', 'The local kernel catalog cache failed its integrity check');
    }
    const stale = Date.parse(parsed.expiresAt) <= this.now().getTime();
    if (!stale) {
      verifyKernelCatalog(parsed, this.options.trustStore, {
        schemaVersion: 1,
        highestSequence: state.highestSequence,
        ...(state.highestCatalogSha256 ? { highestCatalogSha256: state.highestCatalogSha256 } : {}),
      }, this.now());
    }
    return {
      catalog: parsed,
      source: 'cache',
      stale,
      installAllowed: !stale,
      emergencyRollbackAuthorized: false,
      ...(state.sourceUrl ? { sourceUrl: state.sourceUrl } : {}),
      warning: stale
        ? `Cached catalog is expired and may only be used for display or repair: ${warning}`
        : warning,
    };
  }
}

export function resolveCompatibleArtifact(
  catalog: KernelCatalogEnvelopeV1,
  kernelId: KernelId,
  host: KernelHostCompatibility,
  now = new Date(),
): KernelArtifactDescriptorV1 {
  const candidates = catalog.artifacts.filter(artifact => artifact.kernelId === kernelId);
  if (candidates.length === 0) {
    throw incompatible(kernelId, ['kernel-not-found']);
  }
  const failures = new Set<KernelCompatibilityFailure>();
  const compatible = candidates.filter((artifact) => {
    const reasons = compatibilityFailures(artifact, host, now);
    for (const reason of reasons) failures.add(reason);
    return reasons.length === 0;
  });
  if (compatible.length === 0) throw incompatible(kernelId, [...failures]);
  return [...compatible].sort((left, right) => {
    const published = Date.parse(right.publishedAt) - Date.parse(left.publishedAt);
    if (published !== 0) return published;
    const patch = right.patchRevision - left.patchRevision;
    return patch !== 0 ? patch : right.artifactVersion.localeCompare(left.artifactVersion);
  })[0];
}

export function compatibilityFailures(
  artifact: KernelArtifactDescriptorV1,
  host: KernelHostCompatibility,
  now = new Date(),
): KernelCompatibilityFailure[] {
  const failures: KernelCompatibilityFailure[] = [];
  if (artifact.platform !== host.platform) failures.push('platform');
  if (artifact.arch !== host.arch) failures.push('architecture');
  if (!hostVersionInRange(host.hostVersion, artifact.minHostVersion, artifact.maxHostVersion)) failures.push('host-version');
  if (artifact.capabilityContractVersion !== host.capabilityContractVersion) failures.push('capability-contract');
  if (artifact.protocols.chat.name !== host.chatProtocol.name
    || !rangeContains(artifact.protocols.chat, host.chatProtocol.version)) failures.push('chat-protocol');
  if (artifact.protocols.control.name !== host.controlProtocol.name
    || !rangeContains(artifact.protocols.control, host.controlProtocol.version)) failures.push('control-protocol');
  if (artifact.protocols.conversationStore.name !== host.conversationStoreProtocol.name
    || !rangeContains(artifact.protocols.conversationStore, host.conversationStoreProtocol.version)) {
    failures.push('conversation-store-protocol');
  }
  if (!host.supportedNodeModuleAbis.includes(artifact.node.moduleAbi)) failures.push('node-module-abi');
  if (Date.parse(artifact.expiresAt) <= now.getTime()) failures.push('expired');
  return failures;
}

function rangeContains(range: { min: number; max: number }, value: number): boolean {
  return value >= range.min && value <= range.max;
}

function hostVersionInRange(hostValue: string, minValue: string, maxValue: string): boolean {
  const host = parseVersion(hostValue);
  const minimum = parseVersion(minValue);
  if (compareVersion(host, minimum) < 0) return false;
  const maxParts = maxValue.split(/[.-]/, 4);
  if (maxParts.includes('x')) {
    const major = parseInteger(maxParts[0], maxValue);
    const minor = parseInteger(maxParts[1], maxValue);
    return host[0] === major && host[1] === minor;
  }
  return compareVersion(host, parseVersion(maxValue)) <= 0;
}

function parseVersion(value: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value);
  if (!match) throw new Error(`Invalid host version: ${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function parseInteger(value: string | undefined, source: string): number {
  if (!value || !/^\d+$/.test(value)) throw new Error(`Invalid version range: ${source}`);
  return Number(value);
}

function compareVersion(left: [number, number, number], right: [number, number, number]): number {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function incompatible(kernelId: KernelId, failures: KernelCompatibilityFailure[]): KernelPackageError {
  return new KernelPackageError(
    'artifact-incompatible',
    `No compatible runtime artifact is available for ${kernelId}: ${[...new Set(failures)].join(', ')}`,
  );
}

function checkedHttpsUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error('Kernel catalog URLs must use credential-free HTTPS');
  }
  return url.toString();
}

function assertHttpsResponse(response: Response): void {
  if (response.url && new URL(response.url).protocol !== 'https:') {
    throw new Error('Kernel catalog redirect downgraded from HTTPS');
  }
}

async function readBoundedJson(response: Response, limit: number): Promise<unknown> {
  const advertised = Number(response.headers.get('content-length'));
  if (Number.isFinite(advertised) && advertised > limit) throw new Error('Kernel catalog exceeds the size limit');
  if (!response.body) throw new Error('Kernel catalog response has no body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error('Kernel catalog exceeds the size limit');
    }
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), total);
  return JSON.parse(bytes.toString('utf8')) as unknown;
}
