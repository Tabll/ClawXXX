import { completeSetup, expect, installIpcMocks, test } from './fixtures/electron';

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);
  return `{${entries.join(',')}}`;
}

const agents = {
  agents: [
    {
      id: 'openclaw-agent',
      name: 'OpenClaw Agent',
      modelDisplay: 'Default',
      inheritedModel: true,
      workspace: '/tmp/openclaw-agent',
      agentDir: '/tmp/openclaw-agent/agent',
      mainSessionKey: 'agent:openclaw-agent:main',
      channelTypes: [],
      supportedKernels: ['openclaw'],
      defaultForKernels: ['openclaw'],
      projections: [],
      version: 1,
    },
    {
      id: 'dsh-agent',
      name: 'DSH Agent',
      modelDisplay: 'Default',
      inheritedModel: true,
      workspace: '/tmp/dsh-agent',
      agentDir: '/tmp/dsh-agent/agent',
      mainSessionKey: 'agent:dsh-agent:main',
      channelTypes: [],
      supportedKernels: ['deepseek-harness'],
      defaultForKernels: ['deepseek-harness'],
      projections: [],
      version: 1,
    },
  ],
  kernelDefaults: [
    { kernelId: 'openclaw', agentId: 'openclaw-agent', updatedAt: '2026-08-24T00:00:00.000Z' },
    { kernelId: 'deepseek-harness', agentId: 'dsh-agent', updatedAt: '2026-08-24T00:00:00.000Z' },
  ],
  configuredChannelTypes: [],
  channelOwners: {},
  channelAccountOwners: {},
};

test.describe('canonical multi-kernel Cron UI', () => {
  test('stays available without a ready OpenClaw runtime and scopes agent/policy fields to the selected kernel', async ({
    electronApp,
    page,
  }) => {
    await installIpcMocks(electronApp, {
      gatewayStatus: { state: 'stopped', port: 18789, gatewayReady: false },
      hostApi: {
        [stableStringify(['cron', 'list', null])]: [],
        [stableStringify(['agents', 'list', null])]: agents,
        [stableStringify(['channels', 'accounts', null])]: { success: true, channels: [] },
        [stableStringify(['kernels', 'list', null])]: [
          { kernelId: 'openclaw', state: 'stopped', generation: 2, diagnostics: [] },
          { kernelId: 'deepseek-harness', state: 'ready', generation: 4, diagnostics: [] },
        ],
      },
    });

    await completeSetup(page);
    await page.getByTestId('sidebar-nav-cron').click();
    await expect(page.getByTestId('cron-page')).toBeVisible();
    await expect(page.getByTestId('cron-new-task-button')).toBeEnabled();
    await expect(page.getByText(/Gateway is not running/i)).toHaveCount(0);

    await page.getByTestId('cron-new-task-button').click();
    const kernel = page.getByTestId('cron-kernel-select');
    const agent = page.getByTestId('cron-agent-select');
    await expect(kernel).toHaveValue('deepseek-harness');
    await expect(agent.locator('option')).toHaveText(['DSH Agent']);

    await kernel.selectOption('openclaw');
    await expect(agent).toHaveValue('openclaw-agent');
    await expect(agent.locator('option')).toHaveText(['OpenClaw Agent']);

    await kernel.selectOption('deepseek-harness');
    await expect(agent).toHaveValue('dsh-agent');

    await page.getByTestId('cron-conversation-policy-select').selectOption('new-per-day');
    await page.getByTestId('cron-overlap-policy-select').selectOption('replace');
    await page.getByTestId('cron-misfire-policy-select').selectOption('catch-up');
    await page.getByTestId('cron-timeout-input').fill('90');
    await page.getByTestId('cron-timezone-input').fill('Asia/Shanghai');

    await expect(page.getByTestId('cron-conversation-policy-select')).toHaveValue('new-per-day');
    await expect(page.getByTestId('cron-overlap-policy-select')).toHaveValue('replace');
    await expect(page.getByTestId('cron-misfire-policy-select')).toHaveValue('catch-up');
    await expect(page.getByTestId('cron-timeout-input')).toHaveValue('90');
    await expect(page.getByTestId('cron-timezone-input')).toHaveValue('Asia/Shanghai');
  });
});
