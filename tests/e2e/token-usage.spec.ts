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
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);
  return `{${entries.join(',')}}`;
}

test.describe('canonical multi-kernel token usage Dashboard', () => {
  test('shows both kernels, filters independently, and keeps missing values unknown', async ({
    electronApp,
    page,
  }) => {
    const now = new Date().toISOString();
    await installIpcMocks(electronApp, {
      hostApi: {
        [stableStringify(['usage', 'recentTokenHistory', { limit: undefined }])]: [
          {
            id: 'usage-openclaw-1',
            eventKey: 'provider-call-openclaw-1',
            runId: 'run-openclaw-1',
            kernelId: 'openclaw',
            requestId: 'request-openclaw-1',
            source: 'provider-response',
            timestamp: now,
            sessionId: 'openclaw-usage-session',
            agentId: 'openclaw-agent',
            model: 'openclaw-model',
            provider: 'openclaw-provider',
            usageStatus: 'available',
            inputTokens: 20,
            outputTokens: 7,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 27,
            cost: 0.004,
            currency: 'USD',
            costUsd: 0.004,
          },
          {
            id: 'usage-dsh-unknown',
            eventKey: 'session-event-dsh-unknown',
            runId: 'run-dsh-unknown',
            kernelId: 'deepseek-harness',
            source: 'runtime-event',
            timestamp: now,
            sessionId: 'dsh-unknown-usage-session',
            agentId: 'dsh-agent',
            model: 'dsh-model',
            provider: 'deepseek',
            usageStatus: 'missing',
          },
        ],
      },
      recordHostInvocations: true,
    });

    await completeSetup(page);
    await page.getByTestId('sidebar-nav-models').click();
    await expect(page.getByTestId('models-page')).toBeVisible();
    await expect(page.getByTestId('settings-token-usage-section')).toBeVisible();
    await expect(page.getByTestId('token-usage-cost-semantics')).toContainText('reported');

    const rows = page.getByTestId('token-usage-entry');
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: 'openclaw-usage-session' })).toHaveCount(1);
    const unknownRow = rows.filter({ hasText: 'dsh-unknown-usage-session' });
    await expect(unknownRow).toHaveCount(1);
    await expect(unknownRow.getByTestId('token-usage-session-total')).toHaveText('Unknown');
    await expect(unknownRow.getByTestId('token-usage-session-cost')).toContainText('Unknown');

    await page.getByTestId('token-usage-kernel-openclaw').click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('openclaw-usage-session');
    await expect(rows.first()).not.toContainText('dsh-unknown-usage-session');

    await page.getByTestId('token-usage-kernel-deepseek-harness').click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('dsh-unknown-usage-session');
    await expect(rows.first().getByTestId('token-usage-session-total')).toHaveText('Unknown');

    await page.getByTestId('token-usage-kernel-all').click();
    await expect(rows).toHaveCount(2);
    await expect.poll(async () => (await getRecordedHostInvocations(electronApp)).some(call => (
      call.module === 'usage' && call.action === 'recentTokenHistory'
    ))).toBe(true);
  });
});
