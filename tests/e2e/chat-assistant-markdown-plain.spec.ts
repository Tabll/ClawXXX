import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ElectronApplication } from '@playwright/test';
import {
  closeElectronApp,
  expect,
  getStableWindow,
  installAttachmentHostFixture,
  test,
} from './fixtures/electron';

const SESSION_KEY = 'agent:main:main';
const CLOUD_ARTIFACT_PATH = '/opt/cursor/artifacts/chat_assistant_plain_markdown.png';

const seededUpdates = [
  {
    sessionUpdate: 'user_message',
    messageId: 'plain-markdown-user',
    content: [{ type: 'text', text: '**Please** render `this input` literally.\n# Not a heading' }],
  },
  {
    sessionUpdate: 'agent_message',
    messageId: 'plain-markdown-assistant',
    content: [{
      type: 'text',
      text: [
        '### Plain Markdown reply',
        '',
        'This assistant reply should render as normal Markdown, not inside a gray rounded bubble.',
        '',
        '- Bold text: **works**',
        '- Inline code: `worksToo()`',
      ].join('\n'),
    }],
  },
] as Array<Record<string, unknown> & { sessionUpdate: string }>;

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

test.describe('canonical chat Markdown styling', () => {
  test('renders assistant Markdown while keeping user input literal and bubbled', async ({ launchElectronApp }, testInfo) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      const fixture = await installAttachmentHostFixture(app, {
        sessions: [{ key: SESSION_KEY, title: 'Main session' }],
      });
      await fixture.setSessionReplay(SESSION_KEY, seededUpdates);
      const page = await openChat(app);
      await page.evaluate(() => {
        document.documentElement.classList.remove('dark');
        document.documentElement.classList.add('light');
      });

      const userBubble = page.getByTestId('acp-user-message').filter({ hasText: 'Please' }).locator('div.rounded-2xl.bg-brand').first();
      await expect(userBubble).toBeVisible({ timeout: 30_000 });
      await expect(userBubble.locator('p')).toHaveText('**Please** render `this input` literally.\n# Not a heading');
      await expect(userBubble.locator('strong, code, h1')).toHaveCount(0);

      const assistantProse = page.getByTestId('acp-assistant-message').filter({ hasText: 'Plain Markdown reply' }).locator('.prose').first();
      await expect(assistantProse).toBeVisible({ timeout: 30_000 });
      await expect(assistantProse.locator('strong')).toHaveText('works');
      const inlineCode = assistantProse.locator('code');
      await expect(inlineCode).toHaveText('worksToo()');
      await expect.poll(() => inlineCode.evaluate(el => window.getComputedStyle(el).backgroundColor))
        .toBe('rgba(0, 0, 0, 0)');

      const styles = await assistantProse.evaluate((el) => {
        const style = window.getComputedStyle(el);
        const parentStyle = el.parentElement ? window.getComputedStyle(el.parentElement) : null;
        return {
          backgroundColor: style.backgroundColor,
          borderRadius: style.borderRadius,
          paddingLeft: style.paddingLeft,
          paddingTop: style.paddingTop,
          parentBackgroundColor: parentStyle?.backgroundColor ?? '',
          parentBorderRadius: parentStyle?.borderRadius ?? '',
        };
      });
      expect(styles).toEqual({
        backgroundColor: 'rgba(0, 0, 0, 0)',
        borderRadius: '0px',
        paddingLeft: '0px',
        paddingTop: '0px',
        parentBackgroundColor: 'rgba(0, 0, 0, 0)',
        parentBorderRadius: '0px',
      });

      const screenshotPath = testInfo.outputPath('chat_assistant_plain_markdown.png');
      await assistantProse.screenshot({ path: screenshotPath });
      await testInfo.attach('chat_assistant_plain_markdown', { path: screenshotPath, contentType: 'image/png' });
      try {
        mkdirSync(dirname(CLOUD_ARTIFACT_PATH), { recursive: true });
        copyFileSync(screenshotPath, CLOUD_ARTIFACT_PATH);
      } catch {
        // Optional cloud artifact path is unavailable on most CI runners.
      }
    } finally {
      await closeElectronApp(app);
    }
  });
});
