// @vitest-environment node
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { resolveManagedKernelRuntime } from '@electron/kernels/managed-runtime-selection';
import { resolveDeepSeekHarnessRuntimeLocation } from '@electron/kernels/deepseek-harness/runtime-location';
import { resolveOpenClawRuntimeLocation } from '@electron/kernels/openclaw/runtime-location';
import type { KernelInstallationRecord } from '@shared/kernels/package-manager';

const installed: KernelInstallationRecord = {
  kernelId: 'deepseek-harness', state: 'installed', activeVersion: '1.0.0', updatedAt: '2026-09-11T00:00:00Z',
};

describe('managed runtime selection', () => {
  it.each([false, true])('prefers installed artifacts (packaged=%s)', async packaged => {
    const resolveDevelopment = vi.fn(() => 'development-override');
    const resolveInstalled = vi.fn(() => 'verified-artifact');
    await expect(resolveManagedKernelRuntime({
      packaged, getInstallation: async () => installed, resolveInstalled, resolveDevelopment,
    })).resolves.toBe('verified-artifact');
    expect(resolveInstalled).toHaveBeenCalledWith(installed);
    expect(resolveDevelopment).not.toHaveBeenCalled();
  });

  it.each([undefined, { ...installed, state: 'not-installed' as const, activeVersion: undefined }])(
    'permits development fallback only without an installed package (%s)', async installation => {
      const resolveDevelopment = vi.fn(() => 'development');
      const options = { getInstallation: async () => installation, resolveInstalled: vi.fn(), resolveDevelopment };
      expect(await resolveManagedKernelRuntime({ ...options, packaged: false })).toBe('development');
      expect(await resolveManagedKernelRuntime({ ...options, packaged: true })).toBeUndefined();
      expect(resolveDevelopment).toHaveBeenCalledTimes(1);
      expect(options.resolveInstalled).not.toHaveBeenCalled();
    },
  );

  it.each(['installed', 'error', 'downloading'] as const)('never falls back after failed %s admission', async state => {
    const resolveDevelopment = vi.fn(() => 'unsafe-fallback');
    await expect(resolveManagedKernelRuntime({
      packaged: false, getInstallation: async () => ({ ...installed, state }),
      resolveInstalled: () => { throw new Error('invalid installation'); }, resolveDevelopment,
    })).rejects.toThrow('invalid installation');
    expect(resolveDevelopment).not.toHaveBeenCalled();
  });

  it.each(['openclaw', 'deepseek-harness'] as const)('uses %s artifact Node/entrypoints in development on every platform', async kernelId => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      // Admission metadata fixture: signature/extraction is tested by the real package-manager suite.
      const manifest = {
        kernelId, artifactVersion: '1.0.0',
        entrypoints: { chat: 'runtime/kernel/openclaw.mjs', host: 'runtime/kernel/lib/bin.js' },
        supplyChain: { fileManifestSha256: 'a'.repeat(64) },
      } as KernelInstallationRecord['manifest'];
      const installation = { ...installed, kernelId, manifest };
      const packageRoot = resolve('test artifacts', 'kernels');
      const userDataRoot = resolve('test artifacts', 'user-data');
      const input = { installation, packageRoot, userDataRoot, platform, requireFiles: false };
      const runtime = await resolveManagedKernelRuntime({
        packaged: false, getInstallation: async () => installation,
        resolveInstalled: () => kernelId === 'openclaw'
          ? resolveOpenClawRuntimeLocation(input) : resolveDeepSeekHarnessRuntimeLocation(input),
        resolveDevelopment: () => { throw new Error('must not read a dev override'); },
      });
      const root = join(packageRoot, kernelId, 'installs', '1.0.0');
      expect(runtime?.source).toBe('installed-artifact');
      expect(runtime?.nodeExecutable).toBe(join(root, 'runtime', 'node', platform === 'win32' ? 'node.exe' : 'bin/node'));
      expect(runtime?.entryPath).toBe(join(root, kernelId === 'openclaw'
        ? 'runtime/kernel/openclaw.mjs' : 'runtime/kernel/lib/bin.js'));
    }
  });

  it('propagates missing installed files instead of using a development package', async () => {
    const resolveDevelopment = vi.fn();
    const installation = {
      ...installed,
      manifest: {
        kernelId: installed.kernelId, artifactVersion: installed.activeVersion,
        entrypoints: { host: 'runtime/kernel/lib/bin.js' },
      } as KernelInstallationRecord['manifest'],
    };
    await expect(resolveManagedKernelRuntime({
      packaged: false, getInstallation: async () => installation,
      resolveInstalled: installation => resolveDeepSeekHarnessRuntimeLocation({
        installation, packageRoot: resolve('missing'), userDataRoot: resolve('missing'),
      }), resolveDevelopment,
    })).rejects.toThrow('host entrypoint is missing');
    expect(resolveDevelopment).not.toHaveBeenCalled();
  });
});
