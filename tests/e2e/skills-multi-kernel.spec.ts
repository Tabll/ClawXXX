import {
  completeSetup,
  expect,
  getRecordedHostInvocations,
  installIpcMocks,
  test,
} from './fixtures/electron';

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item)).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(',')}}`;
}

const skill = {
  id: 'shared-skill',
  slug: 'shared-skill',
  displayName: 'Shared Skill',
  description: 'One canonical Skill for both kernels',
  version: '1.0.0',
  revision: 3,
  source: {
    kind: 'marketplace',
    locator: '/tmp/clawx/state/skill-packages/shared-skill/digest',
    digestSha256: 'a'.repeat(64),
  },
  installedForKernels: ['openclaw', 'deepseek-harness'],
  enabledForKernels: ['openclaw'],
  compatibility: [
    { kernelId: 'openclaw', compatible: true, mode: 'native' },
    {
      kernelId: 'deepseek-harness',
      compatible: true,
      mode: 'converted',
      reason: 'SKILL.md instruction conversion',
    },
  ],
  projections: [
    {
      kernelId: 'openclaw',
      state: 'ready',
      desiredVersion: 3,
      appliedVersion: 3,
      nativeId: 'shared-skill',
      updatedAt: '2026-08-24T00:00:00.000Z',
    },
    {
      kernelId: 'deepseek-harness',
      state: 'failed',
      desiredVersion: 3,
      error: { code: 'PROJECTION_ERROR', message: 'runtime was offline', retryable: true },
      updatedAt: '2026-08-24T00:00:00.000Z',
    },
  ],
  createdAt: '2026-08-24T00:00:00.000Z',
  updatedAt: '2026-08-24T00:00:00.000Z',
};

test.describe('canonical multi-kernel Skills UI', () => {
  test('shows independent status, sends target-scoped mutation, and retries one kernel', async ({ electronApp, page }) => {
    const mutation = {
      skillId: 'shared-skill',
      results: [{ kernelId: 'deepseek-harness', ok: true }],
    };
    await installIpcMocks(electronApp, {
      gatewayStatus: { state: 'running', port: 18789, pid: 12345, gatewayReady: true },
      hostApi: {
        [stableStringify(['skills', 'catalog', null])]: { success: true, skills: [skill] },
        [stableStringify(['skills', 'clawhubCapability', null])]: {
          success: true,
          capability: { canSearch: false, canInstall: false },
        },
        [stableStringify(['skills', 'mutate', {
          skillId: 'shared-skill',
          mutation: 'enable',
          target: 'deepseek-harness',
        }])]: mutation,
        [stableStringify(['skills', 'retry', {
          skillId: 'shared-skill',
          kernelId: 'deepseek-harness',
        }])]: mutation,
      },
      recordHostInvocations: true,
    });

    await completeSetup(page);
    await page.getByTestId('sidebar-nav-skills').click();
    await expect(page.getByTestId('skills-page')).toBeVisible();
    await expect(page.getByTestId('skill-projection-shared-skill-openclaw')).toContainText('Ready');
    await expect(page.getByTestId('skill-projection-shared-skill-deepseek-harness')).toContainText('Failed');

    await page.getByTestId('skills-target-deepseek-harness').click();
    await page.getByTestId('skill-toggle-shared-skill').click();
    await expect.poll(async () => (await getRecordedHostInvocations(electronApp)).some(call => (
      call.module === 'skills'
      && call.action === 'mutate'
      && JSON.stringify(call.payload) === JSON.stringify({
        skillId: 'shared-skill',
        mutation: 'enable',
        target: 'deepseek-harness',
      })
    ))).toBe(true);

    await page.getByTestId('skill-row-shared-skill').click();
    await expect(page.getByTestId('skill-kernel-status-openclaw')).toContainText('Ready');
    await expect(page.getByTestId('skill-kernel-status-deepseek-harness')).toContainText('runtime was offline');
    await page.getByTestId('skill-retry-deepseek-harness').click();
    await expect.poll(async () => (await getRecordedHostInvocations(electronApp)).some(call => (
      call.module === 'skills'
      && call.action === 'retry'
      && JSON.stringify(call.payload) === JSON.stringify({ skillId: 'shared-skill', kernelId: 'deepseek-harness' })
    ))).toBe(true);
  });
});
