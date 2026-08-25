import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { KernelTrustStoreV1 } from '@shared/kernels/catalog';
import type { KernelHostCompatibility } from '@shared/kernels/package-manager';
import { parseKernelTrustStore } from '../catalog';

type DistributionDocument = {
  schemaVersion: 1;
  channel?: 'staging' | 'production';
  catalogUrls?: string[];
  mirrorBaseUrls?: string[];
};

export type KernelDistributionConfiguration = {
  channel: 'staging' | 'production';
  catalogUrls: string[];
  mirrorBaseUrls: string[];
  trustStore?: KernelTrustStoreV1;
  unavailableReason?: string;
};

export function loadKernelDistributionConfiguration(input: {
  packaged: boolean;
  resourcesPath: string;
  projectRoot?: string;
  environment?: NodeJS.ProcessEnv;
  now?: Date;
}): KernelDistributionConfiguration {
  const environment = input.environment ?? process.env;
  const resourceRoot = input.packaged
    ? join(input.resourcesPath, 'resources', 'kernels')
    : join(input.projectRoot ?? process.cwd(), 'resources', 'kernels');
  const distributionPath = environment.CLAWX_KERNEL_DISTRIBUTION_PATH?.trim()
    || join(resourceRoot, 'distribution.json');
  const document = readOptionalJson<DistributionDocument>(distributionPath);
  const channel = environment.CLAWX_KERNEL_CATALOG_CHANNEL === 'staging'
    ? 'staging'
    : document?.channel ?? 'production';
  const catalogUrls = commaList(environment.CLAWX_KERNEL_CATALOG_URLS)
    ?? sanitizeHttpsUrls(document?.catalogUrls);
  const mirrorBaseUrls = commaList(environment.CLAWX_KERNEL_MIRROR_URLS)
    ?? sanitizeHttpsUrls(document?.mirrorBaseUrls);
  const trustStorePath = environment.CLAWX_KERNEL_TRUST_STORE_PATH?.trim()
    || join(resourceRoot, 'trust', `roots.${channel}.json`);
  if (!existsSync(trustStorePath)) {
    return {
      channel,
      catalogUrls,
      mirrorBaseUrls,
      unavailableReason: `Kernel downloads are disabled because the ${channel} public trust store is not installed.`,
    };
  }
  try {
    const trustStore = parseKernelTrustStore(readJson(trustStorePath));
    assertReleaseTrustStore(trustStore, channel, input.now ?? new Date());
    if (catalogUrls.length === 0) throw new Error('No HTTPS kernel catalog URL is configured');
    return { channel, catalogUrls, mirrorBaseUrls, trustStore };
  } catch (error) {
    return {
      channel,
      catalogUrls,
      mirrorBaseUrls,
      unavailableReason: `Kernel downloads are disabled: ${safeError(error)}`,
    };
  }
}

export function createKernelHostCompatibility(input: {
  hostVersion: string;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  moduleAbi?: string;
}): KernelHostCompatibility {
  const currentAbi = Number.parseInt(input.moduleAbi ?? process.versions.modules, 10);
  return {
    hostVersion: input.hostVersion,
    platform: input.platform ?? process.platform,
    arch: input.arch ?? process.arch,
    capabilityContractVersion: 1,
    chatProtocol: { name: 'acp', version: 1 },
    controlProtocol: { name: 'clawx-kernel', version: 1 },
    conversationStoreProtocol: { name: 'clawx-conversation-store', version: 1 },
    supportedNodeModuleAbis: [...new Set([137, ...(Number.isSafeInteger(currentAbi) ? [currentAbi] : [])])],
  };
}

function assertReleaseTrustStore(
  store: KernelTrustStoreV1,
  channel: 'staging' | 'production',
  now: Date,
): void {
  const nowMs = now.getTime();
  const activeKeys = store.keys.filter(key => (
    Date.parse(key.notBefore) <= nowMs
    && Date.parse(key.notAfter) > nowMs
    && (!key.revokedAt || Date.parse(key.revokedAt) > nowMs)
  ));
  const purposes = new Set(activeKeys.flatMap(key => key.purposes));
  for (const purpose of ['artifact', 'catalog', 'rollback'] as const) {
    if (!purposes.has(purpose)) throw new Error(`Trust store has no active ${purpose} verification key`);
  }
  for (const key of store.keys) {
    if (channel === 'production' && /(?:dev|test|fixture|example)/i.test(key.keyId)) {
      throw new Error(`Production trust store contains a non-production key ID: ${key.keyId}`);
    }
  }
}

function readOptionalJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  return readJson(path) as T;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(resolve(path), 'utf8')) as unknown;
}

function commaList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return sanitizeHttpsUrls(value.split(','));
}

function sanitizeHttpsUrls(values: string[] | undefined): string[] {
  return (values ?? []).map(value => value.trim()).filter(value => {
    try {
      return new URL(value).protocol === 'https:';
    } catch {
      return false;
    }
  });
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
