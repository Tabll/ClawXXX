import { completeSetup, expect, test } from './fixtures/electron';

test('keeps DingTalk workspace authorization and cancellation scoped to the selected account', async ({ electronApp, page }) => {
  await electronApp.evaluate(({ ipcMain }) => {
    const original = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: unknown, request: unknown) => unknown> })._invokeHandlers.get('host:invoke');
    const snapshots: Record<string, Record<string, unknown>> = { one: { status: 'needs_auth' }, two: { status: 'needs_auth' } };
    const calls: Array<{ accountId: string; operation: string; authorizationId?: string }> = [];
    Object.assign(globalThis, { __dwsFixture: { snapshots, calls } });
    ipcMain.removeHandler('host:invoke');
    ipcMain.handle('host:invoke', (event, request) => {
      const respond = (data: unknown) => ({ id: request.id, ok: true, data });
      if (request.module === 'channels' && request.action === 'accounts') return respond({ success: true, channels: [{
        channelType: 'dingtalk', defaultAccountId: 'one', status: 'connected', accounts: ['one', 'two'].map((accountId, index) => ({
          accountId, name: accountId, status: 'connected', configured: true, connected: true, running: true, linked: true,
          isDefault: index === 0, kernelId: index === 0 ? 'openclaw' : 'deepseek-harness',
          supportedKernels: ['openclaw', 'deepseek-harness'],
        })),
      }] });
      if (request.module === 'agents' && request.action === 'list') return respond({ success: true, agents: [] });
      if (request.module === 'channels' && request.action === 'dingtalkWorkspace') {
        const payload = request.payload as { accountId: string; operation: string; authorizationId?: string };
        calls.push(payload);
        if (payload.operation === 'start') snapshots[payload.accountId] = { status: 'pending', authorizationId: `auth-${payload.accountId}`,
          userCode: `CODE-${payload.accountId}`, verificationUri: 'https://login.dingtalk.com/oauth2/auth?state=fixture' };
        if (payload.operation === 'cancel' || payload.operation === 'reset') snapshots[payload.accountId] = { status: 'needs_auth' };
        return respond(snapshots[payload.accountId]);
      }
      return original?.(event, request);
    });
  });
  await completeSetup(page);
  await page.getByTestId('sidebar-nav-channels').click();
  const one = page.getByTestId('dingtalk-workspace-one');
  const two = page.getByTestId('dingtalk-workspace-two');
  await one.getByRole('button', { name: 'Authorize workspace' }).click();
  await two.getByRole('button', { name: 'Authorize workspace' }).click();
  await expect(one.getByText('CODE-one')).toBeVisible();
  await expect(two.getByText('CODE-two')).toBeVisible();
  await one.getByRole('button', { name: 'Cancel authorization' }).click();
  await expect(one.getByText('CODE-one')).not.toBeVisible();
  await expect(two.getByText('CODE-two')).toBeVisible();
  await electronApp.evaluate(() => {
    const fixture = (globalThis as unknown as { __dwsFixture: { snapshots: Record<string, unknown> } }).__dwsFixture;
    fixture.snapshots.two = { status: 'authorized' };
  });
  await expect(two.getByText('Workspace authorized for this account.')).toBeVisible();
  await two.getByRole('button', { name: 'Disconnect workspace' }).click();
  await expect(two.getByRole('button', { name: 'Authorize workspace' })).toBeEnabled();
  const calls = await electronApp.evaluate(() => (globalThis as unknown as { __dwsFixture: { calls: unknown[] } }).__dwsFixture.calls);
  expect(calls).toContainEqual({ accountId: 'one', operation: 'cancel', authorizationId: 'auth-one' });
});
