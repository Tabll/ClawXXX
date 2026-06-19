import { closeElectronApp, expect, getStableWindow, installIpcMocks, test } from './fixtures/electron';

const SESSION_KEY = 'agent:main:main';

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);
  return `{${entries.join(',')}}`;
}

const seededHistory = [
  { role: 'user', content: 'Show the context controls.', timestamp: 1000 },
  { role: 'assistant', content: 'Context controls are ready.', timestamp: 1001 },
];

test.describe('ClawX chat context compaction', () => {
  test('shows context usage details and compacts through the Gateway RPC', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installIpcMocks(app, {
        gatewayStatus: { state: 'running', port: 18789, pid: 12345 },
        gatewayRpc: {
          [stableStringify(['sessions.list', {}])]: {
            success: true,
            result: {
              defaults: { contextTokens: 100000 },
              sessions: [{
                key: SESSION_KEY,
                displayName: 'main',
                totalTokens: 90000,
                totalTokensFresh: true,
                contextTokens: 100000,
              }],
            },
          },
          [stableStringify(['chat.history', { sessionKey: SESSION_KEY, limit: 200, maxChars: 500000 }])]: {
            success: true,
            result: { messages: seededHistory },
          },
          [stableStringify(['chat.history', { sessionKey: SESSION_KEY, limit: 1000, maxChars: 500000 }])]: {
            success: true,
            result: { messages: seededHistory },
          },
        },
        hostApi: {
          [stableStringify(['/api/gateway/status', 'GET'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: { state: 'running', port: 18789, pid: 12345 },
            },
          },
          [stableStringify(['/api/agents', 'GET'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: {
                success: true,
                agents: [{ id: 'main', name: 'main', modelDisplay: 'gpt-5.5' }],
              },
            },
          },
        },
      });

      await app.evaluate(async () => {
        const { ipcMain } = process.mainModule!.require('electron') as typeof import('electron');
        ipcMain.removeHandler('gateway:rpc');
        ipcMain.handle('gateway:rpc', async (_event, method: string, params: { key?: string } | null) => {
          if (method !== 'sessions.compact') return {};
          await new Promise((resolve) => setTimeout(resolve, 300));
          return {
            success: true,
            result: {
              ok: true,
              key: params?.key,
              compacted: true,
              result: {
                tokensBefore: 90000,
                tokensAfter: 12000,
              },
            },
          };
        });
      });

      const page = await getStableWindow(app);
      await page.setViewportSize({ width: 1400, height: 900 });
      try {
        await page.reload();
      } catch (error) {
        if (!String(error).includes('ERR_FILE_NOT_FOUND')) {
          throw error;
        }
      }

      await expect(page.getByTestId('main-layout')).toBeVisible();
      await expect(page.getByText('Context controls are ready.')).toBeVisible({ timeout: 30_000 });

      const usageRing = page.getByTestId('chat-context-usage-ring');
      await expect(usageRing).toBeVisible();
      await expect(usageRing).toHaveAttribute('aria-label', /90%/);

      await usageRing.hover();
      const usageCard = page.getByTestId('chat-context-usage-card');
      await expect(usageCard).toBeVisible();
      await expect(usageCard).toContainText('Context');
      await expect(usageCard).toContainText('90%');
      await expect(usageCard).toContainText('90,000 tokens');
      await expect(usageCard).toContainText('100,000 tokens');

      await page.getByTestId('chat-context-compact-button').click();
      const status = page.getByTestId('chat-context-compaction-status');
      await expect(status).toContainText('Compacting context...', { timeout: 1_000 });
      await expect(status).toContainText('Context compacted', { timeout: 5_000 });
    } finally {
      await closeElectronApp(app);
    }
  });
});
