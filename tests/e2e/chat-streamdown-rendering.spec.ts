import type { ElectronApplication } from '@playwright/test';
import { closeElectronApp, expect, getStableWindow, installIpcMocks, test } from './fixtures/electron';
import { E2E_EXCLUSIVE_TAG } from './parallel-policy';

const SESSION_KEY = 'agent:main:main';
const MAIN_WORKSPACE = '/workspace';

type AcpSessionUpdate = Record<string, unknown> & { sessionUpdate: string };

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);
  return `{${entries.join(',')}}`;
}

async function emitAcpSessionUpdates(
  app: ElectronApplication,
  updates: AcpSessionUpdate[],
) {
  await app.evaluate(
    async ({ app: _app }, payload) => {
      const { BrowserWindow } = process.mainModule!.require('electron') as typeof import('electron');
      const pending = globalThis as typeof globalThis & {
        streamdownRun?: {
          conversationId: string;
          turnId: string;
          runId: string;
          kernelId: string;
          generation: number;
          eventSeq: number;
        };
      };
      const run = pending.streamdownRun;
      if (!run) throw new Error('Streamdown run identity is not available');
      for (const update of payload.updates) {
        const content = update.content;
        const text = Array.isArray(content)
          ? content.map(part => (
              part && typeof part === 'object' && typeof part.text === 'string' ? part.text : ''
            )).join('')
          : content && typeof content === 'object' && typeof content.text === 'string'
            ? content.text
            : '';
        const kind = update.sessionUpdate === 'agent_message_chunk'
          ? 'assistant.delta'
          : update.sessionUpdate === 'agent_message'
            ? 'assistant.final'
            : null;
        if (!kind) throw new Error(`Unsupported Streamdown fixture update: ${update.sessionUpdate}`);
        run.eventSeq += 1;
        for (const window of BrowserWindow.getAllWindows()) {
          window.webContents.send('chat:kernel-event', {
            protocol: 'clawx.kernel/v1',
            conversationId: run.conversationId,
            turnId: run.turnId,
            runId: run.runId,
            kernelId: run.kernelId,
            generation: run.generation,
            eventSeq: run.eventSeq,
            emittedAt: new Date().toISOString(),
            event: { kind, payload: { text } },
          });
        }
      }
    },
    { sessionKey: SESSION_KEY, updates },
  );
}

async function deferAcpPrompt(app: ElectronApplication) {
  await app.evaluate(async ({ app: _app }) => {
    const { ipcMain } = process.mainModule!.require('electron') as typeof import('electron');
    type HostRequest = { id?: string; module?: string; action?: string; payload?: Record<string, unknown> };
    type HostInvokeHandler = (event: unknown, request: HostRequest) => Promise<unknown>;
    const currentHostInvoke = (ipcMain as unknown as {
      _invokeHandlers?: Map<string, HostInvokeHandler>;
    })._invokeHandlers?.get('host:invoke');
    const pending = globalThis as typeof globalThis & {
      resolveStreamdownPrompt?: () => void;
      streamdownRun?: {
        conversationId: string;
        turnId: string;
        runId: string;
        kernelId: string;
        generation: number;
        eventSeq: number;
      };
    };

    ipcMain.removeHandler('host:invoke');
    ipcMain.handle('host:invoke', async (event: unknown, request: HostRequest) => {
      if (request?.module === 'chat' && request.action === 'sendAcpPrompt') {
        const payload = request.payload ?? {};
        pending.streamdownRun = {
          conversationId: String(payload.conversationId ?? payload.sessionKey ?? ''),
          turnId: String(payload.turnId ?? ''),
          runId: String(payload.runId ?? ''),
          kernelId: String(payload.kernelId ?? 'openclaw'),
          generation: Number(payload.generation ?? 1),
          eventSeq: 0,
        };
        return await new Promise((resolve) => {
          pending.resolveStreamdownPrompt = () => resolve({
            id: request.id,
            ok: true,
            data: { success: true, generation: 1 },
          });
        });
      }
      return currentHostInvoke?.(event, request) ?? { ok: true, data: {} };
    });
  });
}

async function resolveAcpPrompt(app: ElectronApplication) {
  await app.evaluate(async ({ app: _app }) => {
    const pending = globalThis as typeof globalThis & { resolveStreamdownPrompt?: () => void };
    const resolvePrompt = pending.resolveStreamdownPrompt;
    if (!resolvePrompt) throw new Error('Deferred Streamdown prompt was not pending');
    delete pending.resolveStreamdownPrompt;
    resolvePrompt();
  });
}

test.describe('ClawX streaming Markdown rendering', { tag: E2E_EXCLUSIVE_TAG }, () => {
  test('repairs and animates only the pending assistant response, then clears animation markers', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      const summary = {
        id: SESSION_KEY,
        title: 'Streamdown fixture',
        createdAt: '2026-08-24T00:00:00.000Z',
        updatedAt: '2026-08-24T00:00:01.000Z',
        workspaceUri: `file://${MAIN_WORKSPACE}`,
        lastKernelId: 'openclaw',
        kernelIds: ['openclaw'],
        lastAgentId: 'main',
      };
      await installIpcMocks(app, {
        gatewayStatus: { state: 'running', port: 18789, pid: 12345, gatewayReady: true },
        kernelFixture: {
          catalog: {
            source: 'network',
            stale: false,
            refreshedAt: '2026-08-24T00:00:00.000Z',
            entries: [{
              kernelId: 'openclaw',
              displayName: 'OpenClaw',
              installation: {
                kernelId: 'openclaw',
                state: 'installed',
                activeVersion: '2026.8.1-clawx.1',
                updatedAt: '2026-08-24T00:00:00.000Z',
              },
              runtime: {
                kernelId: 'openclaw',
                state: 'ready',
                generation: 1,
                artifactVersion: '2026.8.1-clawx.1',
                diagnostics: [],
              },
              updateAvailable: false,
              installAllowed: true,
              compatibilityFailures: [],
            }],
          },
          runtimes: [{
            kernelId: 'openclaw',
            state: 'ready',
            generation: 1,
            artifactVersion: '2026.8.1-clawx.1',
            diagnostics: [],
          }],
        },
        hostApi: {
          [stableStringify(['settings', 'getAll', null])]: {
            language: 'en',
            setupComplete: true,
            chatWorkspacePath: MAIN_WORKSPACE,
            recentWorkspacePaths: [MAIN_WORKSPACE],
          },
          [stableStringify(['conversations', 'list', { limit: 100 }])]: {
            items: [summary],
          },
          [stableStringify(['conversations', 'get', { id: SESSION_KEY }])]: {
            schema: 'clawx.conversation-export/v1',
            conversation: summary,
            turns: [{
              id: 'completed-assistant',
              role: 'assistant',
              position: 0,
              createdAt: '2026-08-24T00:00:01.000Z',
              blocks: [{
                id: 'completed-assistant-text',
                type: 'text',
                visibility: 'portable',
                text: 'Earlier completed answer.',
              }],
            }],
            runs: [],
            usage: [],
          },
          [stableStringify(['chat', 'selectConversationKernel', {
            sessionKey: SESSION_KEY,
            workspaceRoot: MAIN_WORKSPACE,
            cwd: MAIN_WORKSPACE,
            kernelId: 'openclaw',
          }])]: {
            success: true,
            generation: 1,
            kernelId: 'openclaw',
          },
          [stableStringify(['files', 'resolveWorkspaceContext', {
            workspaceRoot: MAIN_WORKSPACE,
            executionCwd: MAIN_WORKSPACE,
          }])]: {
            ok: true,
            workspaceRoot: MAIN_WORKSPACE,
            executionCwd: MAIN_WORKSPACE,
          },
          [stableStringify(['agents', 'list', null])]: {
            success: true,
            agents: [{
              id: 'main',
              name: 'main',
              workspace: MAIN_WORKSPACE,
              mainSessionKey: SESSION_KEY,
              supportedKernels: ['openclaw'],
              defaultForKernels: ['openclaw'],
              projections: [],
              channelTypes: [],
            }],
            defaultAgentId: 'main',
            configuredChannelTypes: [],
            channelOwners: {},
            channelAccountOwners: {},
          },
          [stableStringify(['providers', 'accounts', null])]: [],
          [stableStringify(['providers', 'accountKeyInfo', null])]: [],
          [stableStringify(['providers', 'vendors', null])]: [],
          [stableStringify(['providers', 'getDefaultAccount', null])]: { accountId: null },
          [stableStringify(['providers', 'kernelDefaults', null])]: [],
        },
      });
      await deferAcpPrompt(app);

      const page = await getStableWindow(app);
      try {
        await page.reload();
      } catch (error) {
        if (!String(error).includes('ERR_FILE_NOT_FOUND')) throw error;
      }

      await expect(page.getByTestId('main-layout')).toBeVisible();
      await expect(page.getByText('Earlier completed answer.')).toBeVisible({ timeout: 30_000 });

      await page.getByTestId('chat-composer-input').fill('Stream a Markdown response');
      await page.getByTestId('chat-composer-send').click();
      await expect(page.getByTestId('chat-composer-send')).toHaveAttribute('title', 'Stop');

      await emitAcpSessionUpdates(app, [{
        sessionUpdate: 'agent_message_chunk',
        messageId: 'streamdown-assistant',
        content: { type: 'text', text: 'Streaming **bold' },
      }]);

      const activeMessage = page.getByTestId('acp-assistant-message').filter({ hasText: 'Streaming' });
      const completedMessage = page.getByTestId('acp-assistant-message').filter({ hasText: 'Earlier completed answer.' });
      await expect(activeMessage.locator('strong')).toHaveText('bold', { timeout: 30_000 });

      const firstWord = activeMessage.locator('[data-sd-animate]').filter({ hasText: /^Streaming$/ });
      await expect(firstWord).toHaveCount(1);
      await expect(firstWord).toHaveCSS('--sd-duration', '140ms');
      await expect(completedMessage.locator('[data-sd-animate]')).toHaveCount(0);

      await emitAcpSessionUpdates(app, [{
        sessionUpdate: 'agent_message_chunk',
        messageId: 'streamdown-assistant',
        content: {
          type: 'text',
          text: '** words with `inlineCode()`, https://example.com。后续, [docs](https://example.org), and <script>rawAlert()</script>',
        },
      }]);
      await expect(activeMessage.locator('code').filter({ hasText: 'inlineCode()' })).toBeVisible();
      await expect(activeMessage.getByText('https://example.com', { exact: true })).toBeVisible();
      await expect(activeMessage).toContainText('。后续');
      const newWord = activeMessage.locator('[data-sd-animate]').filter({ hasText: /^words$/ });
      await expect(newWord).toHaveCount(1);
      await expect(newWord).toHaveCSS('--sd-duration', '140ms');
      await expect(firstWord).toHaveCount(1);
      await expect(firstWord).toHaveCSS('--sd-duration', '0ms');
      await expect(activeMessage.locator('a')).toHaveCount(0);
      await expect(activeMessage.getByText('docs', { exact: true })).toBeVisible();
      await expect(activeMessage).toContainText('<script>rawAlert()</script>');
      await expect(activeMessage.locator('script')).toHaveCount(0);

      await emitAcpSessionUpdates(app, [{
        sessionUpdate: 'agent_message_chunk',
        messageId: 'streamdown-assistant',
        content: { type: 'text', text: '\n\n```javascript\nconst answer = 42;' },
      }]);
      await expect(activeMessage).toContainText('Streaming bold words');
      const incompleteCodeBlock = activeMessage.locator('[data-streamdown="code-block"][data-incomplete="true"]');
      await expect(incompleteCodeBlock).toBeVisible();
      await expect(incompleteCodeBlock).toContainText('const answer = 42;');

      await emitAcpSessionUpdates(app, [{
        sessionUpdate: 'agent_message_chunk',
        messageId: 'streamdown-assistant',
        content: { type: 'text', text: '\n```' },
      }]);
      await expect(activeMessage.locator('[data-streamdown="code-block"][data-incomplete="true"]')).toHaveCount(0);
      await expect(activeMessage.locator('pre span[style*="--sdm-c"]').first()).toBeVisible({ timeout: 30_000 });

      await emitAcpSessionUpdates(app, [{
        sessionUpdate: 'agent_message_chunk',
        messageId: 'streamdown-assistant',
        content: {
          type: 'text',
          text: '\n\n## Spaced heading\n\n---\n\n- compact one\n- compact two\n\nFinal streamed text.',
        },
      }]);
      await expect(activeMessage).toContainText('Final streamed text.');
      await expect(activeMessage.locator('.clawx-streamdown')).not.toHaveClass(/space-y-0/);

      const headingMargins = await activeMessage.getByRole('heading', { name: 'Spaced heading' }).evaluate((element) => {
        const style = window.getComputedStyle(element);
        return [Number.parseFloat(style.marginTop), Number.parseFloat(style.marginBottom)];
      });
      expect(headingMargins[0]).toBeGreaterThan(0);
      expect(headingMargins[1]).toBeGreaterThan(0);
      const ruleMargins = await activeMessage.locator('hr').evaluate((element) => {
        const style = window.getComputedStyle(element);
        return [Number.parseFloat(style.marginTop), Number.parseFloat(style.marginBottom)];
      });
      expect(ruleMargins[0]).toBeGreaterThan(0);
      expect(ruleMargins[1]).toBeGreaterThan(0);

      const compactItems = activeMessage.locator('[data-streamdown="list-item"]').filter({ hasText: /compact/ });
      const compactGap = await compactItems.evaluateAll((items) => {
        const firstRect = items[0].getBoundingClientRect();
        const secondRect = items[1].getBoundingClientRect();
        return secondRect.top - firstRect.bottom;
      });
      expect(compactGap).toBeLessThanOrEqual(2);
      const compactPadding = await compactItems.first().evaluate((element) => {
        const style = window.getComputedStyle(element);
        return [Number.parseFloat(style.paddingTop), Number.parseFloat(style.paddingBottom)];
      });
      expect(compactPadding).toEqual([2, 2]);

      const codeBlock = activeMessage.locator('[data-streamdown="code-block"]');
      const codeHeader = codeBlock.locator('[data-streamdown="code-block-header"]');
      await expect(codeHeader).toHaveCSS('justify-content', 'flex-end');
      expect(await codeHeader.evaluate((element) => element.getBoundingClientRect().height)).toBe(28);
      const copyCode = codeBlock.getByTitle('Copy code');
      await expect(copyCode).toBeDisabled();
      expect(await codeHeader.evaluate((header, button) => {
        const headerRect = header.getBoundingClientRect();
        const buttonRect = (button as Element).getBoundingClientRect();
        return Math.abs(
          (headerRect.top + headerRect.height / 2) - (buttonRect.top + buttonRect.height / 2),
        );
      }, await copyCode.elementHandle())).toBeLessThanOrEqual(1);

      await resolveAcpPrompt(app);
      await expect(page.getByTestId('chat-composer-send')).toHaveAttribute('title', 'Send');
      await expect(activeMessage.locator('[data-sd-animate]')).toHaveCount(0);
      await expect(activeMessage).toContainText('Streaming bold words');
      await expect(activeMessage).toContainText('Final streamed text.');
      await expect(copyCode).toBeEnabled();
      await copyCode.click();
      await expect.poll(() => page.evaluate(async () => (await navigator.clipboard.readText()).trim()))
        .toBe('const answer = 42;');
    } finally {
      await closeElectronApp(app);
    }
  });
});
