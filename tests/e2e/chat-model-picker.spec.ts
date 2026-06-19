import { closeElectronApp, expect, getStableWindow, test } from './fixtures/electron';

const alphaModelRef = 'custom-alpha123/model-alpha';
const betaModelRef = 'custom-beta5678/provider/model-beta';

test.describe('ClawX chat model picker', () => {
  test('switches the current chat session model without requesting a gateway refresh', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await app.evaluate(async ({ app: _app }, refs) => {
        const { ipcMain } = process.mainModule!.require('electron') as typeof import('electron');

        let sessionModelRef: string | null = null;
        const hostRequests: Array<{ path: string; method: string; body: unknown }> = [];
        const now = new Date().toISOString();
        const originalHostInvoke = (ipcMain as unknown as {
          _invokeHandlers?: Map<string, (event: unknown, request: unknown) => Promise<unknown>>;
        })._invokeHandlers?.get('host:invoke');
        const makeResponse = (id: unknown, data: unknown) => ({
          id: typeof id === 'string' ? id : undefined,
          ok: true,
          data,
        });
        const toSessionModelPatch = (modelRef: string | null) => {
          if (!modelRef) return {};
          const separatorIndex = modelRef.indexOf('/');
          return separatorIndex > 0
            ? {
              modelProvider: modelRef.slice(0, separatorIndex),
              model: modelRef.slice(separatorIndex + 1),
            }
            : { model: modelRef };
        };
        const sessionsSnapshot = () => ({
          sessions: [{
            key: 'agent:main:main',
            displayName: 'main',
            ...toSessionModelPatch(sessionModelRef),
          }],
          defaults: toSessionModelPatch(refs.alphaModelRef),
        });
        const modelCatalogSnapshot = () => ({
          models: [
            { id: 'model-alpha', provider: 'custom-alpha123', label: 'model-alpha (Alpha)' },
            { id: 'provider/model-beta', provider: 'custom-beta5678', label: 'provider/model-beta (Beta)' },
          ],
        });

        const agentsSnapshot = () => ({
          success: true,
          agents: [{
            id: 'main',
            name: 'Main',
            isDefault: true,
            modelDisplay: 'model-alpha',
            modelRef: refs.alphaModelRef,
            overrideModelRef: null,
            inheritedModel: false,
            workspace: '~/.openclaw/workspace',
            agentDir: '~/.openclaw/agents/main/agent',
            mainSessionKey: 'agent:main:main',
            channelTypes: [],
          }],
          defaultAgentId: 'main',
          defaultModelRef: refs.alphaModelRef,
          configuredChannelTypes: [],
          channelOwners: {},
          channelAccountOwners: {},
        });

        ipcMain.removeHandler('gateway:status');
        ipcMain.handle('gateway:status', async () => ({ state: 'running', port: 18789, pid: 12345 }));

        ipcMain.removeHandler('gateway:rpc');
        ipcMain.handle('gateway:rpc', async (_event: unknown, method: string, params: unknown) => {
          hostRequests.push({ path: `gateway:${method}`, method: 'RPC', body: params ?? null });
          if (method === 'sessions.list') {
            return { success: true, result: sessionsSnapshot() };
          }
          if (method === 'models.list') {
            return { success: true, result: modelCatalogSnapshot() };
          }
          if (method === 'chat.history') {
            return { success: true, result: { messages: [] } };
          }
          if (method === 'sessions.patch') {
            const body = params as { model?: string | null } | null;
            sessionModelRef = typeof body?.model === 'string' ? body.model : null;
            return { success: true, result: { resolved: toSessionModelPatch(sessionModelRef) } };
          }
          return { success: true, result: {} };
        });

        ipcMain.removeHandler('host:invoke');
        ipcMain.handle('host:invoke', async (event: unknown, request: {
          id?: string;
          module?: string;
          action?: string;
          payload?: Record<string, unknown>;
        }) => {
          const body = request?.payload ?? null;
          hostRequests.push({
            path: `${request?.module ?? ''}:${request?.action ?? ''}`,
            method: 'HOST',
            body,
          });

          if (request?.module === 'gateway' && request.action === 'status') {
            return makeResponse(request.id, { state: 'running', port: 18789, pid: 12345, gatewayReady: true });
          }
          if (request?.module === 'gateway' && request.action === 'rpc') {
            const method = typeof body?.method === 'string' ? body.method : '';
            const params = body?.params ?? null;
            hostRequests.push({ path: `gateway:${method}`, method: 'RPC', body: params });
            if (method === 'sessions.list') {
              return makeResponse(request.id, { success: true, result: sessionsSnapshot() });
            }
            if (method === 'models.list') {
              return makeResponse(request.id, { success: true, result: modelCatalogSnapshot() });
            }
            if (method === 'chat.history') {
              return makeResponse(request.id, { success: true, result: { messages: [] } });
            }
            if (method === 'sessions.patch') {
              const patch = params as { model?: string | null } | null;
              sessionModelRef = typeof patch?.model === 'string' ? patch.model : null;
              return makeResponse(request.id, { success: true, result: { resolved: toSessionModelPatch(sessionModelRef) } });
            }
            return makeResponse(request.id, { success: true, result: {} });
          }
          if (request?.module === 'agents' && request.action === 'list') {
            return makeResponse(request.id, agentsSnapshot());
          }
          if (request?.module === 'agents' && request.action === 'updateModel') {
            throw new Error('chat model picker should patch the current session, not the agent model');
          }
          if (request?.module === 'providers' && request.action === 'accounts') {
            return makeResponse(request.id, [
              {
                id: 'alpha1234',
                vendorId: 'custom',
                label: 'Alpha',
                authMode: 'api_key',
                baseUrl: 'http://127.0.0.1:1111/v1',
                model: 'model-alpha',
                enabled: true,
                isDefault: true,
                createdAt: now,
                updatedAt: now,
              },
              {
                id: 'beta5678',
                vendorId: 'custom',
                label: 'Beta',
                authMode: 'api_key',
                baseUrl: 'http://127.0.0.1:2222/v1',
                model: refs.betaModelRef,
                enabled: true,
                isDefault: false,
                createdAt: now,
                updatedAt: now,
              },
            ]);
          }
          if (request?.module === 'providers' && request.action === 'list') {
            return makeResponse(request.id, [
              { id: 'alpha1234', type: 'custom', name: 'Alpha', enabled: true, hasKey: true, keyMasked: 'sk-***', createdAt: now, updatedAt: now },
              { id: 'beta5678', type: 'custom', name: 'Beta', enabled: true, hasKey: true, keyMasked: 'sk-***', createdAt: now, updatedAt: now },
            ]);
          }
          if (request?.module === 'providers' && request.action === 'accountKeyInfo') {
            return makeResponse(request.id, [
              { accountId: 'alpha1234', hasKey: true, keyMasked: 'sk-***' },
              { accountId: 'beta5678', hasKey: true, keyMasked: 'sk-***' },
            ]);
          }
          if (request?.module === 'providers' && request.action === 'vendors') {
            return makeResponse(request.id, []);
          }
          if (request?.module === 'providers' && request.action === 'getDefaultAccount') {
            return makeResponse(request.id, { accountId: 'alpha1234' });
          }

          return originalHostInvoke?.(event, request) ?? makeResponse(request?.id, {});
        });

        (globalThis as typeof globalThis & { __chatModelPickerRequests?: typeof hostRequests }).__chatModelPickerRequests = hostRequests;
      }, { alphaModelRef, betaModelRef });

      const page = await getStableWindow(app);
      await page.reload();
      await expect(page.getByTestId('main-layout')).toBeVisible();
      await app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0];
        win?.webContents.send('gateway:status-changed', { state: 'running', port: 18789, pid: 12345, gatewayReady: true });
      });

      await expect(page.getByTestId('chat-model-picker-button')).toContainText('Default (model-alpha (Alpha))');
      await page.getByTestId('chat-model-picker-button').click();
      await expect(page.getByTestId('chat-model-picker-menu')).toBeVisible();
      await expect(page.getByTestId('chat-model-picker-menu')).toContainText('provider/model-beta (Beta)');
      await page.getByTestId('chat-model-picker-menu').getByRole('button', { name: 'provider/model-beta (Beta)' }).click();
      await expect(page.getByTestId('chat-model-picker-button')).toContainText('provider/model-beta (Beta)');

      const requests = await app.evaluate(() => (
        (globalThis as typeof globalThis & { __chatModelPickerRequests?: Array<{ path: string; method: string; body: unknown }> }).__chatModelPickerRequests ?? []
      ));
      expect(requests).toContainEqual({
        path: 'gateway:models.list',
        method: 'RPC',
        body: { view: 'configured' },
      });
      expect(requests).toContainEqual({
        path: 'gateway:sessions.patch',
        method: 'RPC',
        body: { key: 'agent:main:main', agentId: 'main', model: betaModelRef },
      });
      expect(requests.some((request) => request.path === 'agents:updateModel' || request.path === '/api/agents/main/model')).toBe(false);
      expect(requests.some((request) =>
        request.path === '/api/gateway/restart'
        || request.path === '/api/gateway/start'
        || request.path === 'gateway:restart'
        || request.path === 'gateway:start'
        || request.path === 'gateway:config.patch'
      )).toBe(false);
    } finally {
      await closeElectronApp(app);
    }
  });
});
