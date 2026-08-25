import { existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { KernelInstallationRecord } from '@shared/kernels/package-manager';
import { KernelPackageLayout } from '../package-manager/layout';

export type DeepSeekHarnessRuntimeLocation = {
  readonly kernelId: 'deepseek-harness';
  readonly artifactVersion: string;
  /** SHA-256 of the verified runtime file manifest bound to this launch. */
  readonly capabilitiesDigest: string;
  readonly installRoot: string;
  readonly packageDir: string;
  readonly entryPath: string;
  readonly nodeExecutable: string;
  readonly dataRoot: string;
  readonly configRoot: string;
  readonly cacheRoot: string;
  readonly source: 'installed-artifact' | 'development-deploy';
};

function inside(root: string, candidate: string, label: string): string {
  const base = resolve(root);
  const target = resolve(candidate);
  const rel = relative(base, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${label} escapes the verified DeepSeek Harness artifact`);
  }
  return target;
}

function dataRoots(userDataRoot: string) {
  return {
    dataRoot: resolve(userDataRoot, 'kernel-config', 'deepseek-harness'),
    configRoot: resolve(userDataRoot, 'kernel-config', 'deepseek-harness', 'config'),
    cacheRoot: resolve(userDataRoot, 'kernel-cache', 'deepseek-harness'),
  };
}

export function resolveDeepSeekHarnessRuntimeLocation(input: {
  installation: KernelInstallationRecord;
  packageRoot: string;
  userDataRoot: string;
  platform?: NodeJS.Platform;
  requireFiles?: boolean;
}): DeepSeekHarnessRuntimeLocation {
  const { installation } = input;
  if (
    installation.kernelId !== 'deepseek-harness'
    || installation.state !== 'installed'
    || !installation.activeVersion
    || !installation.manifest
  ) throw new Error('DeepSeek Harness does not have an active verified installation');
  if (
    installation.manifest.kernelId !== 'deepseek-harness'
    || installation.manifest.artifactVersion !== installation.activeVersion
  ) throw new Error('DeepSeek Harness installation pointer and manifest identity disagree');
  const installRoot = new KernelPackageLayout(input.packageRoot).installPath(installation.manifest);
  const hostEntrypoint = installation.manifest.entrypoints.host;
  if (!hostEntrypoint) throw new Error('DeepSeek Harness artifact has no runtime host entrypoint');
  const entryPath = inside(installRoot, join(installRoot, hostEntrypoint), 'DeepSeek Harness host entrypoint');
  const packageDir = inside(installRoot, join(installRoot, 'runtime', 'kernel'), 'DeepSeek Harness package root');
  const nodeExecutable = inside(
    installRoot,
    join(installRoot, 'runtime', 'node', (input.platform ?? process.platform) === 'win32' ? 'node.exe' : join('bin', 'node')),
    'DeepSeek Harness Node runtime',
  );
  if (input.requireFiles !== false) {
    if (!existsSync(entryPath)) throw new Error(`DeepSeek Harness host entrypoint is missing: ${entryPath}`);
    if (!existsSync(nodeExecutable)) throw new Error(`DeepSeek Harness Node runtime is missing: ${nodeExecutable}`);
  }
  return {
    kernelId: 'deepseek-harness',
    artifactVersion: installation.activeVersion,
    capabilitiesDigest: installation.manifest.supplyChain.fileManifestSha256,
    installRoot,
    packageDir,
    entryPath,
    nodeExecutable,
    ...dataRoots(input.userDataRoot),
    source: 'installed-artifact',
  };
}

export function createDevelopmentDeepSeekHarnessRuntimeLocation(input: {
  packageDir: string;
  userDataRoot: string;
  artifactVersion?: string;
  capabilitiesDigest?: string;
  nodeExecutable?: string;
}): DeepSeekHarnessRuntimeLocation {
  const packageDir = resolve(input.packageDir);
  const entryPath = join(packageDir, 'lib', 'bin.js');
  if (!existsSync(entryPath)) throw new Error(`Development DeepSeek Harness host is missing: ${entryPath}`);
  return {
    kernelId: 'deepseek-harness',
    artifactVersion: input.artifactVersion ?? 'development',
    capabilitiesDigest: input.capabilitiesDigest ?? 'development-unverified',
    installRoot: packageDir,
    packageDir,
    entryPath,
    nodeExecutable: input.nodeExecutable ?? process.execPath,
    ...dataRoots(input.userDataRoot),
    source: 'development-deploy',
  };
}

export function buildDeepSeekHarnessEnvironment(
  location: DeepSeekHarnessRuntimeLocation,
  generation: number,
): NodeJS.ProcessEnv {
  return {
    CLAWX_KERNEL_ID: location.kernelId,
    CLAWX_KERNEL_GENERATION: String(generation),
    CLAWX_KERNEL_ARTIFACT_VERSION: location.artifactVersion,
    CLAWX_KERNEL_CAPABILITIES_DIGEST: location.capabilitiesDigest,
    CLAWX_KERNEL_DATA_DIR: location.dataRoot,
    CLAWX_KERNEL_CONFIG_DIR: location.configRoot,
    CLAWX_KERNEL_CACHE_DIR: location.cacheRoot,
    CLAWX_CONVERSATION_STORE_PROTOCOL: 'clawx.conversation-store/v1',
    CLAWX_DISABLE_NATIVE_HISTORY: '1',
    CLAWX_DISABLE_NATIVE_SCHEDULER: '1',
    DSH_DISABLE_NATIVE_SCHEDULER: '1',
    DSH_HOME: location.configRoot,
    NODE_NO_WARNINGS: '1',
  };
}
