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
const CLOUD_ARTIFACT_PATH = '/opt/cursor/artifacts/chat_table_header_light.png';
const tableMarkdown = [
  '| Account | Content | Heat |',
  '|---------|---------|------|',
  '| @OpenAI | Workspace Agents for cross-team workflows | 15K |',
  '| @oran_ge | Image model launch | 68 |',
  '| @caiyue5 | AI-generated image detection | 74 |',
].join('\n');

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

test.describe('canonical chat table header styling', () => {
  test('renders transparent light and muted dark Markdown table headers', async ({ launchElectronApp }, testInfo) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      const fixture = await installAttachmentHostFixture(app, {
        sessions: [{ key: SESSION_KEY, title: 'Main session' }],
      });
      await fixture.setSessionReplay(SESSION_KEY, [
        {
          sessionUpdate: 'user_message',
          messageId: 'table-user',
          content: [{ type: 'text', text: 'Summarize today\'s AI news.' }],
        },
        {
          sessionUpdate: 'agent_message',
          messageId: 'table-assistant',
          content: [{ type: 'text', text: `**Trending AI news**\n\n${tableMarkdown}` }],
        },
      ]);
      const page = await openChat(app);
      await page.evaluate(() => {
        document.documentElement.classList.remove('dark');
        document.documentElement.classList.add('light');
      });
      const headerParent = page.locator('.prose table thead').first();
      const headerCell = headerParent.locator('th').first();
      await expect(headerCell).toBeVisible({ timeout: 30_000 });
      const light = await headerParent.evaluate((element) => {
        const cell = element.querySelector('th');
        if (!cell) throw new Error('Markdown table header cell is missing');
        return {
          parentBackgroundColor: window.getComputedStyle(element).backgroundColor,
          cellBackgroundColor: window.getComputedStyle(cell).backgroundColor,
          cellFontWeight: window.getComputedStyle(cell).fontWeight,
        };
      });
      expect(light.parentBackgroundColor).toBe('rgba(0, 0, 0, 0)');
      expect(light.cellBackgroundColor).toBe('rgba(0, 0, 0, 0)');
      expect(Number(light.cellFontWeight)).toBeGreaterThanOrEqual(700);

      const table = page.locator('.prose table').first();
      const screenshotPath = testInfo.outputPath('chat_table_header_light.png');
      await table.screenshot({ path: screenshotPath });
      await testInfo.attach('chat_table_header_light', { path: screenshotPath, contentType: 'image/png' });
      try {
        mkdirSync(dirname(CLOUD_ARTIFACT_PATH), { recursive: true });
        copyFileSync(screenshotPath, CLOUD_ARTIFACT_PATH);
      } catch {
        // Optional cloud artifact path is unavailable on most CI runners.
      }

      await page.evaluate(() => {
        document.documentElement.classList.remove('light');
        document.documentElement.classList.add('dark');
      });
      const dark = await headerParent.evaluate((element) => {
        const cell = element.querySelector('th');
        if (!cell) throw new Error('Markdown table header cell is missing');
        const probe = document.createElement('div');
        probe.className = 'bg-muted';
        document.body.appendChild(probe);
        const mutedBackgroundColor = window.getComputedStyle(probe).backgroundColor;
        probe.remove();
        return {
          parentBackgroundColor: window.getComputedStyle(element).backgroundColor,
          cellBackgroundColor: window.getComputedStyle(cell).backgroundColor,
          mutedBackgroundColor,
        };
      });
      expect(dark.parentBackgroundColor).toBe(dark.mutedBackgroundColor);
      expect(dark.cellBackgroundColor).toBe(dark.mutedBackgroundColor);
    } finally {
      await closeElectronApp(app);
    }
  });
});
