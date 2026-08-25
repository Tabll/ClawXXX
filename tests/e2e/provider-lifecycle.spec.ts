import { completeSetup, expect, test } from './fixtures/electron';

const TEST_PROVIDER_ID = 'moonshot-e2e';
const TEST_PROVIDER_LABEL = 'Moonshot E2E';

async function fillSecureSecret(
  page: Parameters<typeof completeSetup>[0],
  testId: string,
  value: string,
): Promise<void> {
  await page.getByTestId(testId).evaluate((element, nextValue) => {
    const id = element.getAttribute('data-clawx-secret-id');
    const setValue = window.clawxSecureSecrets?.setValueForTesting;
    if (!id || typeof setValue !== 'function') {
      throw new Error('Secure test input bridge is unavailable');
    }
    setValue(id, nextValue);
  }, value);
}

async function seedTestProvider(page: Parameters<typeof completeSetup>[0]): Promise<void> {
  await page.evaluate(async ({ providerId, providerLabel }) => {
    const now = new Date().toISOString();
    const response = await window.clawx!.hostInvoke({
      id: crypto.randomUUID(),
      module: 'providers',
      action: 'createAccount',
      payload: {
        account: {
          id: providerId,
          label: providerLabel,
          vendorId: 'moonshot',
          authMode: 'api_key',
          baseUrl: 'https://api.moonshot.cn/v1',
          model: 'kimi-k2.6',
          enabled: true,
          isDefault: false,
          createdAt: now,
          updatedAt: now,
        },
      },
    });
    if (!response.ok || !(response.data as { success?: boolean })?.success) {
      throw new Error('Failed to seed Provider account');
    }
  }, { providerId: TEST_PROVIDER_ID, providerLabel: TEST_PROVIDER_LABEL });
}

test.describe('ClawX provider lifecycle', () => {
  test('promotes a remaining provider after deleting the default provider', async ({ page }) => {
    await completeSetup(page);

    await page.evaluate(async () => {
      const now = new Date().toISOString();
      const providers = [
        {
          id: 'moonshot-default-e2e',
          label: 'Moonshot Default E2E',
          vendorId: 'moonshot',
          authMode: 'api_key',
          baseUrl: 'https://api.moonshot.cn/v1',
          model: 'kimi-k2.6',
          enabled: true,
          isDefault: false,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'deepseek-replacement-e2e',
          label: 'DeepSeek Replacement E2E',
          vendorId: 'deepseek',
          authMode: 'api_key',
          baseUrl: 'https://api.deepseek.com/v1',
          model: 'deepseek-v4-pro',
          enabled: true,
          isDefault: false,
          createdAt: now,
          updatedAt: new Date(Date.now() + 1_000).toISOString(),
        },
      ];

      for (const provider of providers) {
        await window.clawx!.hostInvoke({
          id: crypto.randomUUID(), module: 'providers', action: 'createAccount', payload: { account: provider },
        });
      }
      await window.clawx!.hostInvoke({
        id: crypto.randomUUID(),
        module: 'providers',
        action: 'setKernelDefault',
        payload: { kernelId: 'openclaw', accountId: providers[0].id, modelId: providers[0].model },
      });
    });

    await page.getByTestId('sidebar-nav-models').click();
    await expect(page.getByTestId('provider-card-moonshot-default-e2e')).toContainText('Default');
    await expect(page.getByTestId('provider-card-deepseek-replacement-e2e')).toBeVisible();

    await page.getByTestId('provider-card-moonshot-default-e2e').hover();
    await page.getByTestId('provider-delete-moonshot-default-e2e').click();

    await expect(page.getByTestId('provider-card-moonshot-default-e2e')).toHaveCount(0);
    await expect(page.getByTestId('provider-card-deepseek-replacement-e2e')).toContainText('Default');
    await expect(page.getByTestId('provider-set-default-deepseek-replacement-e2e')).toHaveCount(0);
  });

  test('shows a saved provider and removes it cleanly after deletion', async ({ page }) => {
    await completeSetup(page);
    await seedTestProvider(page);

    await page.getByTestId('sidebar-nav-models').click();
    await expect(page.getByTestId('providers-settings')).toBeVisible();
    await expect(page.getByTestId(`provider-card-${TEST_PROVIDER_ID}`)).toContainText(TEST_PROVIDER_LABEL);

    await page.getByTestId(`provider-card-${TEST_PROVIDER_ID}`).hover();
    await page.getByTestId(`provider-delete-${TEST_PROVIDER_ID}`).click();

    await expect(page.getByTestId(`provider-card-${TEST_PROVIDER_ID}`)).toHaveCount(0);
    await expect(page.getByText(TEST_PROVIDER_LABEL)).toHaveCount(0);
  });

  test('does not redisplay a deleted provider after relaunch', async ({ electronApp, launchElectronApp, page }) => {
    await completeSetup(page);
    await seedTestProvider(page);

    await page.getByTestId('sidebar-nav-models').click();
    await expect(page.getByTestId(`provider-card-${TEST_PROVIDER_ID}`)).toContainText(TEST_PROVIDER_LABEL);

    await page.getByTestId(`provider-card-${TEST_PROVIDER_ID}`).hover();
    await page.getByTestId(`provider-delete-${TEST_PROVIDER_ID}`).click();
    await expect(page.getByTestId(`provider-card-${TEST_PROVIDER_ID}`)).toHaveCount(0);

    await electronApp.close();

    const relaunchedApp = await launchElectronApp();
    try {
      const relaunchedPage = await relaunchedApp.firstWindow();
      await relaunchedPage.waitForLoadState('domcontentloaded');
      await expect(relaunchedPage.getByTestId('main-layout')).toBeVisible();

      await relaunchedPage.getByTestId('sidebar-nav-models').click();
      await expect(relaunchedPage.getByTestId('providers-settings')).toBeVisible();
      await expect(relaunchedPage.getByTestId(`provider-card-${TEST_PROVIDER_ID}`)).toHaveCount(0);
      await expect(relaunchedPage.getByText(TEST_PROVIDER_LABEL)).toHaveCount(0);
    } finally {
      await relaunchedApp.close();
    }
  });

  test('shows OpenAI OAuth and API key auth mode toggle in add-provider dialog', async ({ page }) => {
    await completeSetup(page);

    await page.getByTestId('sidebar-nav-models').click();
    await expect(page.getByTestId('providers-settings')).toBeVisible();

    await page.getByTestId('providers-add-button').click();
    await expect(page.getByTestId('add-provider-dialog')).toBeVisible();

    await page.getByTestId('add-provider-type-openai').click();
    await expect(page.getByTestId('add-provider-auth-oauth-tab')).toBeVisible();
    await expect(page.getByTestId('add-provider-auth-apikey-tab')).toBeVisible();

    await page.getByTestId('add-provider-auth-oauth-tab').click();
    await expect(page.getByTestId('add-provider-oauth-login-button')).toBeVisible();
    await expect(page.getByTestId('add-provider-api-key-input')).toHaveCount(0);
  });

  test('trims whitespace before validating and saving a custom provider key', async ({ electronApp, page }) => {
    await completeSetup(page);

    await electronApp.evaluate(async ({ app: _app }) => {
      const { ipcMain } = process.mainModule!.require('electron') as typeof import('electron');

      let accounts: Array<Record<string, unknown>> = [];
      let keyInfo: Array<{ accountId: string; hasKey: boolean; keyMasked: string | null }> = [];
      let statuses: Array<Record<string, unknown>> = [];
      let defaultAccountId: string | null = null;
      const originalHostInvoke = (ipcMain as unknown as {
        _invokeHandlers?: Map<string, (event: unknown, request: unknown) => Promise<unknown>>;
      })._invokeHandlers?.get('host:invoke');

      const respond = (id: unknown, data: unknown) => ({
        id: typeof id === 'string' ? id : undefined,
        ok: true,
        data,
      });

      ipcMain.removeHandler('host:invoke');
      ipcMain.handle('host:invoke', async (event: unknown, request: {
        id?: string;
        module?: string;
        action?: string;
        payload?: Record<string, unknown>;
      }) => {
        if (request?.module !== 'providers') {
          return originalHostInvoke?.(event, request) ?? respond(request?.id, undefined);
        }

        const body = request.payload ?? {};
        if (request.action === 'accounts') return respond(request.id, accounts);
        if (request.action === 'accountKeyInfo') return respond(request.id, keyInfo);
        if (request.action === 'vendors') return respond(request.id, []);
        if (request.action === 'getDefaultAccount') return respond(request.id, { accountId: defaultAccountId });
        if (request.action === 'kernelDefaults') return respond(request.id, []);
        if (request.action === 'list') return respond(request.id, statuses);

        if (request.action === 'validateKey') {
          if (typeof body.credentialHandle !== 'string' || !body.credentialHandle.startsWith('credential-stage://') || body.apiKey !== undefined) {
            return respond(request.id, { valid: false, error: 'credential was not staged securely' });
          }
          const options = body.options as Record<string, unknown> | undefined;
          if (options?.modelId !== 'local-model') {
            return respond(request.id, {
              valid: false,
              error: `unexpected validation model: ${String(options?.modelId)}`,
            });
          }
          return respond(request.id, { valid: true });
        }

        if (request.action === 'createAccount') {
          const account = body.account as Record<string, unknown>;
          accounts = [account];
          keyInfo = [{
            accountId: String(account.id),
            hasKey: Boolean(body.credentialHandle),
            keyMasked: body.credentialHandle ? '••••••••' : null,
          }];
          statuses = [{
            id: account.id,
            name: account.label,
            type: account.vendorId,
            baseUrl: account.baseUrl,
            model: account.model,
            enabled: account.enabled,
            createdAt: account.createdAt,
            updatedAt: account.updatedAt,
            hasKey: Boolean(body.credentialHandle),
            keyMasked: body.credentialHandle ? '••••••••' : null,
          }];
          return respond(request.id, { success: true, account });
        }

        if (request.action === 'setDefaultAccount') {
          defaultAccountId = typeof body.accountId === 'string' ? body.accountId : null;
          return respond(request.id, { success: true });
        }

        return respond(request.id, {});
      });
    });

    await page.getByTestId('sidebar-nav-models').click();
    await expect(page.getByTestId('providers-settings')).toBeVisible();

    await page.getByTestId('providers-add-button').click();
    await expect(page.getByTestId('add-provider-dialog')).toBeVisible();

    await page.getByTestId('add-provider-type-custom').click();
    await page.getByTestId('add-provider-name-input').fill('LM Studio Local');
    await fillSecureSecret(page, 'add-provider-api-key-input', '  sk-lm-test \n');
    await page.getByTestId('add-provider-base-url-input').fill('http://127.0.0.1:1234/v1');
    await page.getByTestId('add-provider-model-id-input').fill('local-model');
    await page.getByTestId('add-provider-submit-button').click();

    await expect(page.getByTestId('provider-card-custom')).toContainText('LM Studio Local');
  });

  test('edit form validates the new API key inline before saving (single button)', async ({ electronApp, page }) => {
    await completeSetup(page);

    await electronApp.evaluate(async ({ app: _app }) => {
      const { ipcMain } = process.mainModule!.require('electron') as typeof import('electron');

      let provider = {
        id: 'moonshot-edit',
        vendorId: 'moonshot',
        label: 'Moonshot Edit',
        authMode: 'api_key',
        baseUrl: 'https://api.moonshot.cn/v1',
        model: 'kimi-k2.6',
        enabled: true,
        isDefault: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      let storedKey = 'sk-existing';
      let validationAttempt = 0;
      let keyInfo = [{ accountId: provider.id, hasKey: true, keyMasked: 'sk-***' }];
      const originalHostInvoke = (ipcMain as unknown as {
        _invokeHandlers?: Map<string, (event: unknown, request: unknown) => Promise<unknown>>;
      })._invokeHandlers?.get('host:invoke');

      const respond = (id: unknown, data: unknown) => ({
        id: typeof id === 'string' ? id : undefined,
        ok: true,
        data,
      });

      ipcMain.removeHandler('host:invoke');
      ipcMain.handle('host:invoke', async (event: unknown, request: {
        id?: string;
        module?: string;
        action?: string;
        payload?: Record<string, unknown>;
      }) => {
        if (request?.module !== 'providers') {
          return originalHostInvoke?.(event, request) ?? respond(request?.id, undefined);
        }

        const body = request.payload ?? {};
        if (request.action === 'accounts') return respond(request.id, [provider]);
        if (request.action === 'accountKeyInfo') return respond(request.id, keyInfo);
        if (request.action === 'vendors') return respond(request.id, []);
        if (request.action === 'getDefaultAccount') return respond(request.id, { accountId: provider.id });
        if (request.action === 'kernelDefaults') return respond(request.id, []);
        if (request.action === 'list') return respond(request.id, [provider]);

        if (request.action === 'validateKey') {
          validationAttempt += 1;
          if (validationAttempt === 2
            && typeof body.credentialHandle === 'string'
            && body.credentialHandle.startsWith('credential-stage://')
            && body.apiKey === undefined) {
            const options = body.options as Record<string, unknown> | undefined;
            if (options?.modelId !== 'kimi-k2.6') {
              return respond(request.id, {
                valid: false,
                error: `unexpected validation model: ${String(options?.modelId)}`,
              });
            }
            return respond(request.id, { valid: true });
          }
          return respond(request.id, { valid: false, error: 'Invalid API key' });
        }

        if (request.action === 'updateAccount') {
          provider = {
            ...provider,
            ...(body.updates as Record<string, unknown> | undefined),
            updatedAt: new Date().toISOString(),
          };
          if (body.credentialHandle) storedKey = String(body.credentialHandle);
          keyInfo = [{ accountId: provider.id, hasKey: Boolean(storedKey), keyMasked: 'sk-***' }];
          return respond(request.id, { success: true, account: provider });
        }

        return respond(request.id, {});
      });
    });

    await page.getByTestId('sidebar-nav-models').click();
    await expect(page.getByTestId('providers-settings')).toBeVisible();
    await expect(page.getByTestId('provider-card-moonshot-edit')).toBeVisible();

    await page.getByTestId('provider-card-moonshot-edit').hover();
    await page.getByTestId('provider-edit-moonshot-edit').click();

    await expect(page.getByTestId('provider-edit-model-id-moonshot-edit')).toBeDisabled();
    await expect(page.getByTestId('provider-edit-model-id-moonshot-edit')).toHaveValue('kimi-k2.6');
    await expect(page.getByTestId('provider-edit-model-id-help-moonshot-edit')).toContainText(
      'The model ID cannot be changed after creation.',
    );

    await fillSecureSecret(page, 'provider-edit-key-input-moonshot-edit', 'sk-bad');
    await page.getByTestId('provider-edit-save-moonshot-edit').click();
    await expect(page.getByTestId('provider-edit-validation-error-moonshot-edit')).toContainText('Invalid API key');

    await fillSecureSecret(page, 'provider-edit-key-input-moonshot-edit', 'sk-good');
    await expect(page.getByTestId('provider-edit-validation-error-moonshot-edit')).toHaveCount(0);
    await page.getByTestId('provider-edit-save-moonshot-edit').click();

    await expect(page.getByTestId('provider-edit-save-moonshot-edit')).toHaveCount(0);
  });

  test('shows Z.AI CN/Global options and Code Plan endpoint toggle', async ({ page }) => {
    await completeSetup(page);

    await page.getByTestId('sidebar-nav-models').click();
    await expect(page.getByTestId('providers-settings')).toBeVisible();

    await page.getByTestId('providers-add-button').click();
    await expect(page.getByTestId('add-provider-dialog')).toBeVisible();
    await expect(page.getByTestId('add-provider-type-zai')).toBeVisible();
    await expect(page.getByTestId('add-provider-type-zai-global')).toBeVisible();

    await page.getByTestId('add-provider-type-zai').click();
    await expect(page.getByTestId('add-provider-base-url-input')).toHaveValue('https://open.bigmodel.cn/api/paas/v4');
    await expect(page.getByTestId('add-provider-model-id-input')).toHaveValue('glm-5.2');
    await expect(page.getByTestId('add-provider-codeplan-mode-tab')).toBeVisible();

    await page.getByTestId('add-provider-codeplan-mode-tab').click();
    await expect(page.getByTestId('add-provider-base-url-input')).toHaveValue('https://open.bigmodel.cn/api/coding/paas/v4');
    await expect(page.getByTestId('add-provider-model-id-input')).toHaveValue('glm-5.2');

    await page.getByTestId('add-provider-codeplan-apikey-tab').click();
    await expect(page.getByTestId('add-provider-base-url-input')).toHaveValue('https://open.bigmodel.cn/api/paas/v4');

    await page.getByTestId('add-provider-change-type').click();
    await page.getByTestId('add-provider-type-zai-global').click();
    await expect(page.getByTestId('add-provider-base-url-input')).toHaveValue('https://api.z.ai/api/paas/v4');
    await page.getByTestId('add-provider-codeplan-mode-tab').click();
    await expect(page.getByTestId('add-provider-base-url-input')).toHaveValue('https://api.z.ai/api/coding/paas/v4');
  });

  test('saves model capability switches from provider model configuration', async ({ electronApp, page }) => {
    await completeSetup(page);

    await electronApp.evaluate(async ({ app: _app }) => {
      const { ipcMain } = process.mainModule!.require('electron') as typeof import('electron');
      let provider = {
        id: 'capability-edit',
        vendorId: 'custom',
        label: 'Capability Edit',
        authMode: 'api_key',
        baseUrl: 'http://127.0.0.1:1234/v1',
        apiProtocol: 'openai-completions',
        model: 'qwen/qwen3.6-35b-a3b',
        modelCapabilities: { reasoning: false, imageInput: false },
        supportedKernels: ['openclaw', 'deepseek-harness'],
        projections: [
          {
            kernelId: 'openclaw',
            status: 'ready',
            desiredVersion: 3,
            appliedVersion: 3,
            updatedAt: new Date().toISOString(),
          },
          {
            kernelId: 'deepseek-harness',
            status: 'failed',
            desiredVersion: 3,
            error: 'Harness projection rejected this endpoint',
            updatedAt: new Date().toISOString(),
          },
        ],
        enabled: true,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const keyInfo = [{ accountId: provider.id, hasKey: true, keyMasked: 'sk-***' }];
      (globalThis as typeof globalThis & { __lastProviderCapabilityUpdate?: unknown })
        .__lastProviderCapabilityUpdate = null;

      const originalHostInvoke = (ipcMain as unknown as {
        _invokeHandlers?: Map<string, (event: unknown, request: unknown) => Promise<unknown>>;
      })._invokeHandlers?.get('host:invoke');
      const respond = (id: unknown, data: unknown) => ({
        id: typeof id === 'string' ? id : undefined,
        ok: true,
        data,
      });

      ipcMain.removeHandler('host:invoke');
      ipcMain.handle('host:invoke', async (event: unknown, request: {
        id?: string;
        module?: string;
        action?: string;
        payload?: Record<string, unknown>;
      }) => {
        if (request?.module !== 'providers') {
          return originalHostInvoke?.(event, request) ?? respond(request?.id, undefined);
        }
        const body = request.payload ?? {};
        if (request.action === 'accounts') return respond(request.id, [provider]);
        if (request.action === 'accountKeyInfo') return respond(request.id, keyInfo);
        if (request.action === 'vendors') return respond(request.id, []);
        if (request.action === 'getDefaultAccount') return respond(request.id, { accountId: provider.id });
        if (request.action === 'kernelDefaults') {
          return respond(request.id, [{
            kernelId: 'openclaw',
            accountId: provider.id,
            modelId: provider.model,
          }]);
        }
        if (request.action === 'list') return respond(request.id, [provider]);
        if (request.action === 'updateAccount') {
          (globalThis as typeof globalThis & { __lastProviderCapabilityUpdate?: unknown })
            .__lastProviderCapabilityUpdate = body.updates;
          provider = {
            ...provider,
            ...(body.updates as Record<string, unknown> | undefined),
            updatedAt: new Date().toISOString(),
          };
          return respond(request.id, { success: true, account: provider });
        }
        return respond(request.id, {});
      });
    });

    await page.getByTestId('sidebar-nav-models').click();
    await expect(page.getByTestId('providers-settings')).toBeVisible();
    await expect(page.getByTestId('provider-card-capability-edit')).toBeVisible();
    await expect(page.getByTestId('provider-kernel-capability-edit-openclaw')).toContainText('Ready');
    await expect(page.getByTestId('provider-kernel-capability-edit-openclaw')).toContainText('Default');
    await expect(page.getByTestId('provider-kernel-capability-edit-deepseek-harness')).toContainText('Failed');
    await expect(page.getByTestId('provider-kernel-capability-edit-deepseek-harness')).toHaveAttribute(
      'title',
      'Harness projection rejected this endpoint',
    );
    await expect(page.getByTestId('provider-kernel-default-openclaw')).toHaveValue(
      'capability-edit:qwen%2Fqwen3.6-35b-a3b',
    );
    await page.getByTestId('provider-card-capability-edit').hover();
    await page.getByTestId('provider-edit-capability-edit').click();
    await expect(page.getByTestId('provider-edit-model-capabilities-capability-edit')).toBeVisible();

    await page.getByTestId('provider-edit-supports-thinking-capability-edit').click();
    await page.getByTestId('provider-edit-supports-images-capability-edit').click();
    await page.getByTestId('provider-edit-save-capability-edit').click();
    await expect(page.getByTestId('provider-edit-save-capability-edit')).toHaveCount(0);

    const updates = await electronApp.evaluate(async () => (
      (globalThis as typeof globalThis & { __lastProviderCapabilityUpdate?: unknown })
        .__lastProviderCapabilityUpdate
    ));
    expect(updates).toMatchObject({
      modelCapabilities: { reasoning: true, imageInput: true },
    });
  });
});
