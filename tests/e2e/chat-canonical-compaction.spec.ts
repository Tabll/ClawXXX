import { closeElectronApp, expect, getStableWindow, installAttachmentHostFixture, test } from './fixtures/electron';

const sessionKey = 'canonical-compaction';
const compaction = (status: string, willRetry = false) => ({
  sessionUpdate: 'session_info_update',
  _meta: { 'clawx/compaction': { version: 1, compactionId: 'compact-one', status, source: 'runtime', willRetry } },
});

test('renders and restores canonical compaction and run-scoped plans', async ({ launchElectronApp }) => {
  const app = await launchElectronApp({ skipSetup: true });
  try {
    const fixture = await installAttachmentHostFixture(app, { sessions: [{ key: sessionKey, title: 'Compaction' }] });
    const updates = [
      { sessionUpdate: 'plan', entries: [{ content: 'Inspect canonical history', priority: 'high', status: 'in_progress' }] },
      compaction('in_progress'),
    ];
    await fixture.setPromptUpdates('Inspect context', updates);
    await fixture.deferPromptResponse('Inspect context');
    const page = await getStableWindow(app);
    await page.reload();
    await page.getByTestId('chat-composer-input').fill('Inspect context');
    await page.getByTestId('chat-composer-send').click();
    await expect(page.getByTestId('acp-plan-item')).toContainText('Inspect canonical history');
    await expect(page.getByTestId('acp-compaction-status')).toContainText('Compacting');
    await fixture.emitAcpSessionUpdates({ sessionKey, updates: [compaction('completed', true)] });
    await expect(page.getByTestId('acp-compaction-status')).toContainText('continuing');
    await fixture.releasePromptResponse('Inspect context');
    await fixture.setSessionReplay(sessionKey, [
      { sessionUpdate: 'user_message', messageId: 'user', content: [{ type: 'text', text: 'Inspect context' }] },
      ...updates, compaction('completed', true),
      { sessionUpdate: 'agent_message', messageId: 'answer', content: [{ type: 'text', text: 'Context inspected' }] },
    ]);
    await page.reload();
    await expect(page.getByTestId('acp-compaction-status')).toContainText('continuing');
    await expect(page.getByTestId('acp-compaction-status')).not.toHaveAttribute('role', 'status');
    await expect(page.getByTestId('acp-plan-item')).toContainText('Inspect canonical history');
  } finally { await closeElectronApp(app); }
});
