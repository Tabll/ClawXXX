import { closeElectronApp, expect, getStableWindow, installIpcMocks, test } from './fixtures/electron';

test.describe('ACP-native chat session controls', () => {
  test('updates session config, compacts context, projects metadata, and drains follow-ups sequentially', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installIpcMocks(app, {
        gatewayStatus: { state: 'running', gatewayReady: true, port: 18789, pid: 12345 },
        gatewayRpc: {
          '["sessions.list",{}]': {
            success: true,
            result: {
              ts: 1,
              sessions: [{
                key: 'agent:main:main',
                displayName: 'Main',
                workspacePath: '/tmp/clawx-acp-session-controls',
              }],
            },
          },
        },
        hostApi: {},
      });
      await app.evaluate(async () => {
        const { ipcMain } = process.mainModule!.require('electron') as typeof import('electron');
        const workspacePath = '/tmp/clawx-acp-session-controls';
        const sessionKey = 'agent:main:main';
        const requests: Array<{ action: string; payload: Record<string, unknown> | null }> = [];
        let modelValue = 'openai/gpt-5.5';
        let reasoningValue = 'medium';
        let releaseActivePrompt: ((value: { success: boolean; generation: number }) => void) | undefined;
        const originalHostInvoke = (ipcMain as unknown as {
          _invokeHandlers?: Map<string, (event: unknown, request: unknown) => Promise<unknown>>;
        })._invokeHandlers?.get('host:invoke');
        const response = (id: unknown, data: unknown) => ({
          id: typeof id === 'string' ? id : undefined,
          ok: true,
          data,
        });
        const configOptions = () => ([
          {
            id: 'session-model',
            name: 'Session model',
            category: 'model',
            type: 'select',
            currentValue: modelValue,
            options: [
              { value: 'openai/gpt-5.5', name: 'GPT-5.5' },
              { value: 'openai/gpt-5.6', name: 'GPT-5.6' },
            ],
          },
          {
            id: 'thought-level',
            name: 'Reasoning',
            category: 'thought_level',
            type: 'select',
            currentValue: reasoningValue,
            options: [
              { value: 'medium', name: 'Medium' },
              { value: 'high', name: 'High' },
            ],
          },
        ]);

        ipcMain.removeHandler('gateway:status');
        ipcMain.handle('gateway:status', async () => ({ state: 'running', port: 18789, pid: 12345, gatewayReady: true }));
        ipcMain.removeHandler('gateway:rpc');
        ipcMain.handle('gateway:rpc', async (_event: unknown, method: string) => (
          method === 'sessions.list'
            ? { success: true, result: { sessions: [{ key: sessionKey, displayName: 'Main', workspacePath }] } }
            : { success: true, result: {} }
        ));

        ipcMain.removeHandler('host:invoke');
        ipcMain.handle('host:invoke', async (event: unknown, request: {
          id?: string;
          module?: string;
          action?: string;
          payload?: Record<string, unknown>;
        }) => {
          const payload = request.payload ?? null;
          requests.push({ action: `${request.module ?? ''}:${request.action ?? ''}`, payload });
          if (request.module === 'settings' && request.action === 'getAll') {
            return response(request.id, {
              language: 'en',
              setupComplete: true,
              chatWorkspacePath: workspacePath,
              recentWorkspacePaths: [workspacePath],
            });
          }
          if (request.module === 'gateway' && request.action === 'status') {
            return response(request.id, { state: 'running', port: 18789, pid: 12345, gatewayReady: true });
          }
          if (request.module === 'gateway' && request.action === 'rpc') {
            if (payload?.method !== 'sessions.list') {
              return response(request.id, {});
            }
            return response(request.id, {
              ts: Date.now(),
              sessions: [{ key: sessionKey, displayName: 'Main', workspacePath }],
            });
          }
          if (request.module === 'files' && request.action === 'resolveWorkspaceContext') {
            return response(request.id, { ok: true, workspaceRoot: workspacePath, executionCwd: workspacePath });
          }
          if (request.module === 'agents' && request.action === 'list') {
            return response(request.id, {
              success: true,
              agents: [{
                id: 'main',
                name: 'Main',
                isDefault: true,
                modelDisplay: 'gpt-5.5',
                modelRef: 'openai/gpt-5.5',
                inheritedModel: true,
                workspace: workspacePath,
                agentDir: '~/.openclaw/agents/main/agent',
                mainSessionKey: sessionKey,
                channelTypes: [],
              }],
              defaultAgentId: 'main',
              defaultModelRef: 'openai/gpt-5.5',
              configuredChannelTypes: [],
              channelOwners: {},
              channelAccountOwners: {},
            });
          }
          if (request.module === 'providers' && ['accounts', 'list', 'accountKeyInfo', 'vendors'].includes(request.action ?? '')) {
            return response(request.id, []);
          }
          if (request.module === 'providers' && request.action === 'getDefaultAccount') {
            return response(request.id, { accountId: null });
          }
          if (request.module === 'sessions' && request.action === 'summaries') {
            return response(request.id, {
              success: true,
              summaries: [{
                sessionKey,
                firstUserText: null,
                lastTimestamp: null,
                workspacePath,
                pinned: false,
              }],
            });
          }
          if (request.module === 'sessions' && request.action === 'turnTimings') {
            return response(request.id, { success: true, timings: [] });
          }
          if (request.module === 'sessions' && request.action === 'history') {
            return response(request.id, {
              success: true,
              messages: [
                { role: 'user', content: 'Metadata question', timestamp: 1_800_000_000 },
                {
                  role: 'assistant',
                  content: 'Metadata answer',
                  timestamp: 1_800_000_001,
                  provider: 'openai',
                  model: 'gpt-5.5',
                  usage: { input: 12000, output: 640, cacheRead: 2000, cacheWrite: 500 },
                },
              ],
            });
          }
          if (request.module === 'diagnostics' && request.action === 'recordAcpTrace') {
            return response(request.id, { success: true });
          }
          if (request.module === 'chat' && request.action === 'loadAcpSession') {
            return response(request.id, {
              success: true,
              generation: 1,
              configOptions: configOptions(),
              sessionUpdates: [
                {
                  sessionKey,
                  generation: 1,
                  historical: true,
                  notification: {
                    sessionId: sessionKey,
                    update: {
                      sessionUpdate: 'user_message_chunk',
                      messageId: 'metadata-user',
                      content: { type: 'text', text: 'Metadata question' },
                    },
                  },
                },
                {
                  sessionKey,
                  generation: 1,
                  historical: true,
                  notification: {
                    sessionId: sessionKey,
                    update: {
                      sessionUpdate: 'agent_message_chunk',
                      messageId: 'metadata-assistant',
                      content: { type: 'text', text: 'Metadata answer' },
                    },
                  },
                },
                {
                  sessionKey,
                  generation: 1,
                  notification: {
                    sessionId: sessionKey,
                    update: { sessionUpdate: 'usage_update', used: 32_000, size: 128_000 },
                  },
                },
              ],
            });
          }
          if (request.module === 'chat' && request.action === 'setAcpSessionConfigOption') {
            if (payload?.configId === 'session-model' && typeof payload.value === 'string') modelValue = payload.value;
            if (payload?.configId === 'thought-level' && typeof payload.value === 'string') reasoningValue = payload.value;
            return response(request.id, { success: true, generation: 1, configOptions: configOptions() });
          }
          if (request.module === 'chat' && request.action === 'sendAcpPrompt') {
            if (payload?.message === 'Hold the active run') {
              const result = await new Promise<{ success: boolean; generation: number }>((resolve) => {
                releaseActivePrompt = resolve;
              });
              return response(request.id, result);
            }
            return response(request.id, { success: true, generation: 1 });
          }
          if (request.module === 'chat' && request.action === 'cancelAcpSession') {
            return response(request.id, { success: true, generation: 1 });
          }
          return originalHostInvoke?.(event, request) ?? response(request.id, {});
        });

        Object.assign(globalThis, {
          __acpSessionControlRequests: requests,
          __releaseAcpSessionPrompt: () => releaseActivePrompt?.({ success: true, generation: 1 }),
        });
      });

      const page = await getStableWindow(app);
      await page.reload();
      await expect(page.getByTestId('main-layout')).toBeVisible();
      const targetSession = page.getByTestId('sidebar-session-agent:main:main');
      await expect(targetSession).toBeVisible();
      await page.getByTestId('sidebar-new-chat').click();
      await expect(page.getByTestId('chat-page')).toBeVisible();
      const loadsBeforeTargetSelection = await app.evaluate(() => (
        (globalThis as typeof globalThis & {
          __acpSessionControlRequests?: Array<{ action: string }>;
        }).__acpSessionControlRequests?.filter((entry) => entry.action === 'chat:loadAcpSession').length ?? 0
      ));
      await targetSession.click();
      await expect(page.getByTestId('chat-page')).toBeVisible();
      await expect.poll(async () => app.evaluate(() => (
        (globalThis as typeof globalThis & {
          __acpSessionControlRequests?: Array<{ action: string }>;
        }).__acpSessionControlRequests?.filter((entry) => entry.action === 'chat:loadAcpSession').length ?? 0
      ))).toBeGreaterThan(loadsBeforeTargetSelection);
      await expect(page.getByText('Metadata answer')).toBeVisible();
      await expect(page.getByTestId('chat-model-picker-button')).toContainText('GPT-5.5');
      await expect.poll(async () => app.evaluate(() => (
        (globalThis as typeof globalThis & {
          __acpSessionControlRequests?: Array<{ action: string; payload: Record<string, unknown> | null }>;
        }).__acpSessionControlRequests?.some((entry) => (
          entry.action === 'diagnostics:recordAcpTrace'
          && entry.payload?.event === 'openclaw-media:history-request-succeeded'
          && (entry.payload?.details as Record<string, unknown> | undefined)?.assistantMetadataCount === 1
        )) ?? false
      ))).toBe(true);
      await page.getByTestId('acp-assistant-message').hover();
      await expect(page.getByTestId('acp-assistant-metadata')).toContainText('openai/gpt-5.5');
      await expect(page.getByTestId('acp-assistant-metadata')).toContainText('12K');
      await expect(page.getByTestId('acp-assistant-metadata')).toContainText('2.5K');

      await page.getByTestId('chat-model-picker-button').click();
      await page.getByTestId('chat-model-picker-menu').getByRole('button', { name: 'GPT-5.6' }).click();
      await expect(page.getByTestId('chat-model-picker-button')).toContainText('GPT-5.6');
      await page.getByTestId('chat-reasoning-picker-button').click();
      await page.getByTestId('chat-reasoning-picker-menu').getByRole('button', { name: 'High' }).click();
      await expect(page.getByTestId('chat-reasoning-picker-button')).toContainText('High');

      await expect(page.getByTestId('chat-context-usage')).toHaveAccessibleName(/25%/);
      await page.getByTestId('chat-context-usage').click();
      await expect.poll(async () => app.evaluate(() => (
        (globalThis as typeof globalThis & {
          __acpSessionControlRequests?: Array<{ action: string; payload: Record<string, unknown> | null }>;
        }).__acpSessionControlRequests?.some((entry) => (
          entry.action === 'chat:sendAcpPrompt' && entry.payload?.message === '/compact'
        )) ?? false
      ))).toBe(true);

      const input = page.getByTestId('chat-composer-input');
      await input.fill('Hold the active run');
      await page.getByTestId('chat-composer-send').click();
      await expect(page.getByTestId('chat-composer-send')).toHaveAttribute('title', 'Stop');
      await input.fill('Queued follow-up');
      await page.getByTestId('chat-composer-queue').click();
      await expect(page.getByTestId('chat-follow-up-queue')).toContainText('Queued follow-up');

      await app.evaluate(() => {
        (globalThis as typeof globalThis & { __releaseAcpSessionPrompt?: () => void }).__releaseAcpSessionPrompt?.();
      });
      await expect(page.getByTestId('chat-follow-up-queue')).not.toBeVisible();
      await expect(page.getByTestId('chat-composer-send')).toHaveAttribute('title', 'Send');

      const requests = await app.evaluate(() => (
        (globalThis as typeof globalThis & {
          __acpSessionControlRequests?: Array<{ action: string; payload: Record<string, unknown> | null }>;
        }).__acpSessionControlRequests ?? []
      ));
      const promptMessages = requests
        .filter((entry) => entry.action === 'chat:sendAcpPrompt')
        .map((entry) => entry.payload?.message);
      expect(promptMessages).toEqual(['/compact', 'Hold the active run', 'Queued follow-up']);
      expect(requests.some((entry) => entry.action === 'agents:updateModel')).toBe(false);
      expect(requests).toEqual(expect.arrayContaining([
        expect.objectContaining({
          action: 'chat:setAcpSessionConfigOption',
          payload: expect.objectContaining({ configId: 'session-model', value: 'openai/gpt-5.6' }),
        }),
        expect.objectContaining({
          action: 'chat:setAcpSessionConfigOption',
          payload: expect.objectContaining({ configId: 'thought-level', value: 'high' }),
        }),
      ]));
    } finally {
      await closeElectronApp(app);
    }
  });
});
