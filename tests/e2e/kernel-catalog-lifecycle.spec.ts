import type { KernelCatalogSnapshot } from '../../shared/host-api/kernels';
import type { KernelId, KernelLifecycleState, KernelRuntimeSnapshot } from '../../shared/kernels/contracts';
import {
  closeElectronApp,
  emitKernelStatus,
  expect,
  getRecordedHostInvocations,
  getStableWindow,
  installIpcMocks,
  test,
} from './fixtures/electron';

const NOW = '2026-08-24T00:00:00.000Z';

function runtime(
  kernelId: KernelId,
  state: KernelLifecycleState,
  generation: number,
  artifactVersion?: string,
  autoStart = false,
): KernelRuntimeSnapshot {
  return {
    kernelId,
    state,
    generation,
    ...(artifactVersion ? { version: artifactVersion, artifactVersion } : {}),
    autoStart,
    diagnostics: [],
  };
}

function catalog(input: Array<{
  kernelId: KernelId;
  displayName: string;
  state: KernelLifecycleState;
  generation?: number;
  activeVersion?: string;
  availableVersion?: string;
  lastKnownGoodVersion?: string;
  updateAvailable?: boolean;
  autoStart?: boolean;
}>): KernelCatalogSnapshot {
  return {
    source: 'network',
    stale: false,
    refreshedAt: NOW,
    entries: input.map(item => ({
      kernelId: item.kernelId,
      displayName: item.displayName,
      description: `${item.displayName} runtime`,
      installation: {
        kernelId: item.kernelId,
        state: item.activeVersion ? 'installed' : 'not-installed',
        ...(item.activeVersion ? { activeVersion: item.activeVersion } : {}),
        ...(item.lastKnownGoodVersion ? { lastKnownGoodVersion: item.lastKnownGoodVersion } : {}),
        updatedAt: NOW,
      },
      runtime: runtime(
        item.kernelId,
        item.state,
        item.generation ?? 0,
        item.activeVersion,
        item.autoStart,
      ),
      ...(item.availableVersion ? { availableVersion: item.availableVersion } : {}),
      updateAvailable: item.updateAvailable ?? false,
      installAllowed: true,
      compatibilityFailures: [],
    })),
  };
}

const emptyCatalog = catalog([
  { kernelId: 'openclaw', displayName: 'OpenClaw', state: 'not-installed' },
  { kernelId: 'deepseek-harness', displayName: 'DeepSeek Harness', state: 'not-installed' },
]);

test.describe('optional kernel catalog and lifecycle', () => {
  test('supports a no-kernel first run by skipping each optional runtime', async ({ electronApp, page }) => {
    await installIpcMocks(electronApp, {
      kernelFixture: {
        catalog: emptyCatalog,
        runtimes: emptyCatalog.entries.map(entry => entry.runtime),
      },
    });

    await page.getByTestId('setup-next-button').click();
    await expect(page.getByTestId('setup-kernel-card-openclaw')).toBeVisible();
    await expect(page.getByTestId('setup-kernel-card-deepseek-harness')).toBeVisible();
    await page.getByTestId('setup-kernel-skip-openclaw').click();
    await page.getByTestId('setup-kernel-skip-deepseek-harness').click();
    await expect(page.getByTestId('setup-kernel-skip-openclaw')).toContainText('Include again');
    await expect(page.getByTestId('setup-kernel-skip-deepseek-harness')).toContainText('Include again');
    await page.getByTestId('setup-next-button').click();
    await expect(page.getByTestId('setup-complete-step')).toContainText('None yet');
    await page.getByTestId('setup-next-button').click();

    await expect(page.getByTestId('main-layout')).toBeVisible();
    await expect(page.getByTestId('sidebar-kernel-status-openclaw')).toContainText('Not installed');
    await expect(page.getByTestId('sidebar-kernel-status-deepseek-harness')).toContainText('Not installed');
  });

  test('installs one kernel, skips the other, and keeps failures kernel-scoped', async ({ electronApp, page }) => {
    const openClawInstalled = {
      installation: {
        kernelId: 'openclaw' as const,
        state: 'installed' as const,
        activeVersion: '2026.8.1-clawx.1',
        lastKnownGoodVersion: '2026.8.1-clawx.1',
        updatedAt: NOW,
      },
      runtime: runtime('openclaw', 'stopped', 1, '2026.8.1-clawx.1'),
    };
    await installIpcMocks(electronApp, {
      kernelFixture: {
        catalog: emptyCatalog,
        runtimes: emptyCatalog.entries.map(entry => entry.runtime),
        operations: {
          'install:openclaw': [{
            progress: [{
              kernelId: 'openclaw',
              artifactVersion: '2026.8.1-clawx.1',
              phase: 'downloading',
              receivedBytes: 50,
              totalBytes: 100,
              resumed: true,
            }],
            result: openClawInstalled,
          }],
          'install:deepseek-harness': [{ error: 'artifact signature verification failed' }],
        },
      },
      recordHostInvocations: true,
    });

    await page.getByTestId('setup-next-button').click();
    await page.getByTestId('setup-kernel-install-deepseek-harness').click();
    await expect(page.getByTestId('setup-kernel-card-deepseek-harness').getByRole('alert'))
      .toContainText('signature verification failed');
    await expect(page.getByTestId('setup-kernel-install-openclaw')).toBeEnabled();

    await page.getByTestId('setup-kernel-install-openclaw').click();
    await expect(page.getByTestId('setup-kernel-card-openclaw')).toContainText('Installed');
    await page.getByTestId('setup-kernel-skip-deepseek-harness').click();
    await page.getByTestId('setup-next-button').click();
    await expect(page.getByTestId('setup-complete-step')).toContainText('OpenClaw');

    const calls = await getRecordedHostInvocations(electronApp);
    expect(calls.filter(call => call.module === 'kernels' && call.action === 'install')).toEqual([
      { module: 'kernels', action: 'install', payload: { kernelId: 'deepseek-harness' } },
      { module: 'kernels', action: 'install', payload: { kernelId: 'openclaw' } },
    ]);
  });

  test('shows independent dual-runtime status and discovers a future catalog kernel', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      const page = await getStableWindow(app);
      const threeKernelCatalog = catalog([
        { kernelId: 'openclaw', displayName: 'OpenClaw', state: 'ready', generation: 2, activeVersion: '2026.8.1-clawx.1' },
        { kernelId: 'deepseek-harness', displayName: 'DeepSeek Harness', state: 'ready', generation: 4, activeVersion: '0.1.0-clawx.1' },
        { kernelId: 'future-kernel', displayName: 'Future Kernel', state: 'stopped', generation: 1, activeVersion: '1.0.0' },
      ]);
      await installIpcMocks(app, {
        kernelFixture: {
          catalog: threeKernelCatalog,
          runtimes: threeKernelCatalog.entries.map(entry => entry.runtime),
        },
      });
      await page.reload();

      await expect(page.getByTestId('sidebar-kernel-status-openclaw')).toContainText('Ready');
      await expect(page.getByTestId('sidebar-kernel-status-deepseek-harness')).toContainText('Ready');
      await expect(page.getByTestId('sidebar-kernel-status-future-kernel')).toContainText('Stopped');
      await expect(page.getByTestId('titlebar-kernel-status')).toContainText('2/3');

      await emitKernelStatus(app, runtime('openclaw', 'failed', 3, '2026.8.1-clawx.1'));
      await expect(page.getByTestId('sidebar-kernel-status-openclaw')).toContainText('Failed');
      await expect(page.getByTestId('sidebar-kernel-status-deepseek-harness')).toContainText('Ready');
      await expect(page.getByTestId('titlebar-kernel-status')).toContainText('1/3');
    } finally {
      await closeElectronApp(app);
    }
  });

  test('runs update, rollback, repair, process, directory, export, and uninstall actions', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      const page = await getStableWindow(app);
      const initialCatalog = catalog([
        {
          kernelId: 'openclaw',
          displayName: 'OpenClaw',
          state: 'ready',
          generation: 4,
          activeVersion: '2026.8.1-clawx.1',
          availableVersion: '2026.8.2-clawx.1',
          lastKnownGoodVersion: '2026.8.0-clawx.1',
          updateAvailable: true,
          autoStart: true,
        },
        { kernelId: 'deepseek-harness', displayName: 'DeepSeek Harness', state: 'ready', generation: 2, activeVersion: '0.1.0-clawx.1' },
      ]);
      const v2Installation = {
        kernelId: 'openclaw' as const,
        state: 'installed' as const,
        activeVersion: '2026.8.2-clawx.1',
        lastKnownGoodVersion: '2026.8.1-clawx.1',
        updatedAt: NOW,
      };
      const v1Installation = {
        ...v2Installation,
        activeVersion: '2026.8.1-clawx.1',
        lastKnownGoodVersion: '2026.8.0-clawx.1',
      };
      const notInstalled = {
        kernelId: 'openclaw' as const,
        state: 'not-installed' as const,
        updatedAt: NOW,
      };
      await installIpcMocks(app, {
        kernelFixture: {
          catalog: initialCatalog,
          runtimes: initialCatalog.entries.map(entry => entry.runtime),
          operations: {
            'update:openclaw': [{ result: { installation: v2Installation, runtime: runtime('openclaw', 'ready', 5, v2Installation.activeVersion, true) } }],
            'rollback:openclaw': [{ result: { installation: v1Installation, runtime: runtime('openclaw', 'ready', 6, v1Installation.activeVersion, true) } }],
            'repair:openclaw': [{ result: { installation: v1Installation, runtime: runtime('openclaw', 'ready', 7, v1Installation.activeVersion, true) } }],
            'stop:openclaw': [{ runtimes: [runtime('openclaw', 'stopped', 7, v1Installation.activeVersion, true), initialCatalog.entries[1]!.runtime], result: null }],
            'start:openclaw': [{ result: runtime('openclaw', 'ready', 8, v1Installation.activeVersion, true) }],
            'restart:openclaw': [{ result: runtime('openclaw', 'ready', 9, v1Installation.activeVersion, true) }],
            'setAutoStart:openclaw': [{ result: runtime('openclaw', 'ready', 9, v1Installation.activeVersion, false) }],
            'uninstall:openclaw': [{ result: {
              kernelId: 'openclaw',
              removedVersions: [v1Installation.activeVersion],
              deferredToTrash: [],
              canonicalDataPreserved: true,
              installation: notInstalled,
              runtime: runtime('openclaw', 'not-installed', 0),
            } }],
          },
        },
        recordHostInvocations: true,
      });
      await page.reload();
      await page.getByTestId('sidebar-kernel-status').click();
      await expect(page.getByTestId('settings-kernels-section')).toBeVisible();
      const card = page.getByTestId('settings-kernel-openclaw');

      await page.getByTestId('settings-kernel-update-openclaw').click();
      await expect(card).toContainText('2026.8.2-clawx.1');
      await page.getByTestId('settings-kernel-rollback-openclaw').click();
      await expect(card).toContainText('2026.8.1-clawx.1');
      await page.getByTestId('settings-kernel-repair-openclaw').click();
      await page.getByTestId('settings-kernel-stop-openclaw').click();
      await expect(card).toContainText('Stopped');
      await page.getByTestId('settings-kernel-start-openclaw').click();
      await expect(card).toContainText('Ready');
      await page.getByTestId('settings-kernel-restart-openclaw').click();
      await page.getByTestId('settings-kernel-autostart-openclaw').click();
      await page.getByTestId('settings-kernel-data-openclaw').click();
      await page.getByTestId('settings-kernel-logs-openclaw').click();
      await page.getByTestId('settings-kernel-export-openclaw').click();
      await page.getByTestId('settings-kernel-uninstall-openclaw').click();
      await page.getByTestId('confirm-dialog-confirm-button').click();
      await expect(page.getByTestId('settings-kernel-install-openclaw')).toBeVisible();
      await expect(page.getByTestId('settings-kernel-deepseek-harness')).toContainText('Ready');

      const actions = (await getRecordedHostInvocations(app))
        .filter(call => call.module === 'kernels')
        .map(call => call.action);
      for (const action of [
        'update', 'rollback', 'repair', 'stop', 'start', 'restart', 'setAutoStart',
        'openDirectory', 'exportLogs', 'uninstall',
      ]) {
        expect(actions, `missing kernels.${action}`).toContain(action);
      }
      expect(actions.filter(action => action === 'openDirectory')).toHaveLength(2);
    } finally {
      await closeElectronApp(app);
    }
  });
});
