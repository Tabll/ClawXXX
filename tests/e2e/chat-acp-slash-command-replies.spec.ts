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
  await expect(page.getByTestId('chat-page')).toBeVisible();
  return page;
}

test.describe('canonical slash-command replies', () => {
  test('shows replies for /status and /compact in the shared timeline', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      const fixture = await installAttachmentHostFixture(app, {
        sessions: [{ key: SESSION_KEY, title: 'Main session' }],
      });
      await fixture.setPromptUpdates('/status', [{
        sessionUpdate: 'agent_message',
        messageId: 'status-reply',
        content: [{ type: 'text', text: 'OpenClaw status: connected' }],
      }]);
      await fixture.setPromptUpdates('/compact', [{
        sessionUpdate: 'agent_message',
        messageId: 'compact-reply',
        content: [{ type: 'text', text: 'Compaction complete' }],
      }]);
      const page = await openChat(app);
      const input = page.getByTestId('chat-composer-input');

      await input.fill('/status');
      await page.getByTestId('chat-composer-send').click();
      await expect(page.getByTestId('acp-assistant-message').filter({ hasText: 'OpenClaw status: connected' }))
        .toBeVisible({ timeout: 30_000 });

      await input.fill('/compact');
      await page.getByTestId('chat-composer-send').click();
      await expect(page.getByTestId('acp-assistant-message').filter({ hasText: 'Compaction complete' }))
        .toBeVisible({ timeout: 30_000 });
    } finally {
      await closeElectronApp(app);
    }
  });
});
