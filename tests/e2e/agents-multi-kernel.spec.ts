import {
  completeSetup,
  expect,
  getRecordedHostInvocations,
  installIpcMocks,
  test,
} from './fixtures/electron';

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);
  return `{${entries.join(',')}}`;
}

const writer = {
  id: 'writer',
  name: 'Writer',
  description: 'Shared across both runtimes',
  persona: 'Be precise.',
  presetId: 'research',
  modelDisplay: 'deepseek-chat',
  modelRef: 'deepseek/deepseek-chat',
  overrideModelRef: 'deepseek/deepseek-chat',
  inheritedModel: false,
  workspace: 'file:///tmp/clawx-writer',
  agentDir: '',
  mainSessionKey: 'agent:writer:main',
  channelTypes: ['feishu'],
  supportedKernels: ['openclaw', 'deepseek-harness'],
  defaultForKernels: ['openclaw'],
  projections: [
    {
      kernelId: 'openclaw',
      status: 'ready',
      desiredVersion: 3,
      appliedVersion: 3,
      nativeId: 'oc-writer',
      updatedAt: '2026-08-24T00:00:00.000Z',
    },
    {
      kernelId: 'deepseek-harness',
      status: 'failed',
      desiredVersion: 3,
      nativeId: 'dsh-writer',
      error: 'runtime was offline',
      updatedAt: '2026-08-24T00:00:00.000Z',
    },
  ],
  version: 3,
};

const snapshot = {
  success: true,
  agents: [writer],
  kernelDefaults: [{
    kernelId: 'openclaw',
    agentId: 'writer',
    updatedAt: '2026-08-24T00:00:00.000Z',
  }],
  defaultModelRef: null,
  configuredChannelTypes: ['feishu'],
  channelOwners: { feishu: 'writer' },
  channelAccountOwners: { 'feishu:default': 'writer' },
};

test.describe('canonical multi-kernel Agents UI', () => {
  test('shows independent projections and sends kernel-scoped mutations', async ({ electronApp, page }) => {
    const createPayload = {
      name: 'Research Agent',
      inheritWorkspace: false,
      kernelIds: ['openclaw', 'deepseek-harness'],
      workspaceUri: 'file:///tmp/clawx-research',
      description: 'Research and synthesis',
      persona: 'Use primary sources.',
      presetId: 'research',
      modelRef: undefined,
    };
    const createdSnapshot = {
      ...snapshot,
      agents: [...snapshot.agents, {
        ...writer,
        id: 'research-agent',
        name: 'Research Agent',
        workspace: 'file:///tmp/clawx-research',
        defaultForKernels: [],
      }],
    };
    await installIpcMocks(electronApp, {
      gatewayStatus: { state: 'running', port: 18789, pid: 12345, gatewayReady: true },
      hostApi: {
        [stableStringify(['agents', 'list', null])]: snapshot,
        [stableStringify(['agents', 'setDefault', { id: 'writer', kernelId: 'deepseek-harness' }])]: snapshot,
        [stableStringify(['agents', 'reconcile', { id: 'writer', kernelIds: ['deepseek-harness'] }])]: snapshot,
        [stableStringify(['agents', 'create', createPayload])]: createdSnapshot,
        [stableStringify(['channels', 'accounts', null])]: { success: true, channels: [] },
        [stableStringify(['providers', 'accounts', null])]: [],
        [stableStringify(['providers', 'accountKeyInfo', null])]: [],
        [stableStringify(['providers', 'vendors', null])]: [],
        [stableStringify(['providers', 'getDefaultAccount', null])]: { accountId: null },
        [stableStringify(['providers', 'kernelDefaults', null])]: [],
      },
      recordHostInvocations: true,
    });

    await completeSetup(page);
    await page.getByTestId('sidebar-nav-agents').click();
    await expect(page.getByTestId('agents-page')).toBeVisible();
    await expect(page.getByText('OpenClaw default')).toBeVisible();
    await expect(page.getByTestId('agent-projection-writer-openclaw')).toContainText('Ready');
    await expect(page.getByTestId('agent-projection-writer-deepseek-harness')).toContainText('Failed');

    await page.getByTitle('Settings').click();
    const deepSeekRow = page.getByTestId('agent-kernel-row-deepseek-harness');
    await expect(deepSeekRow).toContainText('dsh-writer');
    await expect(deepSeekRow).toContainText('runtime was offline');
    await deepSeekRow.getByRole('button', { name: 'Make default' }).click();
    await deepSeekRow.getByRole('button', { name: 'Retry projection' }).click();

    await expect.poll(async () => (await getRecordedHostInvocations(electronApp)).filter(call => (
      call.module === 'agents' && (call.action === 'setDefault' || call.action === 'reconcile')
    ))).toEqual([
      { module: 'agents', action: 'setDefault', payload: { id: 'writer', kernelId: 'deepseek-harness' } },
      { module: 'agents', action: 'reconcile', payload: { id: 'writer', kernelIds: ['deepseek-harness'] } },
    ]);

    await page.keyboard.press('Escape');
    await page.getByTestId('agents-add-button').click();
    await expect(page.getByTestId('agent-create-kernel-openclaw')).toBeChecked();
    await expect(page.getByTestId('agent-create-kernel-deepseek-harness')).toBeChecked();
    await page.getByLabel('Agent Name').fill('Research Agent');
    await page.getByLabel('Description').fill('Research and synthesis');
    await page.getByLabel('Workspace URI').fill('file:///tmp/clawx-research');
    await page.getByLabel('Persona').fill('Use primary sources.');
    await page.getByLabel('Harness preset (optional)').fill('research');
    await page.getByTestId('add-agent-dialog').getByRole('button', { name: 'Save' }).click();
    await expect(page.getByTestId('add-agent-dialog')).toHaveCount(0);

    await expect.poll(async () => (await getRecordedHostInvocations(electronApp)).find(call => (
      call.module === 'agents' && call.action === 'create'
    ))).toEqual(expect.objectContaining({
      module: 'agents',
      action: 'create',
      payload: expect.objectContaining({
        name: 'Research Agent',
        kernelIds: ['openclaw', 'deepseek-harness'],
        workspaceUri: 'file:///tmp/clawx-research',
        persona: 'Use primary sources.',
        presetId: 'research',
      }),
    }));
  });
});
