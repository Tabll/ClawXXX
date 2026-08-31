import type { ElectronApplication, Locator } from '@playwright/test';
import {
  closeElectronApp,
  expect,
  getStableWindow,
  installAttachmentHostFixture,
  test,
} from './fixtures/electron';

const SESSION_KEY = 'agent:main:main';
const PROMPT = 'do a multi-tool task';
const seededUpdates = Array.from({ length: 40 }, (_, index) => ({
  sessionUpdate: index % 2 === 0 ? 'user_message' : 'agent_message',
  messageId: `pin-history-${index + 1}`,
  content: [{ type: 'text', text: `Chat history message ${index + 1}` }],
}));

function streamingText(paragraphs: number): string {
  return Array.from({ length: paragraphs }, (_, index) => `Streaming paragraph ${index + 1}.`).join('\n\n');
}

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

async function waitForInitialScrollToSettle(scrollContainer: Locator) {
  const maxScroll = () => scrollContainer.evaluate((element) => (
    element.scrollHeight - element.clientHeight
  ));
  const distanceFromBottom = () => scrollContainer.evaluate((element) => (
    Math.round(element.scrollHeight - element.clientHeight - element.scrollTop)
  ));

  await expect.poll(maxScroll).toBeGreaterThan(70);
  await expect.poll(distanceFromBottom).toBeLessThanOrEqual(8);
  await scrollContainer.evaluate((element) => new Promise<void>((resolve) => {
    const view = element.ownerDocument.defaultView;
    if (!view) {
      resolve();
      return;
    }
    view.requestAnimationFrame(() => {
      view.requestAnimationFrame(() => resolve());
    });
  }));
  await expect.poll(distanceFromBottom).toBeLessThanOrEqual(8);
}

test.describe('canonical chat scroll pin-to-bottom during runs', () => {
  test('stays pinned through tool-heavy streaming and yields to manual scroll-up', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      const fixture = await installAttachmentHostFixture(app, {
        sessions: [{ key: SESSION_KEY, title: 'Main session' }],
      });
      await fixture.setSessionReplay(SESSION_KEY, seededUpdates);
      await fixture.setPromptUpdates(PROMPT, []);
      await fixture.deferPromptResponse(PROMPT);
      const page = await openChat(app);
      await expect(page.getByText('Chat history message 40')).toBeVisible({ timeout: 30_000 });
      const scrollContainer = page.getByTestId('chat-scroll-container');
      await waitForInitialScrollToSettle(scrollContainer);
      const expectPinned = async () => {
        await expect.poll(async () => scrollContainer.evaluate((element) => (
          Math.round(element.scrollHeight - element.clientHeight - element.scrollTop)
        )), { timeout: 5_000 }).toBeLessThanOrEqual(8);
      };
      const emitText = async (paragraphs: number) => fixture.emitAcpSessionUpdates({
        sessionKey: SESSION_KEY,
        updates: [{
          sessionUpdate: 'agent_message',
          messageId: 'streaming-assistant',
          content: [{ type: 'text', text: streamingText(paragraphs) }],
        }],
      });

      await scrollContainer.evaluate((element) => {
        element.scrollTop = 0;
        element.dispatchEvent(new Event('scroll', { bubbles: true }));
      });
      await expect(page.getByTestId('chat-scroll-to-latest')).toBeVisible();
      await page.getByTestId('chat-composer-input').fill(PROMPT);
      await page.getByTestId('chat-composer-send').click();
      await expect(page.getByTestId('chat-composer-send')).toHaveAttribute('title', 'Stop');
      await expect(page.getByText(PROMPT)).toBeInViewport();
      await expectPinned();

      await emitText(3);
      await expectPinned();
      await emitText(8);
      await expectPinned();
      await fixture.emitAcpSessionUpdates({
        sessionKey: SESSION_KEY,
        updates: [{
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-1',
          title: 'exec',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'ls -la' } }],
          locations: [],
        }],
      });
      await expectPinned();
      await emitText(14);
      await expectPinned();

      await scrollContainer.evaluate((element) => {
        element.scrollTop = 0;
        element.dispatchEvent(new Event('scroll', { bubbles: true }));
      });
      const jumpButton = page.getByTestId('chat-scroll-to-latest');
      await expect(jumpButton).toBeVisible();
      await emitText(20);
      await expect(jumpButton).toBeVisible();
      expect(await scrollContainer.evaluate(element => (
        Math.round(element.scrollHeight - element.clientHeight - element.scrollTop)
      ))).toBeGreaterThan(8);
      await jumpButton.click();
      await expect(jumpButton).toBeHidden({ timeout: 10_000 });
      await fixture.releasePromptResponse(PROMPT);
    } finally {
      await closeElectronApp(app);
    }
  });
});
