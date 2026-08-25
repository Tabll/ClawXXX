import type { ElectronApplication } from '@playwright/test';
import {
  closeElectronApp,
  expect,
  getStableWindow,
  installAttachmentHostFixture,
  test,
} from './fixtures/electron';

const SESSION_KEY = 'agent:main:main';
const longAnswer = [
  'This answer intentionally contains enough text to make the chat scrollable in the Electron window.',
  'It gives the question directory a meaningful target to jump to when the user selects an entry.',
  'The content itself is not important; the test verifies the shared question outline.',
].join(' ');
const seededHistory = [
  ['user', 'First question: summarize the market opening.'],
  ['assistant', `${longAnswer}\n\n${longAnswer}\n\n${longAnswer}`],
  ['user', 'Second question: list the strongest sectors.'],
  ['assistant', `${longAnswer}\n\n${longAnswer}\n\n${longAnswer}`],
  ['user', 'Third question: explain notable risks.'],
  ['assistant', `${longAnswer}\n\n${longAnswer}\n\n${longAnswer}`],
  ['user', 'Fourth question: prepare the final action plan.'],
  ['assistant', 'Here is the final action plan.'],
] as const;
const latestQuestion = '给我生成一只哈密瓜';
const longHistory = [
  ...Array.from({ length: 14 }, (_, index) => ([
    ['user', `Question ${index + 1}: generate an image.`] as const,
    ['assistant', `Answer ${index + 1}.`] as const,
  ])).flat(),
  ['user', latestQuestion] as const,
  ['assistant', 'Here is the cantaloupe image.'] as const,
];

function historyUpdates(history: ReadonlyArray<readonly [string, string]>) {
  return history.map(([role, text], index) => ({
    sessionUpdate: role === 'user' ? 'user_message' : 'agent_message',
    messageId: `question-directory-${index}`,
    content: [{ type: 'text', text }],
  }));
}

async function openChat(app: ElectronApplication) {
  const page = await getStableWindow(app);
  await page.setViewportSize({ width: 1600, height: 900 });
  try {
    await page.reload();
  } catch (error) {
    if (!String(error).includes('ERR_FILE_NOT_FOUND')) throw error;
  }
  await expect(page.getByTestId('main-layout')).toBeVisible();
  return page;
}

test.describe('canonical chat question directory', () => {
  test('opens and navigates the question directory for unified history', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      const fixture = await installAttachmentHostFixture(app, {
        sessions: [{ key: SESSION_KEY, title: 'Main session' }],
      });
      await fixture.setSessionReplay(SESSION_KEY, historyUpdates(seededHistory));
      const page = await openChat(app);
      await expect(page.getByTestId('acp-chat-timeline')).toBeVisible({ timeout: 30_000 });
      const scrollColumn = page.getByTestId('chat-scroll-column');
      const before = await scrollColumn.boundingBox();
      await page.getByTestId('chat-question-directory-toggle').click();
      const directory = page.getByTestId('chat-question-directory');
      await expect(directory).toBeVisible();
      const after = await scrollColumn.boundingBox();
      const directoryBox = await directory.boundingBox();
      expect(before).not.toBeNull();
      expect(after).not.toBeNull();
      expect(directoryBox).not.toBeNull();
      expect(Math.abs(after!.width - before!.width)).toBeLessThan(1);
      expect(directoryBox!.x).toBeGreaterThan(after!.x);
      expect(directoryBox!.x + directoryBox!.width).toBeLessThanOrEqual(after!.x + after!.width + 1);
      await expect(directory.getByTestId(/^chat-question-directory-item-/)).toHaveCount(4);
      for (const question of seededHistory.filter(([role]) => role === 'user').map(([, text]) => text)) {
        await expect(directory).toContainText(question);
      }

      const firstItemId = 'fixture-user:question-directory-0:0';
      const firstAnchor = page.locator(`[id="acp-user-message-${firstItemId}"]`);
      await expect(firstAnchor).not.toBeInViewport();
      await directory.getByTitle('First question: summarize the market opening.').click();
      await expect(firstAnchor).toBeInViewport();
      await expect(page.getByTestId('acp-user-message')).toHaveCount(4);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('restores the latest question from a long SQLite history', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      const fixture = await installAttachmentHostFixture(app, {
        sessions: [{ key: SESSION_KEY, title: 'Main session' }],
      });
      await fixture.setSessionReplay(SESSION_KEY, historyUpdates(longHistory));
      const page = await openChat(app);
      await expect(page.getByTestId('acp-user-message')).toHaveCount(15, { timeout: 30_000 });
      await expect(page.getByText(latestQuestion, { exact: true })).toBeVisible();
      await page.getByTestId('chat-question-directory-toggle').click();
      await expect(page.getByTestId('chat-question-directory')).toContainText(latestQuestion);
    } finally {
      await closeElectronApp(app);
    }
  });
});
