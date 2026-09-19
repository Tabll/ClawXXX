import { completeSetup, expect, test } from './fixtures/electron';
import { fillSecureSecret } from './helpers/secure-secret';

test('rejects Feishu credentials before save and allows a corrected secure retry', async ({ electronApp, page }) => {
  await electronApp.evaluate(({ ipcMain }) => {
    const original = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: unknown, request: unknown) => unknown> })._invokeHandlers.get('host:invoke');
    const state = { validations: 0, saves: [] as unknown[] };
    Object.assign(globalThis, { __feishuValidationTest: state });
    ipcMain.removeHandler('host:invoke');
    ipcMain.handle('host:invoke', (event, request) => {
      const respond = (data: unknown) => ({ id: request.id, ok: true, data });
      if (request.module === 'channels' && request.action === 'accounts') return respond({ success: true, channels: [] });
      if (request.module === 'agents' && request.action === 'list') return respond({ success: true, agents: [] });
      if (request.module === 'channels' && request.action === 'validateCredentials') {
        state.validations++;
        return respond(state.validations === 1 ? { success: true, valid: false, errorCode: 'feishuRejected' } : { success: true, valid: true });
      }
      if (request.module === 'channels' && request.action === 'saveConfig') { state.saves.push(request.payload); return respond({ success: true }); }
      return original?.(event, request);
    });
  });
  await completeSetup(page);
  await page.getByTestId('sidebar-nav-channels').click();
  await page.getByRole('button', { name: /Feishu \/ Lark/ }).click();
  await page.locator('#appId').fill('cli_test');
  await fillSecureSecret(page, 'channel-secret-appSecret', 'bad-secret');
  const save = page.getByRole('button', { name: /Save & Connect/ });
  await save.click();
  await expect(page.getByText('Feishu / Lark rejected these credentials. Check App ID and App Secret.')).toBeVisible();
  const read = () => electronApp.evaluate(() => (globalThis as unknown as { __feishuValidationTest: { validations: number; saves: unknown[] } }).__feishuValidationTest);
  expect((await read()).saves).toHaveLength(0);
  await fillSecureSecret(page, 'channel-secret-appSecret', 'corrected-secret');
  await save.click();
  await expect.poll(async () => (await read()).saves.length).toBe(1);
  const result = await read();
  expect(result.validations).toBe(2);
  expect(JSON.stringify(result.saves)).not.toContain('corrected-secret');
  expect(JSON.stringify(result.saves)).toContain('credential-stage://');
});
