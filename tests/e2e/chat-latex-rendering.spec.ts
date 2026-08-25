import type { ElectronApplication } from '@playwright/test';
import {
  closeElectronApp,
  expect,
  getStableWindow,
  installAttachmentHostFixture,
  test,
} from './fixtures/electron';

const SESSION_KEY = 'agent:main:main';

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

test.describe('canonical chat LaTeX rendering', () => {
  test('renders KaTeX markup for inline and display delimiters', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      const fixture = await installAttachmentHostFixture(app, {
        sessions: [{ key: SESSION_KEY, title: 'Main session' }],
      });
      await fixture.setSessionReplay(SESSION_KEY, [
        {
          sessionUpdate: 'user_message',
          messageId: 'latex-user',
          content: [{ type: 'text', text: 'Show mass-energy equivalence and a definite integral.' }],
        },
        {
          sessionUpdate: 'agent_message',
          messageId: 'latex-assistant',
          content: [{
            type: 'text',
            text: [
              'Einstein wrote $E=mc^2$, and the quadratic formula is \\(x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}\\).',
              '',
              '$$',
              '\\int_0^1 x\\,dx = \\frac{1}{2}',
              '$$',
              '',
              '\\[\\sum_{i=1}^n i = \\frac{n(n+1)}{2}\\]',
            ].join('\n'),
          }],
        },
      ]);
      const page = await openChat(app);
      const timeline = page.getByTestId('acp-chat-timeline');
      await expect(timeline.locator('.katex').first()).toBeVisible({ timeout: 30_000 });
      await expect(timeline.locator('.katex').filter({ hasText: /E\s*=\s*mc/ }).first()).toBeVisible();
      await expect(timeline.locator('.katex-display')).toHaveCount(2);
    } finally {
      await closeElectronApp(app);
    }
  });
});
