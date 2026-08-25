import { completeSetup, expect, installIpcMocks, test } from './fixtures/electron';

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item)).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(',')}}`;
}

function canonicalSkill(input: {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  sourceKind?: 'bundled' | 'marketplace' | 'local';
}) {
  return {
    id: input.id,
    slug: input.id,
    displayName: input.name,
    description: input.description,
    version: '1.0.0',
    revision: 1,
    source: {
      kind: input.sourceKind ?? 'local',
      locator: `/tmp/.clawx/skill-packages/${input.id}`,
    },
    installedForKernels: ['openclaw'],
    enabledForKernels: input.enabled ? ['openclaw'] : [],
    compatibility: [{ kernelId: 'openclaw', compatible: true, mode: 'native' }],
    projections: [{
      kernelId: 'openclaw',
      state: 'ready',
      desiredVersion: 1,
      appliedVersion: 1,
      nativeId: input.id,
      updatedAt: '2026-08-24T00:00:00.000Z',
    }],
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
  };
}

function canonicalSkillsHostApi(skills: unknown[]) {
  return {
    [stableStringify(['skills', 'catalog', null])]: { success: true, skills },
    [stableStringify(['skills', 'clawhubCapability', null])]: {
      success: true,
      capability: { canSearch: false, canInstall: false },
    },
  };
}

test.describe('Skills page canonical availability', () => {
  test('shows canonical skills even when every runtime is stopped', async ({ electronApp, page }) => {
    await completeSetup(page);

    await installIpcMocks(electronApp, {
      gatewayStatus: { state: 'stopped', port: 18789 },
      hostApi: canonicalSkillsHostApi([
        canonicalSkill({ id: 'pdf', name: 'PDF', description: 'Local PDF tools', enabled: true }),
        canonicalSkill({ id: 'xlsx', name: 'XLSX', description: 'Local spreadsheet tools', enabled: false }),
      ]),
    });

    await page.getByTestId('sidebar-nav-skills').click();
    await expect(page.getByTestId('skills-page')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'PDF' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'XLSX' })).toBeVisible();
    await expect(page.getByTestId('skills-gateway-banner')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Install Skills/i })).toHaveCount(0);

    await page.getByTestId('skills-filter-enabled').click();
    await expect(page.getByRole('heading', { name: 'PDF' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'XLSX' })).toHaveCount(0);

    await page.getByTestId('skills-filter-disabled').click();
    await expect(page.getByRole('heading', { name: 'PDF' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'XLSX' })).toBeVisible();
  });

  test('hides uninstall for canonical local skills', async ({ electronApp, page }) => {
    await completeSetup(page);

    await installIpcMocks(electronApp, {
      gatewayStatus: { state: 'stopped', port: 18789 },
      hostApi: canonicalSkillsHostApi([
        canonicalSkill({
          id: 'browser-automation',
          name: 'Browser Automation',
          description: 'Local canonical skill',
          enabled: true,
          sourceKind: 'local',
        }),
      ]),
    });

    await page.getByTestId('sidebar-nav-skills').click();
    await expect(page.getByRole('heading', { name: 'Browser Automation' })).toBeVisible();
    await page.getByText('Browser Automation').click();
    await expect(page.getByRole('button', { name: /Uninstall|卸载|アンインストール|Удалить/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Disable|禁用|無効化|Выключить/i })).toBeVisible();
  });

  test('ignores global Gateway lifecycle changes after the canonical catalog loads', async ({ electronApp, page }) => {
    await completeSetup(page);

    await installIpcMocks(electronApp, {
      gatewayStatus: { state: 'stopped', port: 18789 },
      hostApi: canonicalSkillsHostApi([]),
    });

    await page.getByTestId('sidebar-nav-skills').click();
    await expect(page.getByTestId('skills-page')).toBeVisible();
    await expect(page.getByTestId('skills-gateway-banner')).toHaveCount(0);

    await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win?.webContents.send('gateway:status-changed', {
        state: 'running',
        port: 18789,
        pid: 12345,
        connectedAt: 1,
        gatewayReady: false,
      });
    });

    await expect(page.getByTestId('skills-page')).toBeVisible();
    await expect(page.getByTestId('skills-gateway-banner')).toHaveCount(0);
  });
});
