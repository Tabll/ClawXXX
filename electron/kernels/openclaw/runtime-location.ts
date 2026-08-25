import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { KernelInstallationRecord } from '@shared/kernels/package-manager';
import { KernelPackageLayout } from '../package-manager/layout';

export type OpenClawRuntimeLocation = {
  readonly kernelId: 'openclaw';
  readonly artifactVersion: string;
  /** Immutable verified artifact root selected by DataService. */
  readonly installRoot: string;
  /** OpenClaw package directory inside the artifact. */
  readonly packageDir: string;
  readonly entryPath: string;
  readonly nodeExecutable: string;
  /** Private, ClawX-managed state. Never aliases the legacy ~/.openclaw tree. */
  readonly stateRoot: string;
  readonly configRoot: string;
  readonly cacheRoot: string;
  readonly tempRoot: string;
  readonly managed: true;
  readonly source: 'installed-artifact' | 'development-dependency';
};

export type ResolveOpenClawRuntimeLocationInput = {
  installation: KernelInstallationRecord;
  packageRoot: string;
  userDataRoot: string;
  platform?: NodeJS.Platform;
  requireFiles?: boolean;
};

let activeLocation: OpenClawRuntimeLocation | undefined;
let channelHandoffEndpoint: Readonly<{ url: string; token: string }> | undefined;

function inside(root: string, candidate: string, label: string): string {
  const base = resolve(root);
  const target = resolve(candidate);
  const rel = relative(base, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${label} escapes the verified OpenClaw artifact: ${target}`);
  }
  return target;
}

function runtimeDataRoots(userDataRoot: string): Pick<
  OpenClawRuntimeLocation,
  'stateRoot' | 'configRoot' | 'cacheRoot' | 'tempRoot'
> {
  const stateRoot = resolve(userDataRoot, 'kernel-config', 'openclaw');
  const cacheRoot = resolve(userDataRoot, 'kernel-cache', 'openclaw');
  return {
    stateRoot,
    configRoot: stateRoot,
    cacheRoot,
    tempRoot: join(cacheRoot, 'tmp'),
  };
}

export function resolveOpenClawRuntimeLocation(
  input: ResolveOpenClawRuntimeLocationInput,
): OpenClawRuntimeLocation {
  const { installation } = input;
  if (
    installation.kernelId !== 'openclaw'
    || installation.state !== 'installed'
    || !installation.activeVersion
    || !installation.manifest
  ) {
    throw new Error('OpenClaw does not have an active verified installation');
  }
  if (
    installation.manifest.kernelId !== 'openclaw'
    || installation.manifest.artifactVersion !== installation.activeVersion
  ) {
    throw new Error('OpenClaw installation pointer and manifest identity disagree');
  }

  const layout = new KernelPackageLayout(input.packageRoot);
  const installRoot = layout.installPath(installation.manifest);
  const entryPath = inside(
    installRoot,
    join(installRoot, installation.manifest.entrypoints.chat),
    'OpenClaw chat entrypoint',
  );
  const packageDir = inside(installRoot, join(installRoot, 'runtime', 'kernel'), 'OpenClaw package directory');
  const nodeExecutable = inside(
    installRoot,
    join(
      installRoot,
      'runtime',
      'node',
      (input.platform ?? process.platform) === 'win32' ? 'node.exe' : join('bin', 'node'),
    ),
    'OpenClaw Node runtime',
  );
  if (input.requireFiles !== false) {
    for (const [label, path] of [['entrypoint', entryPath], ['Node runtime', nodeExecutable]] as const) {
      if (!existsSync(path)) throw new Error(`OpenClaw ${label} is missing from active artifact: ${path}`);
    }
  }

  return {
    kernelId: 'openclaw',
    artifactVersion: installation.activeVersion,
    installRoot,
    packageDir,
    entryPath,
    nodeExecutable,
    ...runtimeDataRoots(input.userDataRoot),
    managed: true,
    source: 'installed-artifact',
  };
}

/** Development remains explicit and never becomes a packaged fallback. */
export function createDevelopmentOpenClawRuntimeLocation(input: {
  packageDir: string;
  userDataRoot: string;
  artifactVersion: string;
  nodeExecutable?: string;
}): OpenClawRuntimeLocation {
  const packageDir = resolve(input.packageDir);
  const entryPath = join(packageDir, 'openclaw.mjs');
  if (!existsSync(entryPath)) throw new Error(`Development OpenClaw entrypoint is missing: ${entryPath}`);
  return {
    kernelId: 'openclaw',
    artifactVersion: input.artifactVersion,
    installRoot: packageDir,
    packageDir,
    entryPath,
    nodeExecutable: input.nodeExecutable ?? process.execPath,
    ...runtimeDataRoots(input.userDataRoot),
    managed: true,
    source: 'development-dependency',
  };
}

export function configureOpenClawRuntimeLocation(location: OpenClawRuntimeLocation): void {
  if (location.kernelId !== 'openclaw' || !location.managed) {
    throw new Error('Only a managed OpenClaw runtime location can be configured');
  }
  activeLocation = Object.freeze({ ...location });
}

export function clearOpenClawRuntimeLocation(): void {
  activeLocation = undefined;
}

export function configureOpenClawChannelHandoffEndpoint(endpoint: { url: string; token: string }): void {
  const url = endpoint.url.trim();
  const token = endpoint.token.trim();
  if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(url) || !token) {
    throw new Error('OpenClaw Channel handoff must use an authenticated loopback endpoint');
  }
  channelHandoffEndpoint = Object.freeze({ url, token });
}

export function clearOpenClawChannelHandoffEndpoint(): void {
  channelHandoffEndpoint = undefined;
}

export function getOpenClawRuntimeLocation(): OpenClawRuntimeLocation | undefined {
  return activeLocation;
}

export function requireOpenClawRuntimeLocation(): OpenClawRuntimeLocation {
  if (!activeLocation) throw new Error('OpenClaw runtime is not installed or activated');
  return activeLocation;
}

export function getManagedOpenClawDataRoots(userDataRoot: string): ReturnType<typeof runtimeDataRoots> {
  return runtimeDataRoots(userDataRoot);
}

export function ensureManagedOpenClawDataRoots(location = requireOpenClawRuntimeLocation()): void {
  for (const directory of [location.stateRoot, location.configRoot, location.cacheRoot, location.tempRoot]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
}

export function buildManagedOpenClawEnvironment(
  location = requireOpenClawRuntimeLocation(),
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...base,
    CLAWX_MANAGED_RUNTIME: '1',
    CLAWX_CONVERSATION_STORE_PROTOCOL: 'clawx.conversation-store/v1',
    OPENCLAW_STATE_DIR: location.configRoot,
    OPENCLAW_CONFIG_PATH: join(location.configRoot, 'openclaw.json'),
    OPENCLAW_CACHE_DIR: location.cacheRoot,
    XDG_CACHE_HOME: location.cacheRoot,
    OPENCLAW_HISTORY_MODE: 'clawx-data-service',
    OPENCLAW_DISABLE_NATIVE_HISTORY: '1',
    OPENCLAW_DISABLE_CRON_HISTORY: '1',
    OPENCLAW_SKIP_CRON: '1',
    CLAWX_DISABLE_NATIVE_SCHEDULER: '1',
    OPENCLAW_DISABLE_TRANSCRIPT_USAGE_SCAN: '1',
    OPENCLAW_TRAJECTORY_ENABLED: '0',
    OPENCLAW_NO_RESPAWN: '1',
    OPENCLAW_EMBEDDED_IN: 'ClawX',
    OPENCLAW_EXEC_SHELL_SNAPSHOT: '0',
    ...(channelHandoffEndpoint ? {
      CLAWX_CHANNEL_HANDOFF_URL: channelHandoffEndpoint.url,
      CLAWX_CHANNEL_HANDOFF_TOKEN: channelHandoffEndpoint.token,
    } : {}),
    TMPDIR: location.tempRoot,
    TMP: location.tempRoot,
    TEMP: location.tempRoot,
  };
}

export function resolveOpenClawPackageRealPath(location = requireOpenClawRuntimeLocation()): string {
  try {
    return realpathSync(location.packageDir);
  } catch {
    return location.packageDir;
  }
}
