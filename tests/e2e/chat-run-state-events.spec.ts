import type { ElectronApplication } from '@playwright/test';
import {
  closeElectronApp,
  expect,
  getStableWindow,
  installAttachmentHostFixture,
  test,
} from './fixtures/electron';

const SESSION_KEY = 'agent:main:main';
const ONE_PIXEL_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const ONE_PIXEL_SVG_BASE64 = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="black"/></svg>',
).toString('base64');

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

test.describe('canonical chat run-state events', () => {
  test('renders thought and tool state transitions from the run ledger', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      const fixture = await installAttachmentHostFixture(app, {
        sessions: [{ key: SESSION_KEY, title: 'Main session' }],
      });
      await fixture.setSessionReplay(SESSION_KEY, [
        { sessionUpdate: 'user_message', messageId: 'run-user', content: [{ type: 'text', text: 'Run a long task' }] },
        {
          sessionUpdate: 'agent_thought_chunk',
          messageId: 'run-thought',
          content: { type: 'text', text: 'Need to inspect a file before answering.' },
        },
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'read-demo',
          title: 'Read demo.md',
          status: 'in_progress',
          content: [{ type: 'content', content: { type: 'text', text: 'Reading demo.md' } }],
          locations: [],
        },
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'read-demo',
          title: 'Read demo.md',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'Read complete' } }],
          locations: [],
        },
        { sessionUpdate: 'agent_message', messageId: 'run-final', content: [{ type: 'text', text: 'Task complete.' }] },
      ]);
      const page = await openChat(app);
      await expect(page.getByTestId('acp-thought-block')).toContainText('Need to inspect a file before answering.', { timeout: 30_000 });
      const card = page.getByTestId('acp-tool-call-card');
      await expect(card).toContainText('Read demo.md');
      if (await card.getAttribute('data-expanded') !== 'true') await page.getByTestId('acp-tool-toggle').click();
      await expect(card).toContainText('Read complete');
    } finally {
      await closeElectronApp(app);
    }
  });

  test('hydrates assistant images directly from canonical content blocks', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      const fixture = await installAttachmentHostFixture(app, {
        sessions: [{ key: SESSION_KEY, title: 'Main session' }],
      });
      await fixture.setSessionReplay(SESSION_KEY, [
        { sessionUpdate: 'user_message', messageId: 'image-user', content: [{ type: 'text', text: 'Generate an image' }] },
        {
          sessionUpdate: 'agent_message',
          messageId: 'image-answer',
          content: [
            { type: 'text', text: 'Generated image is ready.' },
            { type: 'image', mimeType: 'image/png', data: ONE_PIXEL_PNG_BASE64 },
          ],
        },
      ]);
      const page = await openChat(app);
      await expect(page.getByText('Generated image is ready.')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('acp-image-part').locator('img')).toHaveAttribute(
        'src',
        `data:image/png;base64,${ONE_PIXEL_PNG_BASE64}`,
      );
      await expect(page.getByTestId('image-preview-unavailable')).toHaveCount(0);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('renders tool-delivered image content inline', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      const fixture = await installAttachmentHostFixture(app, {
        sessions: [{ key: SESSION_KEY, title: 'Main session' }],
      });
      await fixture.setSessionReplay(SESSION_KEY, [
        { sessionUpdate: 'user_message', messageId: 'tool-image-user', content: [{ type: 'text', text: 'Generate a puppy image' }] },
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'message-tool',
          title: 'Send generated image',
          status: 'completed',
          content: [
            { type: 'content', content: { type: 'text', text: 'Puppy ready' } },
            { type: 'content', content: { type: 'image', mimeType: 'image/png', data: ONE_PIXEL_PNG_BASE64 } },
          ],
          locations: [],
        },
        { sessionUpdate: 'agent_message', messageId: 'tool-image-final', content: [{ type: 'text', text: 'Delivered.' }] },
      ]);
      const page = await openChat(app);
      const card = page.getByTestId('acp-tool-call-card');
      await expect(card).toContainText('Send generated image', { timeout: 30_000 });
      if (await card.getAttribute('data-expanded') !== 'true') await page.getByTestId('acp-tool-toggle').click();
      await expect(card).toContainText('Puppy ready');
      await expect(card.getByTestId('acp-image-part').locator('img')).toBeVisible();
    } finally {
      await closeElectronApp(app);
    }
  });

  test('projects a live standard image event without Gateway message fallback', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    const prompt = 'Generate a live sky image';
    try {
      const fixture = await installAttachmentHostFixture(app, {
        sessions: [{ key: SESSION_KEY, title: 'Main session' }],
      });
      await fixture.setPromptUpdates(prompt, [{
        sessionUpdate: 'agent_message',
        messageId: 'live-image',
        content: [
          { type: 'text', text: 'Here is the exact sky scene you requested.' },
          { type: 'image', mimeType: 'image/png', data: ONE_PIXEL_PNG_BASE64 },
        ],
      }]);
      const page = await openChat(app);
      await page.getByTestId('chat-composer-input').fill(prompt);
      await page.getByTestId('chat-composer-send').click();
      await expect(page.getByText('Here is the exact sky scene you requested.')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('acp-image-part').locator('img')).toBeVisible();
      expect((await fixture.getHostInvocations()).some(call => (
        call.module === 'gateway' && call.action === 'rpc'
      ))).toBe(false);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('renders a standard image-generation failure as text without an image', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      const fixture = await installAttachmentHostFixture(app, {
        sessions: [{ key: SESSION_KEY, title: 'Main session' }],
      });
      await fixture.setSessionReplay(SESSION_KEY, [
        { sessionUpdate: 'user_message', messageId: 'failure-user', content: [{ type: 'text', text: 'Generate an image' }] },
        {
          sessionUpdate: 'agent_message',
          messageId: 'failure-answer',
          content: [{ type: 'text', text: 'Image generation failed because no image model is available.' }],
        },
      ]);
      const page = await openChat(app);
      await expect(page.getByText('Image generation failed because no image model is available.')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('acp-image-part')).toHaveCount(0);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('does not interpret plain MEDIA text as an image', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    const untrustedPath = '/tmp/not-trusted.png';
    try {
      const fixture = await installAttachmentHostFixture(app, {
        sessions: [{ key: SESSION_KEY, title: 'Main session' }],
      });
      await fixture.setSessionReplay(SESSION_KEY, [
        { sessionUpdate: 'user_message', messageId: 'media-user', content: [{ type: 'text', text: 'Show the path' }] },
        { sessionUpdate: 'agent_message', messageId: 'media-answer', content: [{ type: 'text', text: `MEDIA: ${untrustedPath}` }] },
      ]);
      const page = await openChat(app);
      await expect(page.getByText(`MEDIA: ${untrustedPath}`)).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('acp-image-part')).toHaveCount(0);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('renders an SVG resource and image without legacy marker leakage', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      const fixture = await installAttachmentHostFixture(app, {
        sessions: [{ key: SESSION_KEY, title: 'Main session' }],
      });
      const filePath = await fixture.createWorkspaceFile('japan-kansai-plan.svg', Buffer.from(ONE_PIXEL_SVG_BASE64, 'base64'));
      await fixture.setSessionReplay(SESSION_KEY, [
        { sessionUpdate: 'user_message', messageId: 'svg-user', content: [{ type: 'text', text: 'Create the SVG plan' }] },
        {
          sessionUpdate: 'agent_message',
          messageId: 'svg-answer',
          content: [
            { type: 'text', text: 'SVG file is ready:' },
            { type: 'resource_link', uri: filePath, name: 'japan-kansai-plan.svg', mimeType: 'image/svg+xml' },
            { type: 'image', mimeType: 'image/svg+xml', data: ONE_PIXEL_SVG_BASE64 },
          ],
        },
      ]);
      const page = await openChat(app);
      await expect(page.getByText('SVG file is ready:')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText('MEDIA:')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Preview japan-kansai-plan.svg', exact: true })).toBeEnabled();
      await expect(page.getByTestId('acp-image-part').locator('img')).toBeVisible();
    } finally {
      await closeElectronApp(app);
    }
  });
});
