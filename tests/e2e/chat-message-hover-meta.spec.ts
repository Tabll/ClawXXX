import { closeElectronApp, expect, getStableWindow, installIpcMocks, test } from './fixtures/electron';

const SESSION_KEY = 'agent:main:main';
const ASSISTANT_TIMESTAMP = new Date(2026, 5, 15, 16, 13, 0).getTime();

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);
  return `{${entries.join(',')}}`;
}

const seededHistory = [
  {
    role: 'user',
    content: [{ type: 'text', text: 'Show message footer metadata.' }],
    timestamp: ASSISTANT_TIMESTAMP - 60_000,
  },
  {
    role: 'assistant',
    content: [{ type: 'text', text: 'Here is the answer with usage metadata.' }],
    timestamp: ASSISTANT_TIMESTAMP,
    provider: 'openai',
    model: 'gpt-5.5',
    usage: {
      input_tokens: 120,
      output_tokens: 30,
      cache_read_tokens: 10,
      cache_write_tokens: 5,
    },
  },
];

test.describe('ClawX chat message hover metadata', () => {
  test('shows full timestamp, icon usage, and model details on assistant hover', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installIpcMocks(app, {
        gatewayStatus: { state: 'running', port: 18789, pid: 12345 },
        gatewayRpc: {
          [stableStringify(['sessions.list', {}])]: {
            success: true,
            result: {
              sessions: [{ key: SESSION_KEY, displayName: 'main' }],
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

      const page = await getStableWindow(app);
      try {
        await page.reload();
      } catch (error) {
        if (!String(error).includes('ERR_FILE_NOT_FOUND')) {
          throw error;
        }
      }

      await expect(page.getByTestId('main-layout')).toBeVisible();
      await expect(page.getByText('Here is the answer with usage metadata.')).toBeVisible({ timeout: 30_000 });

      const message = page.getByTestId('chat-message-1');
      const hoverBar = message.getByTestId('chat-message-hover-bar');
      const timestamp = message.getByTestId('chat-message-timestamp');
      const meta = message.getByTestId('chat-message-meta');
      const writeMeta = meta.getByTestId('chat-message-meta-write');

      await expect(timestamp).toContainText('2026年6月15日 16:13:00');
      await expect(meta.getByTestId('chat-message-meta-model')).toContainText('openai/gpt-5.5');
      await expect(writeMeta).toContainText('30');
      await expect(meta.getByTestId('chat-message-meta-read')).toContainText('120');
      await expect(meta.getByTestId('chat-message-meta-cache-read')).toContainText('10');
      await expect(meta.getByTestId('chat-message-meta-cache-write')).toContainText('5');
      await expect(writeMeta).toHaveAttribute('aria-label', /30/);
      await expect(meta.getByTestId('chat-message-meta-read')).toHaveAttribute('aria-label', /120/);

      const timestampTextStyle = await timestamp.evaluate((el) => {
        const style = getComputedStyle(el);
        return {
          color: style.color,
          fontSize: style.fontSize,
          lineHeight: style.lineHeight,
        };
      });
      const usageTextStyle = await writeMeta.evaluate((el) => {
        const style = getComputedStyle(el);
        return {
          backgroundColor: style.backgroundColor,
          borderTopColor: style.borderTopColor,
          color: style.color,
          fontSize: style.fontSize,
          lineHeight: style.lineHeight,
        };
      });
      expect(usageTextStyle).toMatchObject(timestampTextStyle);
      expect(usageTextStyle.backgroundColor).toBe('rgba(0, 0, 0, 0)');
      expect(usageTextStyle.borderTopColor).toBe('rgba(0, 0, 0, 0)');

      const visibleMetaText = await meta.innerText();
      expect(visibleMetaText).not.toMatch(/\b(ctx|total|in|out|cache)\b/i);

      await expect.poll(async () => hoverBar.evaluate((el) => getComputedStyle(el).opacity)).toBe('0');
      await message.hover();
      await expect.poll(async () => hoverBar.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');

      await writeMeta.hover();
      const tooltip = page.getByTestId('chat-message-meta-tooltip-write');
      await expect(tooltip).toBeVisible();
      await expect(tooltip).toContainText('Write');
      await expect(tooltip).toContainText('30 tokens');
      const hoveredUsageStyle = await writeMeta.evaluate((el) => {
        const style = getComputedStyle(el);
        return {
          backgroundColor: style.backgroundColor,
          borderTopColor: style.borderTopColor,
        };
      });
      expect(hoveredUsageStyle.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
      expect(hoveredUsageStyle.borderTopColor).not.toBe('rgba(0, 0, 0, 0)');
    } finally {
      await closeElectronApp(app);
    }
  });
});
