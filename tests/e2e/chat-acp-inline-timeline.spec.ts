import type { ElectronApplication } from '@playwright/test';
import {
  closeElectronApp,
  expect,
  getRecordedLegacyIpcInvocations,
  getStableWindow,
  installAttachmentHostFixture,
  test,
} from './fixtures/electron';

const SESSION_KEY = 'agent:main:main';
const IMAGE_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

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

function userMessage(text: string, messageId = 'user-message'): AcpSessionUpdate {
  return {
    sessionUpdate: 'user_message',
    messageId,
    content: [{ type: 'text', text }],
  };
}

function assistantMessage(text: string, messageId = 'assistant-message'): AcpSessionUpdate {
  return {
    sessionUpdate: 'agent_message',
    messageId,
    content: [{ type: 'text', text }],
  };
}

function toolCall(input: {
  status: 'in_progress' | 'completed';
  output: string;
  toolCallId?: string;
  title?: string;
}): AcpSessionUpdate {
  return {
    sessionUpdate: input.status === 'completed' ? 'tool_call_update' : 'tool_call',
    toolCallId: input.toolCallId ?? 'inspect-tool',
    title: input.title ?? 'Inspect project',
    status: input.status,
    content: [{ type: 'content', content: { type: 'text', text: input.output } }],
    locations: [],
  };
}

test.describe('canonical inline chat timeline', () => {
  test('loads a sidebar conversation without any legacy history request', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      const fixture = await installAttachmentHostFixture(app, {
        sessions: [{ key: SESSION_KEY, title: 'Main session' }],
      });
      const page = await openChat(app);
      await expect(page.getByTestId(`sidebar-session-${SESSION_KEY}`)).toBeVisible({ timeout: 30_000 });
      await page.getByTestId(`sidebar-session-${SESSION_KEY}`).click();
      await expect(page.getByTestId('acp-chat-empty-state')).toBeVisible();

      const calls = await fixture.getHostInvocations();
      expect(calls.some(call => call.module === 'conversations' && call.action === 'get')).toBe(true);
      expect(calls.some(call => call.module === 'sessions' && call.action === 'history')).toBe(false);
      expect(calls.some(call => call.module === 'chat' && call.action === 'loadAcpSession')).toBe(false);
      expect((await getRecordedLegacyIpcInvocations(app)).some(call => (
        call.channel === 'gateway:rpc' && JSON.stringify(call.args).includes('chat.history')
      ))).toBe(false);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('hydrates historical text, duration, and kernel provenance from one export', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      const fixture = await installAttachmentHostFixture(app, {
        sessions: [{ key: SESSION_KEY, title: 'Main session' }],
      });
      await fixture.setSessionReplay(SESSION_KEY, [
        userMessage('Measure this historical turn', 'timed-user'),
        assistantMessage('Historical turn measured', 'timed-assistant'),
      ]);
      const page = await openChat(app);
      await expect(page.getByText('Historical turn measured')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('acp-turn-duration')).toHaveText('Took 1 sec');
      await expect(page.getByTestId('acp-assistant-turn')).toContainText(/Kernel openclaw/i);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('commits a long SQLite history projection without exposing partial assistant text', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    const paragraphs = Array.from({ length: 12 }, (_, index) => `Paragraph ${index + 1}.\n\n`);
    try {
      const fixture = await installAttachmentHostFixture(app, {
        sessions: [{ key: SESSION_KEY, title: 'Main session' }],
      });
      await fixture.setSessionReplay(SESSION_KEY, [
        userMessage('Write a 12-paragraph article', 'long-user'),
        ...paragraphs.map((text, index) => assistantMessage(text, `paragraph-${index}`)),
      ]);
      const initialPage = await getStableWindow(app);
      await initialPage.addInitScript(() => {
        const observed: number[] = [];
        Object.defineProperty(window, '__canonicalAssistantLengths', { value: observed, configurable: true });
        const observer = new MutationObserver(() => {
          const length = document.querySelector('[data-testid="acp-assistant-message"]')?.textContent?.length ?? 0;
          if (length > 0 && observed.at(-1) !== length) observed.push(length);
        });
        observer.observe(document.documentElement, { childList: true, characterData: true, subtree: true });
      });
      const page = await openChat(app);
      const assistant = page.getByTestId('acp-assistant-message');
      await expect(assistant).toContainText('Paragraph 12.', { timeout: 30_000 });
      const finalLength = await assistant.evaluate(node => node.textContent?.length ?? 0);
      const observedLengths = await page.evaluate(() => (
        (window as unknown as { __canonicalAssistantLengths?: number[] }).__canonicalAssistantLengths ?? []
      ));
      expect(observedLengths.length).toBeLessThanOrEqual(1);
      expect(observedLengths.every(length => length === finalLength)).toBe(true);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('renders historical thought and tool events from the canonical run ledger', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      const fixture = await installAttachmentHostFixture(app, {
        sessions: [{ key: SESSION_KEY, title: 'Main session' }],
      });
      await fixture.setSessionReplay(SESSION_KEY, [
        userMessage('Inspect the project files'),
        {
          sessionUpdate: 'agent_thought_chunk',
          messageId: 'thought',
          content: { type: 'text', text: 'I should inspect package metadata.' },
        },
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'read-package',
          title: 'Read package.json',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'Loaded package metadata' } }],
          locations: [],
        },
        assistantMessage('Inspection complete.'),
      ]);
      const page = await openChat(app);
      await expect(page.getByTestId('acp-thought-block')).toContainText('I should inspect package metadata.', { timeout: 30_000 });
      const card = page.getByTestId('acp-tool-call-card');
      await expect(card).toContainText('Read package.json');
      await page.getByTestId('acp-tool-toggle').click();
      await expect(card).toContainText('Loaded package metadata');
    } finally {
      await closeElectronApp(app);
    }
  });

  test('shows an optimistic prompt and coalesces standard assistant stream events', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      const fixture = await installAttachmentHostFixture(app, {
        sessions: [{ key: SESSION_KEY, title: 'Main session' }],
      });
      await fixture.setPromptUpdates('Plan the migration', [
        { sessionUpdate: 'agent_message_chunk', messageId: 'stream', content: { type: 'text', text: 'Streaming' } },
        { sessionUpdate: 'agent_message_chunk', messageId: 'stream', content: { type: 'text', text: ' response' } },
        assistantMessage('Streaming response', 'stream'),
      ]);
      await fixture.deferPromptResponse('Plan the migration');
      const page = await openChat(app);
      await page.getByTestId('chat-composer-input').fill('Plan the migration');
      await page.getByTestId('chat-composer-send').click();
      await expect(page.getByText('Plan the migration')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText('Streaming response', { exact: true })).toHaveCount(1);
      await fixture.releasePromptResponse('Plan the migration');
    } finally {
      await closeElectronApp(app);
    }
  });

  test('continues receiving one run while Chat is unmounted', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      const fixture = await installAttachmentHostFixture(app, {
        sessions: [{ key: SESSION_KEY, title: 'Main session' }],
      });
      await fixture.setPromptUpdates('Keep working while I navigate', []);
      await fixture.deferPromptResponse('Keep working while I navigate');
      const page = await openChat(app);
      await page.getByTestId('chat-composer-input').fill('Keep working while I navigate');
      await page.getByTestId('chat-composer-send').click();
      await fixture.emitAcpSessionUpdates({
        sessionKey: SESSION_KEY,
        updates: [{ sessionUpdate: 'agent_message_chunk', messageId: 'background', content: { type: 'text', text: 'Before navigation. ' } }],
      });
      await expect(page.getByTestId('acp-assistant-message')).toContainText('Before navigation.');
      await page.getByTestId('sidebar-nav-settings').click();
      await expect(page.getByTestId('settings-page')).toBeVisible();
      await fixture.emitAcpSessionUpdates({
        sessionKey: SESSION_KEY,
        updates: [{ sessionUpdate: 'agent_message_chunk', messageId: 'background', content: { type: 'text', text: 'While away. ' } }],
      });
      await page.getByTestId(`sidebar-session-${SESSION_KEY}`).click();
      await expect(page.getByTestId('acp-assistant-message')).toContainText('Before navigation. While away.');
      await fixture.emitAcpSessionUpdates({
        sessionKey: SESSION_KEY,
        updates: [assistantMessage('Before navigation. While away. After return.', 'background')],
      });
      await expect(page.getByTestId('acp-assistant-message')).toContainText('After return.');
      await fixture.releasePromptResponse('Keep working while I navigate');
    } finally {
      await closeElectronApp(app);
    }
  });

  test('copies canonical assistant text from the shared UI', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      const fixture = await installAttachmentHostFixture(app, {
        sessions: [{ key: SESSION_KEY, title: 'Main session' }],
      });
      await fixture.setSessionReplay(SESSION_KEY, [
        userMessage('Answer me'),
        assistantMessage('Copy this canonical answer'),
      ]);
      const page = await openChat(app);
      await page.evaluate(() => {
        Object.defineProperty(navigator, 'clipboard', {
          value: {
            writeText: (value: string) => {
              (window as unknown as { __copiedCanonicalText?: string }).__copiedCanonicalText = value;
              return Promise.resolve();
            },
          },
          configurable: true,
        });
      });
      const message = page.getByTestId('acp-assistant-message');
      await expect(message).toContainText('Copy this canonical answer', { timeout: 30_000 });
      await message.hover();
      await page.getByTestId('acp-assistant-copy').click();
      await expect.poll(() => page.evaluate(() => (
        (window as unknown as { __copiedCanonicalText?: string }).__copiedCanonicalText
      ))).toBe('Copy this canonical answer');
    } finally {
      await closeElectronApp(app);
    }
  });

  test('preserves tool output whitespace and groups it with assistant content', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    const output = 'line one\n  indented line\ncolumn_a\tcolumn_b';
    try {
      const fixture = await installAttachmentHostFixture(app, {
        sessions: [{ key: SESSION_KEY, title: 'Main session' }],
      });
      await fixture.setPromptUpdates('Inspect formatting', [
        { sessionUpdate: 'agent_message_chunk', messageId: 'format', content: { type: 'text', text: 'I will inspect it.' } },
        toolCall({ status: 'in_progress', output }),
        assistantMessage('Formatting is preserved.', 'format'),
      ]);
      await fixture.deferPromptResponse('Inspect formatting');
      const page = await openChat(app);
      await page.getByTestId('chat-composer-input').fill('Inspect formatting');
      await page.getByTestId('chat-composer-send').click();
      const pre = page.getByTestId('acp-tool-output-pre');
      await expect.poll(() => pre.evaluate(node => node.textContent)).toBe(output);
      await expect.poll(() => pre.evaluate(node => getComputedStyle(node).whiteSpace)).toBe('pre');
      await expect(page.getByTestId('acp-assistant-turn')).toHaveCount(1);
      await expect(page.getByTestId('acp-assistant-turn')).toContainText('Formatting is preserved.');
      await fixture.releasePromptResponse('Inspect formatting');
    } finally {
      await closeElectronApp(app);
    }
  });

  test('auto-collapses completed tools and retains a manual expansion override', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      const fixture = await installAttachmentHostFixture(app, {
        sessions: [{ key: SESSION_KEY, title: 'Main session' }],
      });
      await fixture.setPromptUpdates('Run collapsible tool', [
        toolCall({ status: 'in_progress', output: 'working', toolCallId: 'collapse', title: 'Collapsible tool' }),
      ]);
      await fixture.deferPromptResponse('Run collapsible tool');
      const page = await openChat(app);
      await page.getByTestId('chat-composer-input').fill('Run collapsible tool');
      await page.getByTestId('chat-composer-send').click();
      const card = page.getByTestId('acp-tool-call-card');
      await expect(card).toHaveAttribute('data-expanded', 'true', { timeout: 30_000 });
      await fixture.emitAcpSessionUpdates({
        sessionKey: SESSION_KEY,
        updates: [toolCall({ status: 'completed', output: 'done', toolCallId: 'collapse', title: 'Collapsible tool' })],
      });
      await expect(card).toHaveAttribute('data-expanded', 'false');
      await page.getByTestId('acp-tool-toggle').click();
      await expect(card).toHaveAttribute('data-expanded', 'true');
      await fixture.emitAcpSessionUpdates({
        sessionKey: SESSION_KEY,
        updates: [toolCall({ status: 'completed', output: 'done again', toolCallId: 'collapse', title: 'Collapsible tool' })],
      });
      await page.waitForTimeout(1_100);
      await expect(card).toHaveAttribute('data-expanded', 'true');
      await fixture.releasePromptResponse('Run collapsible tool');
    } finally {
      await closeElectronApp(app);
    }
  });

  test('hydrates generated images from canonical content blocks, not transcript fallback', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      const fixture = await installAttachmentHostFixture(app, {
        sessions: [{ key: SESSION_KEY, title: 'Main session' }],
      });
      await fixture.setSessionReplay(SESSION_KEY, [
        userMessage('Generate a pixel'),
        {
          sessionUpdate: 'agent_message',
          messageId: 'image-answer',
          content: [
            { type: 'text', text: 'Generated image' },
            { type: 'image', mimeType: 'image/png', data: IMAGE_BASE64 },
          ],
        },
      ]);
      const page = await openChat(app);
      const image = page.getByTestId('acp-image-part');
      await expect(image).toBeVisible({ timeout: 30_000 });
      await expect(image.locator('img')).toHaveAttribute('src', `data:image/png;base64,${IMAGE_BASE64}`);
      expect((await fixture.getHostInvocations()).some(call => (
        call.module === 'sessions' && call.action === 'history'
      ))).toBe(false);
    } finally {
      await closeElectronApp(app);
    }
  });
});
