import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { completeSetup, expect, test } from './fixtures/electron';

const TEST_AGENT_ID = 'agent';
const ZERO_TOKEN_SESSION_ID = 'agent-session-zero-token';
const NONZERO_TOKEN_SESSION_ID = 'agent-session-nonzero-token';
const GATEWAY_INJECTED_SESSION_ID = 'agent-session-gateway-injected';
const DELIVERY_MIRROR_SESSION_ID = 'agent-session-delivery-mirror';
const MULTI_TURN_SESSION_ID = 'agent-session-multi-turn';

async function seedTokenUsageTranscripts(homeDir: string): Promise<void> {
  const sessionDir = join(homeDir, '.openclaw', 'agents', TEST_AGENT_ID, 'sessions');
  const now = new Date();
  const zeroTimestamp = new Date(now.getTime() - 20_000).toISOString();
  const nonzeroTimestamp = now.toISOString();
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, `${ZERO_TOKEN_SESSION_ID}.jsonl`),
    [
      JSON.stringify({
        type: 'message',
        timestamp: zeroTimestamp,
        message: {
          role: 'assistant',
          model: 'kimi-k2.6',
          provider: 'kimi',
          usage: {
            total_tokens: 0,
            input_tokens: 0,
            output_tokens: 0,
          },
        },
      }),
      '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    join(sessionDir, `${NONZERO_TOKEN_SESSION_ID}.jsonl`),
    [
      JSON.stringify({
        type: 'message',
        timestamp: nonzeroTimestamp,
        message: {
          role: 'assistant',
          model: 'kimi-k2.6',
          provider: 'kimi',
          usage: {
            total_tokens: 27,
            input_tokens: 20,
            output_tokens: 7,
          },
        },
      }),
      '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    join(sessionDir, `${GATEWAY_INJECTED_SESSION_ID}.jsonl`),
    [
      JSON.stringify({
        type: 'message',
        timestamp: new Date(now.getTime() - 10_000).toISOString(),
        message: {
          role: 'assistant',
          model: 'gateway-injected',
          usage: {
            total_tokens: 0,
            input_tokens: 0,
            output_tokens: 0,
          },
        },
      }),
      '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    join(sessionDir, `${DELIVERY_MIRROR_SESSION_ID}.jsonl`),
    [
      JSON.stringify({
        type: 'message',
        timestamp: new Date(now.getTime() - 5_000).toISOString(),
        message: {
          role: 'assistant',
          model: 'delivery-mirror',
          usage: {
            total_tokens: 0,
            input_tokens: 0,
            output_tokens: 0,
          },
        },
      }),
      '',
    ].join('\n'),
    'utf8',
  );
}

async function seedMultiTurnTokenUsageTranscript(homeDir: string): Promise<void> {
  const sessionDir = join(homeDir, '.openclaw', 'agents', TEST_AGENT_ID, 'sessions');
  const now = new Date();
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, 'sessions.json'),
    JSON.stringify({
      'agent:multi-turn': {
        label: 'Multi-turn usage review',
        sessionId: MULTI_TURN_SESSION_ID,
        channel: 'cli',
        chatType: 'direct',
        status: 'done',
        runtimeMs: 45000,
        usageFamilySessionIds: [MULTI_TURN_SESSION_ID, `${MULTI_TURN_SESSION_ID}-reset`],
        systemPromptReport: {
          systemPrompt: {
            chars: 12000,
            projectContextChars: 4000,
            nonProjectContextChars: 8000,
          },
          skills: {
            promptChars: 4000,
            entries: [
              { name: 'skill-a', blockChars: 2400 },
            ],
          },
          tools: {
            listChars: 500,
            schemaChars: 1500,
            entries: [
              { name: 'tool-a', summaryChars: 100, schemaChars: 900 },
            ],
          },
          injectedWorkspaceFiles: [
            { name: 'AGENTS.md', injectedChars: 1000 },
          ],
        },
      },
    }, null, 2),
    'utf8',
  );
  await writeFile(
    join(sessionDir, `${MULTI_TURN_SESSION_ID}.jsonl`),
    [
      JSON.stringify({
        type: 'message',
        timestamp: new Date(now.getTime() - 60_000).toISOString(),
        message: {
          role: 'user',
          content: 'Please inspect token usage.',
        },
      }),
      JSON.stringify({
        type: 'message',
        timestamp: new Date(now.getTime() - 45_000).toISOString(),
        message: {
          role: 'assistant',
          model: 'kimi-k2.6',
          provider: 'kimi',
          content: '[Tool: shell]\nFirst assistant response for the multi-turn usage session.',
          usage: {
            total_tokens: 18,
            input_tokens: 12,
            output_tokens: 6,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            cost: {
              input: 0.0008,
              output: 0.001,
              total: 0.0018,
            },
          },
        },
      }),
      JSON.stringify({
        type: 'message',
        timestamp: now.toISOString(),
        message: {
          role: 'assistant',
          model: 'kimi-k2.6',
          provider: 'kimi',
          content: 'Second assistant response for the multi-turn usage session.',
          usage: {
            total_tokens: 32,
            input_tokens: 20,
            output_tokens: 12,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            cost: {
              input: 0.0014,
              output: 0.0018,
              total: 0.0032,
            },
          },
        },
      }),
      '',
    ].join('\n'),
    'utf8',
  );
}

test.describe('ClawX token usage history', () => {

  async function validateUsageHistory(
    page: Page,
    expectedSessionIds = [ZERO_TOKEN_SESSION_ID, NONZERO_TOKEN_SESSION_ID],
  ): Promise<void> {
    const usageHistory = await page.evaluate(async () => {
      return window.electron.ipcRenderer.invoke('usage:recentTokenHistory', 20);
    });
    if (!Array.isArray(usageHistory) || usageHistory.length === 0) {
      throw new Error('No usage history found in IPC usage:recentTokenHistory');
    }

    const hasSeededEntries = usageHistory.some((entry) =>
      typeof entry?.sessionId === 'string' && expectedSessionIds.includes(entry.sessionId),
    );
    if (!hasSeededEntries) {
      throw new Error('Seeded transcript session IDs were not found in IPC usage history');
    }
  }

  test('displays assistant usage for agent directory with zero and non-zero tokens', async ({ page, homeDir }) => {
    await seedTokenUsageTranscripts(homeDir);
    await completeSetup(page);
    await validateUsageHistory(page);

    const usageHistory = await page.evaluate(async () => {
      return window.electron.ipcRenderer.invoke('usage:recentTokenHistory', 20);
    });

    const zeroEntry = usageHistory.find((entry) => entry?.sessionId === ZERO_TOKEN_SESSION_ID);
    const nonzeroEntry = usageHistory.find((entry) => entry?.sessionId === NONZERO_TOKEN_SESSION_ID);
    expect(zeroEntry).toBeTruthy();
    expect(nonzeroEntry).toBeTruthy();
    expect(nonzeroEntry?.totalTokens).toBe(27);
    expect(zeroEntry?.totalTokens).toBe(0);
    expect(zeroEntry?.agentId).toBe(TEST_AGENT_ID);
    expect(nonzeroEntry?.agentId).toBe(TEST_AGENT_ID);
    expect(zeroEntry?.provider).toBe('kimi');
    expect(nonzeroEntry?.provider).toBe('kimi');
  });

  test('hides gateway internal usage rows from the usage list overview', async ({ page, homeDir }) => {
    await seedTokenUsageTranscripts(homeDir);
    await completeSetup(page);
    await validateUsageHistory(page);

    await page.getByTestId('sidebar-nav-models').click();
    await expect(page.getByTestId('models-page')).toBeVisible();
    await expect(page.getByTestId('settings-token-usage-section')).toBeVisible();

    const usageEntryRows = page.getByTestId('token-usage-entry');
    await expect.poll(async () => await usageEntryRows.count()).toBe(2);

    await page.getByTestId('token-usage-trend-hotspot').first().hover();
    const trendTooltip = page.getByTestId('token-usage-trend-tooltip');
    await expect(trendTooltip).toBeVisible();
    await expect(trendTooltip).toContainText('Total tokens');
    await expect(trendTooltip).toContainText('Input');

    await expect(page.locator('[data-testid="token-usage-entry"]', { hasText: GATEWAY_INJECTED_SESSION_ID })).toHaveCount(0);
    await expect(page.locator('[data-testid="token-usage-entry"]', { hasText: DELIVERY_MIRROR_SESSION_ID })).toHaveCount(0);
  });

  test('aggregates recent usage by session and opens the full detail dialog', async ({ page, homeDir }) => {
    await seedMultiTurnTokenUsageTranscript(homeDir);
    await completeSetup(page);
    await validateUsageHistory(page, [MULTI_TURN_SESSION_ID]);

    await page.getByTestId('sidebar-nav-models').click();
    await expect(page.getByTestId('models-page')).toBeVisible();
    await expect(page.getByTestId('settings-token-usage-section')).toBeVisible();

    const groupBar = page.getByTestId('token-usage-group-bar').first();
    await expect(groupBar).toBeVisible();
    const groupBarStyle = await groupBar.evaluate((element) => element.getAttribute('style') ?? '');
    expect(groupBarStyle).toContain('--usage-input');
    expect(groupBarStyle).not.toContain('--usage-output');
    expect(groupBarStyle).not.toContain('--usage-cache');

    await page.getByTestId('token-usage-search').fill(MULTI_TURN_SESSION_ID);

    const usageEntryRows = page.getByTestId('token-usage-entry');
    await expect.poll(async () => await usageEntryRows.count()).toBe(1);
    await expect(usageEntryRows.first()).toContainText(MULTI_TURN_SESSION_ID);
    await expect(usageEntryRows.first()).toContainText('50');

    await page.getByTestId('token-usage-session-details').click();
    const dialog = page.getByTestId('token-usage-session-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(MULTI_TURN_SESSION_ID);
    await expect(dialog).toContainText('50');
    await expect(dialog.getByTestId('token-usage-call-row')).toHaveCount(2);
    await expect(dialog).toContainText('Session overview');
    await expect(dialog).toContainText('Multi-turn usage review');
    await expect(dialog).toContainText('Tool calls');
    await expect(dialog).toContainText('shell');
    await expect(dialog.getByTestId('token-usage-context-pie')).toBeVisible();
    await expect(dialog.getByTestId('token-usage-context-breakdown')).toContainText('System prompt');
    await expect(dialog.getByTestId('token-usage-context-breakdown')).toContainText('skill-a');
    await expect(dialog.getByTestId('token-usage-context-breakdown')).toContainText('tool-a');
    await expect(dialog.getByTestId('token-usage-context-breakdown')).toContainText('AGENTS.md');
    await expect(dialog).toContainText('Cost breakdown');
    const breakdownBars = dialog.getByTestId('token-usage-breakdown-bar');
    await expect(breakdownBars).toHaveCount(2);
    const breakdownBarStyles = await breakdownBars.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('style') ?? ''),
    );
    for (const style of breakdownBarStyles) {
      expect(style).toContain('--usage-input');
      expect(style).not.toContain('--usage-output');
      expect(style).not.toContain('--usage-cache');
    }
    await expect(dialog).toContainText('Content');
    await expect(dialog).toContainText('First assistant response');
    await expect(dialog).toContainText('Second assistant response');
  });
});
