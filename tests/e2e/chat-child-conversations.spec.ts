import { closeElectronApp, expect, getStableWindow, installAttachmentHostFixture, test } from './fixtures/electron';

test('streams canonical child previews, restores status and opens an independent child conversation', async ({ launchElectronApp }) => {
  const app = await launchElectronApp({ skipSetup: true });
  try {
    const fixture = await installAttachmentHostFixture(app, { sessions: [{ key: 'parent', title: 'Parent work' }, { key: 'child', title: 'Child research' }] });
    await fixture.setSessionReplay('child', [
      { sessionUpdate: 'user_message', messageId: 'u-child', content: [{ type: 'text', text: 'Research independently' }] },
      { sessionUpdate: 'agent_message', messageId: 'a-child', content: [{ type: 'text', text: 'First child result' }] },
    ]);
    await app.evaluate(({ ipcMain }) => {
      const original = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: unknown, request: unknown) => unknown> })._invokeHandlers.get('host:invoke');
      const state = { status: 'running' }; Object.assign(globalThis, { __childFixture: state });
      ipcMain.removeHandler('host:invoke');
      ipcMain.handle('host:invoke', (event, request) => {
        if (request.module === 'conversations' && request.action === 'children') return { id: request.id, ok: true, data: request.payload.id === 'parent' ? [{
          parentRunId: 'parent-run', runId: 'child-run', conversationId: 'child', kernelId: 'openclaw', agentId: 'main',
          title: 'Child research', status: state.status, createdAt: new Date().toISOString(),
        }] : [] };
        return original?.(event, request);
      });
    });
    const page = await getStableWindow(app); await page.reload();
    await page.getByTestId('child-expand-child').click();
    await expect(page.getByTestId('child-conversation-preview')).toContainText('First child result');
    await expect(page.getByTestId('child-status-child')).toHaveText('Running');
    await fixture.setSessionReplay('child', [
      { sessionUpdate: 'user_message', messageId: 'u-child', content: [{ type: 'text', text: 'Research independently' }] },
      { sessionUpdate: 'agent_message', messageId: 'a-child', content: [{ type: 'text', text: 'Updated canonical child output' }] },
    ]);
    await app.evaluate(() => { (globalThis as unknown as { __childFixture: { status: string } }).__childFixture.status = 'completed'; });
    await expect(page.getByTestId('child-conversation-preview')).toContainText('Updated canonical child output');
    await expect(page.getByTestId('child-status-child')).toHaveText('Completed');
    await page.reload(); await expect(page.getByTestId('child-status-child')).toHaveText('Completed');
    await page.getByTestId('child-open-child').click();
    await expect(page.getByTestId('child-conversations')).toHaveCount(0);
    await expect(page.getByTestId('acp-chat-timeline')).toContainText('Updated canonical child output');
  } finally { await closeElectronApp(app); }
});
