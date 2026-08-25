import type { ElectronApplication } from '@playwright/test';
import type { KernelRuntimeSnapshot } from '../../shared/kernels/contracts';
import {
  closeElectronApp,
  expect,
  getRecordedHostInvocations,
  getStableWindow,
  installIpcMocks,
  test,
  type KernelHostFixtureConfig,
} from './fixtures/electron';

const WORKSPACE = '/channels-health-workspace';

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);
  return `{${entries.join(',')}}`;
}

function runtime(kernelId: string, state: KernelRuntimeSnapshot['state']): KernelRuntimeSnapshot {
  return {
    kernelId,
    state,
    generation: state === 'ready' ? 2 : 1,
    artifactVersion: kernelId === 'openclaw' ? '2026.8.1-clawx.1' : '0.1.0-clawx.1',
    diagnostics: state === 'ready' ? [] : ['runtime probe timed out'],
  };
}

function kernelFixture(
  openClawState: KernelRuntimeSnapshot['state'],
  deepSeekState: KernelRuntimeSnapshot['state'] = 'ready',
): KernelHostFixtureConfig {
  const openclaw = runtime('openclaw', openClawState);
  const deepseek = runtime('deepseek-harness', deepSeekState);
  const readyOpenClaw = runtime('openclaw', 'ready');
  return {
    catalog: {
      source: 'network',
      stale: false,
      refreshedAt: '2026-08-24T00:00:00.000Z',
      entries: [openclaw, deepseek].map(snapshot => ({
        kernelId: snapshot.kernelId,
        displayName: snapshot.kernelId === 'openclaw' ? 'OpenClaw' : 'DeepSeek Harness',
        installation: {
          kernelId: snapshot.kernelId,
          state: 'installed' as const,
          activeVersion: snapshot.artifactVersion,
          updatedAt: '2026-08-24T00:00:00.000Z',
        },
        runtime: snapshot,
        updateAvailable: false,
        installAllowed: true,
        compatibilityFailures: [],
      })),
    },
    runtimes: [openclaw, deepseek],
    operations: {
      'restart:openclaw': [{ result: readyOpenClaw }],
    },
  };
}

async function openChannels(
  app: ElectronApplication,
  fixture: KernelHostFixtureConfig,
  accountKernelIds: string[],
) {
  const channels = accountKernelIds.map((kernelId, index) => ({
    channelType: index === 0 ? 'telegram' : 'discord',
    defaultAccountId: 'default',
    status: 'connected' as const,
    accounts: [{
      accountId: 'default',
      name: index === 0 ? 'Telegram' : 'Discord',
      configured: true,
      status: 'connected' as const,
      isDefault: true,
      kernelId,
      agentId: 'main',
      supportedKernels: ['openclaw', 'deepseek-harness'],
    }],
  }));
  const accountsResult = {
    success: true,
    channels,
    adapters: [
      { kernelId: 'openclaw', supportedChannels: ['telegram', 'discord'] },
      { kernelId: 'deepseek-harness', supportedChannels: ['telegram', 'discord'] },
    ],
  };
  await installIpcMocks(app, {
    kernelFixture: fixture,
    recordHostInvocations: true,
    hostApi: {
      [stableStringify(['settings', 'getAll', null])]: {
        language: 'en', setupComplete: true, chatWorkspacePath: WORKSPACE, recentWorkspacePaths: [WORKSPACE],
      },
      [stableStringify(['channels', 'accounts', { mode: 'config', probe: false }])]: accountsResult,
      [stableStringify(['channels', 'accounts', { mode: 'runtime', probe: false }])]: accountsResult,
      [stableStringify(['channels', 'accounts', { mode: 'runtime', probe: true }])]: accountsResult,
      [stableStringify(['agents', 'list', null])]: {
        success: true,
        agents: [{ id: 'main', name: 'Main', supportedKernels: ['openclaw', 'deepseek-harness'] }],
      },
    },
  });

  const page = await getStableWindow(app);
  try {
    await page.reload();
  } catch (error) {
    if (!String(error).includes('ERR_FILE_NOT_FOUND')) throw error;
  }
  await expect(page.getByTestId('main-layout')).toBeVisible();
  await page.getByTestId('sidebar-nav-channels').click();
  await expect(page.getByTestId('channels-page')).toBeVisible();
  return page;
}

test.describe('Channels kernel health diagnostics', () => {
  test('does not show a stale health banner while both account kernels are ready', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      const page = await openChannels(app, kernelFixture('ready'), ['openclaw', 'deepseek-harness']);
      await expect(page.getByTestId('channels-kernel-health-banner')).toHaveCount(0);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('scopes an unavailable account warning and restart action to its owning kernel', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      const page = await openChannels(app, kernelFixture('error'), ['openclaw', 'deepseek-harness']);
      await expect(page.getByTestId('channels-kernel-health-banner')).toBeVisible();
      await expect(page.getByTestId('channels-kernel-health-openclaw')).toContainText('OpenClaw');
      await expect(page.getByTestId('channels-kernel-health-deepseek-harness')).toHaveCount(0);

      await page.getByTestId('channels-restart-kernel-openclaw').click();
      await expect(page.getByTestId('channels-kernel-health-banner')).toHaveCount(0);
      await expect.poll(async () => (await getRecordedHostInvocations(app)).some(call => (
        call.module === 'kernels'
        && call.action === 'restart'
        && call.payload?.kernelId === 'openclaw'
      ))).toBe(true);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('shows a verifying state through the same kernel-neutral health surface', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      const page = await openChannels(app, kernelFixture('starting'), ['openclaw']);
      await expect(page.getByTestId('channels-kernel-health-banner')).toBeVisible();
      await expect(page.getByTestId('channels-kernel-health-openclaw')).toContainText(/OpenClaw.*Starting/i);
      await expect(page.getByTestId('channels-restart-kernel-openclaw')).toBeVisible();
    } finally {
      await closeElectronApp(app);
    }
  });
});
