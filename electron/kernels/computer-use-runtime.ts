import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ComputerNativeHost } from '../services/computer-use';

export type ComputerRuntime = { key: string; binaryPath: string; sdkRoot: string };
export async function resolveComputerRuntime(input: {
  location?: { packageDir: string; source: string };
  developmentRoot?: string;
  platform?: NodeJS.Platform;
  arch?: string;
}): Promise<ComputerRuntime | undefined> {
  if (!input.location) return undefined;
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  const root = input.location.source === 'installed-artifact'
    ? join(input.location.packageDir, 'tools/cua')
    : input.developmentRoot ? join(input.developmentRoot, 'build/host-tools', `${platform}-${arch}`, 'tools/cua') : undefined;
  if (!root) return undefined;
  try {
    const physical = await realpath(root);
    const metadata = JSON.parse(await readFile(join(physical, 'package.json'), 'utf8'));
    if (metadata.name !== '@clawx/cua-tool' || metadata.version !== '0.25.0') return undefined;
    const sdkRoot = await realpath(join(physical, 'node_modules/@trycua/cua-driver'));
    const sdk = JSON.parse(await readFile(join(sdkRoot, 'package.json'), 'utf8'));
    if (sdk.name !== '@trycua/cua-driver' || sdk.version !== '0.25.0') return undefined;
    const binaryPath = await realpath(join(physical, platform === 'win32' ? 'cua-driver.exe' : 'cua-driver'));
    for (const path of [binaryPath, sdkRoot, await realpath(join(sdkRoot, 'dist/index.js')), await realpath(join(sdkRoot, 'dist/electron.js'))]) {
      const rel = relative(physical, path);
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
    }
    if (!(await stat(binaryPath)).isFile()) return undefined;
    return { key: physical, binaryPath, sdkRoot };
  } catch { return undefined; }
}

export async function createComputerNativeHost(runtime: ComputerRuntime): Promise<ComputerNativeHost> {
  const sdk: typeof import('@trycua/cua-driver') = await import(/* @vite-ignore */ pathToFileURL(join(runtime.sdkRoot, 'dist/index.js')).href);
  const host = sdk.EmbeddedCuaDriverHost.withOptions(sdk.EmbeddedDriverHostOptions.new({
    binaryPath: runtime.binaryPath, hostBundleId: 'app.clawx.desktop',
    permissionMode: sdk.EmbeddedPermissionMode.Unrestricted,
    // Main approves every exposed action before it reaches this private SDK.
    dangerouslyBypassApprovals: true, approveCapabilityManifest: false,
    approveSessionPolicy: false, inheritStderr: false,
    environment: [{ name: 'CUA_DRIVER_RS_TELEMETRY_ENABLED', value: 'false' }],
  }));
  let client: Awaited<ReturnType<typeof sdk.CuaDriver.connect>> | undefined;
  let generation: string | undefined;
  return {
    async start() {
      const connection = await host.start();
      generation = connection.generation;
      if (connection.driverVersion !== '0.25.0') throw new Error('Unreviewed CUA driver');
      client = sdk.CuaDriver.connect(connection.socketPath);
      return client;
    },
    waitForExit: () => host.waitForExit(generation!),
    async stop() {
      try { await host.stop(); } finally {
        (client as typeof client & { uniffiDestroy?(): void })?.uniffiDestroy?.();
        (host as typeof host & { uniffiDestroy?(): void }).uniffiDestroy?.();
      }
    },
  };
}

/** Called only by the explicit Settings permission action, never by a model. */
export async function requestComputerPermissions(runtime: ComputerRuntime): Promise<void> {
  const sdk: typeof import('@trycua/cua-driver/electron') = await import(/* @vite-ignore */ pathToFileURL(join(runtime.sdkRoot, 'dist/electron.js')).href);
  const status = sdk.requestMacOSPermissions();
  if (!sdk.hasRequiredMacOSPermissions(status)) await sdk.openMacOSScreenRecordingSettings();
}
