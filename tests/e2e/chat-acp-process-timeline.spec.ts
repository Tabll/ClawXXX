import type { ElectronApplication } from '@playwright/test';
import {
  closeElectronApp,
  expect,
  getStableWindow,
  installAttachmentHostFixture,
  test,
} from './fixtures/electron';

const SESSION_KEY = 'agent:main:main';

type AcpSessionUpdate = Record<string, unknown> & { sessionUpdate: string };

async function openChat(app: ElectronApplication) {
  const page = await getStableWindow(app);
  try {
    await page.reload();
  } catch (error) {
    if (!String(error).includes('ERR_FILE_NOT_FOUND')) throw error;
  }
  await expect(page.getByTestId('main-layout')).toBeVisible();
  await expect(page.getByTestId('chat-page')).toBeVisible();
  return page;
}

async function failFirstKernelSelection(app: ElectronApplication): Promise<void> {
  await app.evaluate(async () => {
    const { ipcMain } = process.mainModule!.require('electron') as typeof import('electron');
    type HostRequest = { id?: string; module?: string; action?: string };
    type HostHandler = (event: unknown, request: HostRequest) => Promise<unknown>;
    const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, HostHandler> })._invokeHandlers;
    const original = handlers?.get('host:invoke');
    let failed = false;
    ipcMain.removeHandler('host:invoke');
    ipcMain.handle('host:invoke', async (event: unknown, request: HostRequest) => {
      if (!failed && request.module === 'chat' && request.action === 'selectConversationKernel') {
        failed = true;
        return { id: request.id, ok: true, data: { success: false, error: 'Kernel selection failed' } };
      }
      return original?.(event, request) ?? { id: request.id, ok: true, data: {} };
    });
  });
}

const longRunPrompt = 'Inspect the workspace and summarize the result';
const longRunProcessSegments = Array.from({ length: 9 }, (_, index) => `Checked source ${index + 1}.`);
const longRunSummary = 'Here is the summary.';

test.describe('canonical chat process timeline', () => {
  test('replaces a failed DSH attempt with an explicit empty snapshot before retrying', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      const fixture = await installAttachmentHostFixture(app, {
        sessions: [{ key: SESSION_KEY, title: 'Main session' }],
      });
      await fixture.deferPromptResponse('retry stream');
      const page = await openChat(app);
      await page.getByTestId('chat-composer-input').fill('retry stream');
      await page.getByTestId('chat-composer-send').click();
      await expect(page.getByTestId('chat-composer-send')).toHaveAttribute('title', 'Stop');
      await fixture.emitAcpSessionUpdates({ sessionKey: SESSION_KEY, updates: [
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Failed attempt prefix' } },
      ] });
      await expect(page.getByText('Failed attempt prefix', { exact: true })).toBeVisible();
      await fixture.emitAcpSessionUpdates({ sessionKey: SESSION_KEY, updates: [
        { sessionUpdate: 'agent_message', content: [] },
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Recovered answer' } },
        { sessionUpdate: 'agent_message', content: [{ type: 'text', text: 'Recovered answer' }] },
      ] });
      await expect(page.getByText('Failed attempt prefix', { exact: true })).toHaveCount(0);
      await expect(page.getByText('Recovered answer', { exact: true })).toHaveCount(1);
      await fixture.releasePromptResponse('retry stream');
    } finally {
      await closeElectronApp(app);
    }
  });

  test('renders thought, tool, plan, and final blocks from one SQLite conversation export', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      const fixture = await installAttachmentHostFixture(app, {
        sessions: [{ key: SESSION_KEY, title: 'Main session' }],
      });
      const replay: AcpSessionUpdate[] = [
        {
          sessionUpdate: 'user_message',
          messageId: 'process-user',
          content: [{ type: 'text', text: 'Read the file and propose changes' }],
        },
        {
          sessionUpdate: 'agent_thought_chunk',
          messageId: 'process-thought',
          content: { type: 'text', text: 'Need to inspect the current implementation first.' },
        },
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'read-file',
          title: 'Read file',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'Loaded src/pages/Chat/index.tsx' } }],
          locations: [],
        },
        {
          sessionUpdate: 'plan',
          entries: [{ content: 'Update Chat page tests', status: 'pending' }],
        },
        {
          sessionUpdate: 'agent_message',
          messageId: 'process-final',
          content: [{ type: 'text', text: 'The Chat page renders canonical timeline blocks inline.' }],
        },
      ];
      await fixture.setSessionReplay(SESSION_KEY, replay);

      const page = await openChat(app);
      await expect(page.getByTestId('acp-chat-timeline')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('acp-thought-block')).toContainText('Need to inspect the current implementation first.');
      await expect(page.getByTestId('acp-tool-call-card')).toContainText('Read file');
      await page.getByTestId('acp-tool-toggle').click();
      await expect(page.getByTestId('acp-tool-call-card')).toContainText('Loaded src/pages/Chat/index.tsx');
      await expect(page.getByTestId('acp-plan-item')).toContainText('Update Chat page tests');
      await expect(page.getByText('The Chat page renders canonical timeline blocks inline.')).toBeVisible();
    } finally {
      await closeElectronApp(app);
    }
  });

  test('keeps long historical process blocks separate in their canonical order', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      const fixture = await installAttachmentHostFixture(app, {
        sessions: [{ key: SESSION_KEY, title: 'Main session' }],
      });
      await fixture.setSessionReplay(SESSION_KEY, [
        {
          sessionUpdate: 'user_message',
          messageId: 'long-user',
          content: [{ type: 'text', text: longRunPrompt }],
        },
        ...longRunProcessSegments.map((text, index) => ({
          sessionUpdate: 'agent_message',
          messageId: `long-step-${index}`,
          content: [{ type: 'text', text }],
        })),
        {
          sessionUpdate: 'agent_message',
          messageId: 'long-summary',
          content: [{ type: 'text', text: longRunSummary }],
        },
      ]);

      const page = await openChat(app);
      await expect(page.getByText(longRunProcessSegments[0]!, { exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(longRunProcessSegments.at(-1)!, { exact: true })).toBeVisible();
      await expect(page.getByText(longRunSummary, { exact: true })).toBeVisible();
      await expect(page.getByText(`${longRunProcessSegments.join(' ')} ${longRunSummary}`, { exact: true })).toHaveCount(0);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('surfaces a canonical kernel selection error and succeeds after navigation retries it', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      await installAttachmentHostFixture(app, {
        sessions: [{ key: SESSION_KEY, title: 'Main session' }],
      });
      await failFirstKernelSelection(app);
      const page = await openChat(app);
      const errorBanner = page.getByTestId('acp-error-banner');
      await expect(errorBanner).toContainText('Kernel selection failed', { timeout: 30_000 });
      await page.getByRole('button', { name: 'Dismiss' }).click();
      await expect(errorBanner).toHaveCount(0);

      await page.getByTestId('sidebar-nav-settings').click();
      await expect(page.getByTestId('settings-page')).toBeVisible();
      await page.getByTestId(`sidebar-session-${SESSION_KEY}`).click();
      await expect(page.getByTestId('acp-chat-empty-state')).toBeVisible({ timeout: 30_000 });
      await page.getByTestId('chat-composer-input').fill('retry');
      await expect(page.getByTestId('chat-composer-send')).toBeEnabled();
    } finally {
      await closeElectronApp(app);
    }
  });
});
