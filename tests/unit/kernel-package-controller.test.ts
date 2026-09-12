// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { KernelPackageController, type KernelPackageControllerOptions } from '@electron/kernels/package-manager/controller';
import { createKernelHostCompatibility } from '@electron/kernels/package-manager/config';
import type { KernelPackageManager } from '@electron/kernels/package-manager';
import type { KernelPackageStateStore } from '@electron/kernels/package-manager/state';
import { KernelSupervisorRegistry } from '@electron/kernels/supervisor-registry';
import type { KernelInstallationRecord } from '@shared/kernels/package-manager';

const installation: KernelInstallationRecord = {
  kernelId: 'deepseek-harness', state: 'installed', activeVersion: '1.0.0', updatedAt: '2026-09-11T00:00:00Z',
};

function fixture(onActivated?: KernelPackageControllerOptions['onActivated']) {
  const manager = {
    installFromCatalog: vi.fn(async () => ({ installation, activated: true })),
    repair: vi.fn(async () => ({ installation, activated: true })),
    rollback: vi.fn(async () => installation),
    uninstall: vi.fn(async () => ({ kernelId: installation.kernelId, canonicalDataPreserved: true })),
  };
  const state = {
    getKernelCatalogState: vi.fn(async () => undefined),
    getKernelInstallation: vi.fn(async () => installation),
    listKernelInstallations: vi.fn(async () => [installation]),
  };
  const supervisors = new KernelSupervisorRegistry(() => { throw new Error('driver missing'); });
  const onChanged = vi.fn();
  const controller = new KernelPackageController({
    manager: manager as unknown as KernelPackageManager,
    state: state as unknown as KernelPackageStateStore,
    supervisors, host: createKernelHostCompatibility({ hostVersion: '0.6.0' }),
    catalogUrls: ['https://catalog.example.test/catalog.json'], onChanged, onActivated,
  });
  return { controller, manager, state, supervisors, onChanged };
}

describe('package-to-host activation', () => {
  it.each(['install', 'update', 'repair', 'rollback'] as const)('awaits host registration after %s', async action => {
    const onActivated = vi.fn(async () => ({ restartRequired: false }));
    const f = fixture(onActivated);
    await expect(f.controller[action]('deepseek-harness')).resolves.toMatchObject({
      installation, runtime: { state: 'installed' }, restartRequired: false,
    });
    expect(onActivated).toHaveBeenCalledWith('deepseek-harness', installation);
    expect(f.onChanged).toHaveBeenCalledTimes(1);
  });

  it('keeps downloaded-but-inactive versions distinct from an app restart requirement', async () => {
    const onActivated = vi.fn();
    const f = fixture(onActivated);
    f.manager.installFromCatalog.mockResolvedValue({
      installation: { ...installation, desiredVersion: '2.0.0' }, activated: false,
    });
    const result = await f.controller.update('deepseek-harness');
    expect(result.installation).toMatchObject({ activeVersion: '1.0.0', desiredVersion: '2.0.0' });
    expect(result.restartRequired).toBe(false);
    expect(onActivated).not.toHaveBeenCalled();
  });

  it('refreshes catalog consumers even when post-commit registration fails', async () => {
    const f = fixture(async () => { throw new Error('registration failed'); });
    await expect(f.controller.install('deepseek-harness')).rejects.toThrow('registration failed');
    expect(f.onChanged).toHaveBeenCalledTimes(1);
    expect((await f.controller.catalog()).entries.find(entry => entry.kernelId === 'deepseek-harness')?.installation)
      .toMatchObject(installation);
  });

  it('serializes same-kernel package mutations through registration, while other kernels continue', async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const f = fixture(async kernelId => {
      if (kernelId === 'deepseek-harness') { entered(); await gate; }
    });
    const install = f.controller.install('deepseek-harness');
    await started;
    const uninstall = f.controller.uninstall('deepseek-harness');
    try {
      await f.controller.install('openclaw');
      expect(f.manager.uninstall).not.toHaveBeenCalled();
      release();
      await Promise.all([install, uninstall]);
      expect(f.manager.uninstall).toHaveBeenCalledOnce();
    } finally { release(); await Promise.allSettled([install, uninstall]); }
  });
});
