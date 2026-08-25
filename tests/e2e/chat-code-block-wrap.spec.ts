import type { ElectronApplication } from '@playwright/test';
import {
  closeElectronApp,
  expect,
  getStableWindow,
  installAttachmentHostFixture,
  test,
} from './fixtures/electron';

const SESSION_KEY = 'agent:main:main';
const LONG_LOG_LINE = 'config change requires channel reload (wecom) — deferring until 2 operation(s), 1 reply(ies), 1 embedded run(s) complete';
const LONG_PATH = '/workspace/agents/main/sessions/canonical-conversation-reference';

async function openChat(app: ElectronApplication) {
  const page = await getStableWindow(app);
  try {
    await page.reload();
  } catch (error) {
    if (!String(error).includes('ERR_FILE_NOT_FOUND')) throw error;
  }
  await expect(page.getByTestId('main-layout')).toBeVisible();
  return page;
}

test.describe('canonical chat code block wrapping', () => {
  test('soft-wraps long lines inside fenced code blocks instead of overflowing', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      const fixture = await installAttachmentHostFixture(app, {
        sessions: [{ key: SESSION_KEY, title: 'Main session' }],
      });
      await fixture.setSessionReplay(SESSION_KEY, [
        {
          sessionUpdate: 'user_message',
          messageId: 'code-wrap-user',
          content: [{ type: 'text', text: 'Show me the runtime log line.' }],
        },
        {
          sessionUpdate: 'agent_message',
          messageId: 'code-wrap-assistant',
          content: [{
            type: 'text',
            text: ['Here is the relevant log entry:', '', '```', LONG_LOG_LINE, LONG_PATH, '```'].join('\n'),
          }],
        },
      ]);
      const page = await openChat(app);
      await page.setViewportSize({ width: 720, height: 800 });

      const assistantProse = page.getByTestId('acp-assistant-message')
        .filter({ hasText: 'Here is the relevant log entry' })
        .locator('.prose')
        .first();
      await expect(assistantProse).toBeVisible({ timeout: 30_000 });
      const codeBlock = assistantProse.locator('pre').first();
      const code = codeBlock.locator('code');
      await expect(codeBlock).toBeVisible();
      await expect(code).not.toHaveClass(/bg-black\/5/);

      const metrics = await codeBlock.evaluate((el) => {
        const style = window.getComputedStyle(el);
        return {
          whiteSpace: style.whiteSpace,
          overflowWrap: style.overflowWrap || (style as unknown as { wordWrap: string }).wordWrap,
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
        };
      });
      expect(metrics.whiteSpace).toBe('pre-wrap');
      expect(metrics.overflowWrap).toBe('break-word');
      expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
      await expect(codeBlock).toContainText(LONG_LOG_LINE);
      await expect(codeBlock).toContainText(LONG_PATH);
      await expect.poll(() => code.evaluate(el => window.getComputedStyle(el).backgroundColor))
        .toBe('rgba(0, 0, 0, 0)');
    } finally {
      await closeElectronApp(app);
    }
  });
});
