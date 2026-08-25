import type { ElectronApplication } from '@playwright/test';
import {
  closeElectronApp,
  expect,
  getStableWindow,
  installAttachmentHostFixture,
  test,
} from './fixtures/electron';

const SESSION_KEY = 'agent:main:main';
const seededUpdates = Array.from({ length: 36 }, (_, index) => ({
  sessionUpdate: index % 2 === 0 ? 'user_message' : 'agent_message',
  messageId: `scroll-history-${index + 1}`,
  content: [{
    type: 'text',
    text: `${index === 0 ? 'Very first message' : 'Chat history message'} ${index + 1}`,
  }],
}));

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

test.describe('canonical chat scroll-to-latest affordance', () => {
  test('shows a jump button when reading older history and returns to the latest turn', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      const fixture = await installAttachmentHostFixture(app, {
        sessions: [{ key: SESSION_KEY, title: 'Main session' }],
      });
      await fixture.setSessionReplay(SESSION_KEY, seededUpdates);
      const page = await openChat(app);
      await expect(page.getByText('Chat history message 36')).toBeVisible({ timeout: 30_000 });
      const scrollContainer = page.getByTestId('chat-scroll-container');
      await scrollContainer.evaluate((element) => {
        element.scrollTop = 0;
        element.dispatchEvent(new Event('scroll', { bubbles: true }));
      });
      const jumpButton = page.getByTestId('chat-scroll-to-latest');
      await expect(jumpButton).toBeVisible();
      await jumpButton.click();
      await expect(jumpButton).toBeHidden({ timeout: 10_000 });
      await expect(page.getByText('Chat history message 36')).toBeVisible();
    } finally {
      await closeElectronApp(app);
    }
  });
});
