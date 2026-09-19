import { closeElectronApp, expect, getStableWindow, test } from './fixtures/electron';

test('opts in one Computer Use kernel, handles permissions and persists disabling without native desktop access', async ({ launchElectronApp }) => {
  const app = await launchElectronApp({ skipSetup: true });
  try {
    const page = await getStableWindow(app);
    await app.evaluate(({ ipcMain }) => {
      const original = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: unknown, request: unknown) => unknown> })._invokeHandlers.get('host:invoke');
      const state = { kernelId: null as string | null, supported: true, granted: false, permissionRequests: 0 };
      Object.assign(globalThis, { __computerFixture: state });
      ipcMain.removeHandler('host:invoke');
      ipcMain.handle('host:invoke', (event, request) => {
        if (request.module !== 'computerUse') return original?.(event, request);
        if (request.action === 'select') state.kernelId = request.payload.kernelId;
        if (request.action === 'requestPermissions') { state.granted = true; state.permissionRequests++; }
        return { id: request.id, ok: true, data: { kernelId: state.kernelId, supported: state.supported,
          accessibility: state.granted, screenRecording: state.granted,
          state: !state.supported ? 'unsupported' : !state.kernelId ? 'disabled' : state.granted ? 'ready' : 'permissions' } };
      });
    });
    await page.reload();
    await page.getByTestId('sidebar-nav-settings').click();
    const select = page.getByTestId('computer-use-kernel');
    await expect(select).toHaveValue('');
    await select.selectOption('openclaw');
    await expect(page.getByTestId('computer-use-status')).toContainText('Accessibility');
    expect(await app.evaluate(() => (globalThis as unknown as { __computerFixture: { permissionRequests: number } }).__computerFixture.permissionRequests)).toBe(0);
    await page.getByTestId('computer-use-permissions').click();
    await expect(page.getByTestId('computer-use-status')).toContainText('Ready');
    await select.selectOption('deepseek-harness'); await expect(select).toHaveValue('deepseek-harness');
    await page.reload(); await expect(select).toHaveValue('deepseek-harness');
    await select.selectOption(''); await expect(page.getByTestId('computer-use-status')).toContainText('disabled');
    await page.reload(); await expect(select).toHaveValue('');
    await app.evaluate(() => { (globalThis as unknown as { __computerFixture: { supported: boolean } }).__computerFixture.supported = false; });
    await expect(page.getByTestId('computer-use-status')).toContainText('unavailable on this platform');
    await expect(select).toBeDisabled();
  } finally { await closeElectronApp(app); }
});
