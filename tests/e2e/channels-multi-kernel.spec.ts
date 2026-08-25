import { completeSetup, expect, test } from './fixtures/electron';
import { fillSecureSecret } from './helpers/secure-secret';

test.describe('Channels multi-kernel isomorphism', () => {
  test('uses the selected adapter for binding, credential validation, save, and QR login', async ({ electronApp, page }) => {
    await electronApp.evaluate(({ ipcMain }) => {
      const state = {
        calls: [] as Array<{ action?: string; payload?: Record<string, unknown> }>,
        channels: [
          {
            channelType: 'telegram',
            defaultAccountId: 'primary',
            status: 'connected',
            accounts: [{
              accountId: 'primary',
              name: 'Primary',
              configured: true,
              connected: true,
              running: true,
              linked: true,
              status: 'connected',
              isDefault: true,
              kernelId: 'openclaw',
              agentId: 'shared-agent',
              supportedKernels: ['openclaw', 'deepseek-harness'],
            }],
          },
        ],
        adapters: [
          { kernelId: 'openclaw', supportedChannels: ['telegram', 'qqbot', 'whatsapp'] },
          { kernelId: 'deepseek-harness', supportedChannels: ['telegram', 'qqbot', 'whatsapp'] },
        ],
        agents: [{
          id: 'shared-agent',
          name: 'Shared Agent',
          supportedKernels: ['openclaw', 'deepseek-harness'],
        }],
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__clawxChannelsMultiKernel = state;
      const originalHostInvoke = (ipcMain as unknown as {
        _invokeHandlers?: Map<string, (event: unknown, request: unknown) => Promise<unknown>>;
      })._invokeHandlers?.get('host:invoke');
      const respond = (id: unknown, data: unknown) => ({ id: typeof id === 'string' ? id : undefined, ok: true, data });

      ipcMain.removeHandler('host:invoke');
      ipcMain.handle('host:invoke', async (event, request: {
        id?: string;
        module?: string;
        action?: string;
        payload?: Record<string, unknown>;
      }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const current = (globalThis as any).__clawxChannelsMultiKernel as typeof state;
        if (request.module === 'channels' && request.action === 'accounts') {
          return respond(request.id, {
            success: true,
            channels: current.channels,
            adapters: current.adapters,
          });
        }
        if (request.module === 'agents' && request.action === 'list') {
          return respond(request.id, { success: true, agents: current.agents });
        }
        if (request.module === 'channels' && ['bindingSave', 'validateCredentials', 'saveConfig', 'startLogin', 'cancelLogin'].includes(request.action || '')) {
          current.calls.push({ action: request.action, payload: request.payload });
          if (request.action === 'bindingSave') {
            const account = current.channels[0]!.accounts[0]!;
            account.kernelId = String(request.payload?.kernelId);
            account.agentId = String(request.payload?.agentId);
          }
          if (request.action === 'validateCredentials') {
            return respond(request.id, { success: true, valid: true, warnings: [] });
          }
          return respond(request.id, { success: true });
        }
        return originalHostInvoke?.(event, request) ?? respond(request.id, {});
      });
    });

    await completeSetup(page);
    await page.getByTestId('sidebar-nav-channels').click();
    await expect(page.getByTestId('channels-page')).toBeVisible();

    await page.getByTestId('channel-kernel-telegram-primary').selectOption('deepseek-harness');
    await expect(page.getByTestId('channel-kernel-telegram-primary')).toHaveValue('deepseek-harness');

    await page.getByRole('button', { name: /QQ Bot/ }).click();
    await page.getByTestId('channel-config-kernel').selectOption('deepseek-harness');
    await page.getByTestId('channel-config-agent').selectOption('shared-agent');
    await page.locator('#appId').fill('qq-app');
    await fillSecureSecret(page, 'channel-secret-clientSecret', 'qq-secret');
    await page.getByRole('button', { name: /Save & Connect|dialog\.saveAndConnect/ }).click();
    await expect(page.getByTestId('channel-config-kernel')).not.toBeVisible();

    await page.getByRole('button', { name: /WhatsApp/ }).click();
    await page.getByTestId('channel-config-kernel').selectOption('deepseek-harness');
    await page.getByTestId('channel-config-agent').selectOption('shared-agent');
    await page.getByRole('button', { name: /Generate QR Code|dialog\.generateQRCode/ }).click();

    await expect.poll(async () => electronApp.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (globalThis as any).__clawxChannelsMultiKernel.calls;
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: 'bindingSave',
        payload: expect.objectContaining({
          channelType: 'telegram',
          accountId: 'primary',
          kernelId: 'deepseek-harness',
          agentId: 'shared-agent',
        }),
      }),
      expect.objectContaining({
        action: 'validateCredentials',
        payload: expect.objectContaining({
          channelType: 'qqbot',
          kernelId: 'deepseek-harness',
        }),
      }),
      expect.objectContaining({
        action: 'saveConfig',
        payload: expect.objectContaining({
          channelType: 'qqbot',
          kernelId: 'deepseek-harness',
        }),
      }),
      expect.objectContaining({
        action: 'bindingSave',
        payload: expect.objectContaining({
          channelType: 'qqbot',
          accountId: 'default',
          kernelId: 'deepseek-harness',
          agentId: 'shared-agent',
        }),
      }),
      expect.objectContaining({
        action: 'startLogin',
        payload: expect.objectContaining({
          channelType: 'whatsapp',
          kernelId: 'deepseek-harness',
        }),
      }),
    ]));
  });
});
