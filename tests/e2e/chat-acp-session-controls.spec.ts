import {
  closeElectronApp,
  emitKernelEvents,
  expect,
  getStableWindow,
  installIpcMocks,
  test,
} from './fixtures/electron';

test.describe('canonical multi-kernel chat session controls', () => {
  test('continues one SQLite conversation OpenClaw → DSH → OpenClaw without leaking private context', async ({ launchElectronApp }) => {
    const conversationId = 'agent:main:canonical-conversation';
    const app = await launchElectronApp({ skipSetup: true });

    try {
      const page = await getStableWindow(app);
      await installIpcMocks(app, {
        gatewayStatus: { state: 'running', gatewayReady: true, port: 18789, pid: 12345 },
        gatewayRpc: {},
        hostApi: {},
        kernelFixture: {
          catalog: {
            source: 'network',
            stale: false,
            refreshedAt: '2026-08-24T00:00:00.000Z',
            entries: [
              {
                kernelId: 'openclaw',
                displayName: 'OpenClaw',
                installation: { kernelId: 'openclaw', state: 'installed', activeVersion: '2026.8.1-clawx.1', updatedAt: '2026-08-24T00:00:00.000Z' },
                runtime: { kernelId: 'openclaw', state: 'ready', generation: 1, artifactVersion: '2026.8.1-clawx.1', diagnostics: [] },
                updateAvailable: false,
                installAllowed: true,
                compatibilityFailures: [],
              },
              {
                kernelId: 'deepseek-harness',
                displayName: 'DeepSeek Harness',
                installation: { kernelId: 'deepseek-harness', state: 'installed', activeVersion: '0.1.0-clawx.1', updatedAt: '2026-08-24T00:00:00.000Z' },
                runtime: { kernelId: 'deepseek-harness', state: 'ready', generation: 1, artifactVersion: '0.1.0-clawx.1', diagnostics: [] },
                updateAvailable: false,
                installAllowed: true,
                compatibilityFailures: [],
              },
            ],
          },
          runtimes: [
            { kernelId: 'openclaw', state: 'ready', generation: 1, artifactVersion: '2026.8.1-clawx.1', diagnostics: [] },
            { kernelId: 'deepseek-harness', state: 'ready', generation: 1, artifactVersion: '0.1.0-clawx.1', diagnostics: [] },
          ],
        },
      });
      await app.evaluate(async () => {
        const { ipcMain } = process.mainModule!.require('electron') as typeof import('electron');
        const workspacePath = '/tmp/clawx-acp-session-controls';
        const conversationId = 'agent:main:canonical-conversation';
        const requests: Array<{ action: string; payload: Record<string, unknown> | null }> = [];
        let modelValue = 'openai/gpt-5.5';
        let reasoningValue = 'medium';
        let releaseActivePrompt: ((value: Record<string, unknown>) => void) | undefined;
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
        const conversationSummary = {
          id: conversationId,
          title: 'Canonical metadata chat',
          createdAt: '2026-08-23T10:00:00.000Z',
          updatedAt: '2026-08-23T10:00:06.000Z',
          workspaceUri: `file://${workspacePath}`,
          lastKernelId: 'openclaw',
        };
        const conversationExport = {
          schema: 'clawx.conversation-export/v1',
          conversation: conversationSummary,
          turns: [
            {
              id: 'turn-user-history',
              role: 'user',
              position: 0,
              createdAt: '2026-08-23T10:00:01.000Z',
              blocks: [{
                id: 'user-text',
                type: 'text',
                visibility: 'portable',
                text: 'Metadata question',
              }],
            },
            {
              id: 'turn-assistant-history',
              role: 'assistant',
              position: 1,
              createdAt: '2026-08-23T10:00:06.000Z',
              blocks: [{
                id: 'assistant-text',
                type: 'text',
                visibility: 'portable',
                text: 'Metadata answer',
              }, {
                id: 'assistant-private-reasoning',
                type: 'metadata',
                visibility: 'private',
                json: { thought: 'never-cross-private-reasoning' },
              }, {
                id: 'assistant-secret-reference',
                type: 'metadata',
                visibility: 'secret',
                json: { credentialRef: 'keychain://never-cross-secret' },
              }],
            },
          ],
          runs: [{
            id: 'run-history',
            turnId: 'turn-user-history',
            assistantTurnId: 'turn-assistant-history',
            kernelId: 'openclaw',
            kernelVersion: '2026.8.1-clawx.1',
            generation: 1,
            agentId: 'main',
            agentSnapshot: {
              agentId: 'main',
              displayName: 'Main',
              kernelId: 'openclaw',
              workspaceUri: `file://${workspacePath}`,
              canonicalVersion: 1,
            },
            workspaceUri: `file://${workspacePath}`,
            providerId: 'openai',
            modelId: 'gpt-5.5',
            status: 'completed',
            createdAt: '2026-08-23T10:00:01.000Z',
            startedAt: '2026-08-23T10:00:02.000Z',
            completedAt: '2026-08-23T10:00:06.000Z',
            events: [{
              eventSeq: 1,
              kind: 'usage',
              payload: { used: 32_000, size: 128_000 },
              emittedAt: '2026-08-23T10:00:05.000Z',
              nativeEventId: 'openclaw-native-usage-1',
            }],
          }],
          usage: [{
            runId: 'run-history',
            inputTokens: 12_000,
            outputTokens: 640,
            cacheReadTokens: 2_000,
            cacheWriteTokens: 500,
          }],
        };

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
            return response(request.id, {
              state: 'running', port: 18789, pid: 12345, gatewayReady: true,
            });
          }
          if (request.module === 'gateway' && request.action === 'rpc') {
            return response(request.id, {});
          }
          if (request.module === 'conversations' && request.action === 'list') {
            return response(request.id, { items: [conversationSummary] });
          }
          if (request.module === 'conversations' && request.action === 'get') {
            return response(request.id, conversationExport);
          }
          if (request.module === 'files' && request.action === 'resolveWorkspaceContext') {
            return response(request.id, {
              ok: true, workspaceRoot: workspacePath, executionCwd: workspacePath,
            });
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
                agentDir: '~/.clawx/kernel-config/openclaw/agents/main/agent',
                mainSessionKey: conversationId,
                channelTypes: [],
              }],
              defaultAgentId: 'main',
              defaultModelRef: 'openai/gpt-5.5',
              configuredChannelTypes: [],
              channelOwners: {},
              channelAccountOwners: {},
            });
          }
          if (request.module === 'providers'
            && ['accounts', 'list', 'accountKeyInfo', 'vendors'].includes(request.action ?? '')) {
            return response(request.id, []);
          }
          if (request.module === 'providers' && request.action === 'getDefaultAccount') {
            return response(request.id, { accountId: null });
          }
          if (request.module === 'providers' && request.action === 'kernelDefaults') {
            return response(request.id, []);
          }
          if (request.module === 'chat' && request.action === 'selectConversationKernel') {
            const kernelId = typeof payload?.kernelId === 'string' ? payload.kernelId : 'openclaw';
            return response(request.id, {
              success: true,
              generation: 1,
              kernelId,
              configOptions: configOptions(),
            });
          }
          if (request.module === 'chat' && request.action === 'setAcpSessionConfigOption') {
            if (payload?.configId === 'session-model' && typeof payload.value === 'string') {
              modelValue = payload.value;
            }
            if (payload?.configId === 'thought-level' && typeof payload.value === 'string') {
              reasoningValue = payload.value;
            }
            return response(request.id, {
              success: true,
              generation: 1,
              kernelId: 'openclaw',
              configOptions: configOptions(),
            });
          }
          if (request.module === 'chat' && request.action === 'sendAcpPrompt') {
            if (payload?.message === 'Hold the active run') {
              const result = await new Promise<Record<string, unknown>>((resolve) => {
                releaseActivePrompt = resolve;
              });
              return response(request.id, result);
            }
            return response(request.id, {
              success: true,
              generation: 1,
              kernelId: typeof payload?.kernelId === 'string' ? payload.kernelId : 'openclaw',
            });
          }
          if (request.module === 'chat' && request.action === 'cancelAcpSession') {
            return response(request.id, { success: true, generation: 1, kernelId: 'openclaw' });
          }
          if (request.module === 'chat' && request.action === 'respondAcpPermission') {
            return response(request.id, {
              success: true,
              generation: 1,
              conversationId: payload?.conversationId,
              turnId: payload?.turnId,
              runId: payload?.runId,
              kernelId: payload?.kernelId,
            });
          }
          return originalHostInvoke?.(event, request) ?? response(request.id, {});
        });

        Object.assign(globalThis, {
          __canonicalChatRequests: requests,
          __releaseCanonicalPrompt: () => releaseActivePrompt?.({
            success: true, generation: 1, kernelId: 'openclaw',
          }),
        });
      });

      await page.reload();
      await expect(page.getByTestId('main-layout')).toBeVisible();
      const targetSession = page.getByTestId('sidebar-session-agent:main:canonical-conversation');
      await expect(targetSession).toBeVisible();

      await page.getByTestId('sidebar-new-chat').click();
      const selectionsBefore = await app.evaluate(() => (
        (globalThis as typeof globalThis & {
          __canonicalChatRequests?: Array<{ action: string }>;
        }).__canonicalChatRequests?.filter(
          (entry) => entry.action === 'chat:selectConversationKernel',
        ).length ?? 0
      ));
      await targetSession.click();
      await expect.poll(async () => app.evaluate(() => (
        (globalThis as typeof globalThis & {
          __canonicalChatRequests?: Array<{ action: string }>;
        }).__canonicalChatRequests?.filter(
          (entry) => entry.action === 'chat:selectConversationKernel',
        ).length ?? 0
      ))).toBeGreaterThan(selectionsBefore);

      await expect(page.getByText('Metadata question')).toBeVisible();
      await expect(page.getByText('Metadata answer')).toBeVisible();
      await expect(page.getByTestId('chat-model-picker-button')).toContainText('GPT-5.5');
      await page.getByTestId('acp-assistant-message').hover();
      const provenance = page.getByTestId('acp-assistant-kernel-provenance');
      await expect(provenance).toContainText('openclaw');
      await expect(provenance).toHaveAttribute('title', 'openclaw · 2026.8.1-clawx.1');
      await expect(page.getByTestId('acp-assistant-metadata')).toContainText('openai/gpt-5.5');
      await expect(page.getByTestId('acp-assistant-metadata')).toContainText('12K');
      await expect(page.getByTestId('acp-assistant-metadata')).toContainText('2.5K');

      const input = page.getByTestId('chat-composer-input');
      const kernelSelector = page.getByTestId('chat-kernel-selector');
      await expect(kernelSelector).toHaveValue('openclaw');
      await kernelSelector.selectOption('deepseek-harness');
      await expect(page.getByTestId('chat-kernel-boundary')).toContainText('OpenClaw');
      await expect(page.getByTestId('chat-kernel-boundary')).toContainText('DeepSeek Harness');
      await expect(page.getByText('Metadata question')).toBeVisible();
      await expect(page.getByText('Metadata answer')).toBeVisible();
      await input.fill('Continue on DeepSeek Harness');
      await page.getByTestId('chat-composer-send').click();
      await expect.poll(async () => app.evaluate(() => (
        (globalThis as typeof globalThis & {
          __canonicalChatRequests?: Array<{ action: string; payload: Record<string, unknown> | null }>;
        }).__canonicalChatRequests?.some((entry) => (
          entry.action === 'chat:sendAcpPrompt'
          && entry.payload?.message === 'Continue on DeepSeek Harness'
          && entry.payload?.kernelId === 'deepseek-harness'
        )) ?? false
      ))).toBe(true);

      await kernelSelector.selectOption('openclaw');
      await expect(page.getByTestId('chat-kernel-boundary')).toHaveCount(0);
      await expect(page.getByText('Metadata question')).toBeVisible();
      await expect(page.getByText('Metadata answer')).toBeVisible();
      await input.fill('Return to OpenClaw');
      await page.getByTestId('chat-composer-send').click();
      await expect.poll(async () => app.evaluate(() => (
        (globalThis as typeof globalThis & {
          __canonicalChatRequests?: Array<{ action: string; payload: Record<string, unknown> | null }>;
        }).__canonicalChatRequests?.some((entry) => (
          entry.action === 'chat:sendAcpPrompt'
          && entry.payload?.message === 'Return to OpenClaw'
          && entry.payload?.kernelId === 'openclaw'
        )) ?? false
      ))).toBe(true);

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
          __canonicalChatRequests?: Array<{ action: string; payload: Record<string, unknown> | null }>;
        }).__canonicalChatRequests?.some((entry) => (
          entry.action === 'chat:sendAcpPrompt'
          && entry.payload?.message === '/compact'
          && entry.payload?.kernelId === 'openclaw'
        )) ?? false
      ))).toBe(true);

      await input.fill('Hold the active run');
      await page.getByTestId('chat-composer-send').click();
      await expect(page.getByTestId('chat-composer-send')).toHaveAttribute('title', 'Stop');
      const activeRun = await expect.poll(async () => app.evaluate(() => {
        const requests = (globalThis as typeof globalThis & {
          __canonicalChatRequests?: Array<{ action: string; payload: Record<string, unknown> | null }>;
        }).__canonicalChatRequests ?? [];
        return requests.findLast((entry) => (
          entry.action === 'chat:sendAcpPrompt' && entry.payload?.message === 'Hold the active run'
        ))?.payload ?? null;
      })).not.toBeNull().then(async () => app.evaluate(() => {
        const requests = (globalThis as typeof globalThis & {
          __canonicalChatRequests?: Array<{ action: string; payload: Record<string, unknown> | null }>;
        }).__canonicalChatRequests ?? [];
        return requests.findLast((entry) => (
          entry.action === 'chat:sendAcpPrompt' && entry.payload?.message === 'Hold the active run'
        ))?.payload ?? null;
      }));
      if (!activeRun) throw new Error('Active OpenClaw run identity was not recorded');
      await emitKernelEvents(app, [{
        protocol: 'clawx.kernel/v1',
        conversationId: String(activeRun.conversationId),
        turnId: String(activeRun.turnId),
        runId: String(activeRun.runId),
        kernelId: String(activeRun.kernelId),
        generation: Number(activeRun.generation),
        eventSeq: 1,
        emittedAt: '2026-08-24T00:00:07.000Z',
        event: {
          kind: 'permission.request',
          payload: {
            requestId: 'permission-openclaw-write',
            toolCall: { toolCallId: 'write-file', title: 'Allow workspace write?' },
            options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow' }],
          },
        },
      }]);
      const permissionCard = page.getByTestId('acp-permission-card');
      await expect(permissionCard).toContainText('Allow workspace write?');
      await permissionCard.getByRole('button', { name: 'Allow once' }).click();
      await expect(permissionCard).toContainText('Completed');
      await input.fill('Queued follow-up');
      await page.getByTestId('chat-composer-queue').click();
      await expect(page.getByTestId('chat-follow-up-queue')).toContainText('Queued follow-up');

      await app.evaluate(() => {
        (globalThis as typeof globalThis & { __releaseCanonicalPrompt?: () => void })
          .__releaseCanonicalPrompt?.();
      });
      await expect(page.getByTestId('chat-follow-up-queue')).not.toBeVisible();
      await expect(page.getByTestId('chat-composer-send')).toHaveAttribute('title', 'Send');

      const requests = await app.evaluate(() => (
        (globalThis as typeof globalThis & {
          __canonicalChatRequests?: Array<{ action: string; payload: Record<string, unknown> | null }>;
        }).__canonicalChatRequests ?? []
      ));
      expect(requests.some((entry) => entry.action === 'conversations:get')).toBe(true);
      expect(requests.some((entry) => entry.action === 'sessions:history')).toBe(false);
      expect(requests.some((entry) => entry.action === 'chat:loadAcpSession')).toBe(false);
      const promptRequests = requests.filter((entry) => entry.action === 'chat:sendAcpPrompt');
      expect(promptRequests.map((entry) => entry.payload?.message))
        .toEqual([
          'Continue on DeepSeek Harness',
          'Return to OpenClaw',
          '/compact',
          'Hold the active run',
          'Queued follow-up',
        ]);
      expect(promptRequests.every((entry) => (
        entry.payload?.conversationId === conversationId
        && typeof entry.payload?.runId === 'string'
        && typeof entry.payload?.turnId === 'string'
      ))).toBe(true);
      expect(promptRequests.map(entry => entry.payload?.kernelId)).toEqual([
        'deepseek-harness',
        'openclaw',
        'openclaw',
        'openclaw',
        'openclaw',
      ]);
      expect(requests).toEqual(expect.arrayContaining([
        expect.objectContaining({
          action: 'chat:respondAcpPermission',
          payload: expect.objectContaining({
            conversationId,
            kernelId: 'openclaw',
            runId: activeRun.runId,
            turnId: activeRun.turnId,
            requestId: 'permission-openclaw-write',
            outcome: { outcome: 'selected', optionId: 'allow_once' },
          }),
        }),
      ]));
      const executionRequests = requests.filter(entry => entry.action.startsWith('chat:'));
      expect(JSON.stringify(executionRequests)).not.toContain('never-cross-private-reasoning');
      expect(JSON.stringify(executionRequests)).not.toContain('never-cross-secret');
      expect(requests).toEqual(expect.arrayContaining([
        expect.objectContaining({
          action: 'chat:setAcpSessionConfigOption',
          payload: expect.objectContaining({
            conversationId,
            kernelId: 'openclaw',
            configId: 'session-model',
            value: 'openai/gpt-5.6',
          }),
        }),
        expect.objectContaining({
          action: 'chat:setAcpSessionConfigOption',
          payload: expect.objectContaining({
            conversationId,
            kernelId: 'openclaw',
            configId: 'thought-level',
            value: 'high',
          }),
        }),
      ]));
    } finally {
      await closeElectronApp(app);
    }
  });
});
