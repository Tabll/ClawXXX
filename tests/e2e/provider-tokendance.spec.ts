import { completeSetup, expect, test } from './fixtures/electron';

test('offers TokenDance in Chinese, starts Main-owned OAuth and cancels when the dialog closes', async ({ electronApp, page }) => {
  await completeSetup(page);
  await page.getByTestId('sidebar-nav-models').click();
  await page.getByTestId('providers-add-button').click();
  await expect(page.getByTestId('add-provider-type-tokendance')).toHaveCount(0);
  await page.getByTestId('add-provider-close-button').click();
  await electronApp.evaluate(({ ipcMain }) => {
    const original = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: unknown, request: unknown) => Promise<Record<string, unknown>>> })._invokeHandlers.get('host:invoke');
    const calls: Array<{ action: string; payload: unknown }> = [];
    Object.assign(globalThis, { __tokenDanceCalls: calls });
    ipcMain.removeHandler('host:invoke');
    ipcMain.handle('host:invoke', async (event, request) => {
      if (request.module === 'providers' && ['requestOAuth', 'cancelOAuth'].includes(request.action)) {
        calls.push({ action: request.action, payload: request.payload });
        return { id: request.id, ok: true, data: { success: true } };
      }
      const result = await original?.(event, request);
      if (request.module === 'settings' && request.action === 'getAll' && result?.data) {
        result.data = { ...result.data as object, language: 'zh' };
      }
      return result;
    });
  });
  await page.reload();
  await page.getByTestId('sidebar-nav-models').click();
  await page.getByTestId('providers-add-button').click();
  await page.getByTestId('add-provider-type-tokendance').click();
  await expect(page.getByTestId('add-provider-oauth-login-button')).toBeVisible();
  await page.getByTestId('add-provider-oauth-login-button').click();
  await page.getByTestId('add-provider-close-button').click();
  await expect.poll(async () => electronApp.evaluate(() =>
    (globalThis as unknown as { __tokenDanceCalls: Array<{ action: string }> }).__tokenDanceCalls.map(call => call.action),
  )).toEqual(['requestOAuth', 'cancelOAuth']);
  const calls = await electronApp.evaluate(() => (globalThis as unknown as { __tokenDanceCalls: unknown }).__tokenDanceCalls);
  expect(calls).toEqual([
    { action: 'requestOAuth', payload: { provider: 'tokendance', accountId: expect.stringMatching(/^tokendance-/), label: 'TokenDance' } },
    { action: 'cancelOAuth', payload: undefined },
  ]);
  await page.getByTestId('providers-add-button').click();
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('oauth:success', { provider: 'tokendance', accountId: 'old-flow', success: true });
  });
  await expect(page.getByTestId('add-provider-dialog')).toBeVisible();
});
