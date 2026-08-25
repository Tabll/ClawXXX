import type { ElectronApplication } from '@playwright/test';
import {
  closeElectronApp,
  expect,
  getRecordedHostInvocations,
  getStableWindow,
  installIpcMocks,
  readyKernelFixture,
  test,
} from './fixtures/electron';

const MAIN_SESSION_KEY = 'agent:main:main';
const CRON_BASE_KEY = 'cron:job-cron-live:reuse';
const CRON_TRIGGER_TEXT = '[cron:job-cron-live] Summarize today important AI news';
const DEFAULT_WORKSPACE = '~/.openclaw/workspace';
const CRON_RUN_ID = 'run:cron-live';
const CRON_TURN_ID = 'turn:cron-trigger';

type AcpSessionUpdate = Record<string, unknown> & { sessionUpdate: string };

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);
  return `{${entries.join(',')}}`;
}

function canonicalConversationMocks(
  title: string,
  history: Array<{ id: string; role: 'user' | 'assistant'; content: string; timestamp: number }> = [],
  active = false,
) {
  const mainSummary = {
    id: MAIN_SESSION_KEY,
    title: 'main',
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:01.000Z',
    workspaceUri: DEFAULT_WORKSPACE,
    lastKernelId: 'openclaw',
    ...(active ? { hasActiveRun: true } : {}),
  };
  const cronSummary = {
    id: CRON_BASE_KEY,
    title,
    createdAt: '2026-08-24T00:00:02.000Z',
    updatedAt: '2026-08-24T00:00:03.000Z',
    workspaceUri: DEFAULT_WORKSPACE,
    lastKernelId: 'openclaw',
  };
  const exportFor = (summary: typeof mainSummary, messages = history) => {
    const turns = messages.map((message, position) => ({
      id: `turn:${message.id}`,
      role: message.role,
      position,
      createdAt: new Date(message.timestamp).toISOString(),
      blocks: [{
        id: `block:${message.id}`,
        type: 'text',
        visibility: 'portable',
        text: message.content,
      }],
    }));
    const user = turns.find(turn => turn.role === 'user');
    const assistant = turns.find(turn => turn.role === 'assistant');
    return {
      schema: 'clawx.conversation-export/v1',
      conversation: summary,
      turns,
      runs: user ? [{
        id: active ? CRON_RUN_ID : 'run:cron-history',
        turnId: user.id,
        ...(assistant ? { assistantTurnId: assistant.id } : {}),
        kernelId: 'openclaw',
        kernelVersion: '2026.7.1-2+clawx.6',
        generation: 1,
        agentId: 'main',
        agentSnapshot: {
          agentId: 'main',
          displayName: 'Main',
          kernelId: 'openclaw',
          workspaceUri: DEFAULT_WORKSPACE,
          canonicalVersion: 1,
        },
        workspaceUri: DEFAULT_WORKSPACE,
        status: active ? 'running' : 'completed',
        createdAt: user.createdAt,
        startedAt: user.createdAt,
        ...(assistant ? { completedAt: assistant.createdAt } : {}),
        events: [],
      }] : [],
      usage: [],
    };
  };
  const loadResult = (conversationId: string, resume = false) => ({
    success: true,
    generation: 1,
    conversationId,
    kernelId: 'openclaw',
    ...(resume ? {
      runId: CRON_RUN_ID,
      turnId: CRON_TURN_ID,
      resumedActivePrompt: true,
    } : {}),
  });
  return {
    [stableStringify(['conversations', 'list', { limit: 100 }])]: { items: [mainSummary, cronSummary] },
    [stableStringify(['conversations', 'get', { id: MAIN_SESSION_KEY }])]: exportFor(mainSummary, []),
    [stableStringify(['conversations', 'get', { id: CRON_BASE_KEY }])]: exportFor(cronSummary),
    [stableStringify(['chat', 'selectConversationKernel', {
      sessionKey: MAIN_SESSION_KEY,
      workspaceRoot: DEFAULT_WORKSPACE,
      cwd: DEFAULT_WORKSPACE,
      kernelId: 'openclaw',
    }])]: loadResult(MAIN_SESSION_KEY),
    [stableStringify(['chat', 'selectConversationKernel', {
      sessionKey: CRON_BASE_KEY,
      workspaceRoot: DEFAULT_WORKSPACE,
      cwd: DEFAULT_WORKSPACE,
      kernelId: 'openclaw',
    }])]: loadResult(CRON_BASE_KEY, active),
  };
}

async function emitKernelToolUpdates(
  app: ElectronApplication,
  sessionKey: string,
  updates: AcpSessionUpdate[],
  firstEventSeq: number,
) {
  await app.evaluate(
    async ({ app: _app }, payload) => {
      const { BrowserWindow } = process.mainModule!.require('electron') as typeof import('electron');
      for (const [index, update] of payload.updates.entries()) {
        const { sessionUpdate, ...eventPayload } = update;
        const kind = sessionUpdate === 'tool_call' ? 'tool.start' : 'tool.result';
        for (const window of BrowserWindow.getAllWindows()) {
          window.webContents.send('chat:kernel-event', {
            protocol: 'clawx.kernel/v1',
            conversationId: payload.sessionKey,
            turnId: payload.turnId,
            runId: payload.runId,
            kernelId: 'openclaw',
            generation: 1,
            eventSeq: payload.firstEventSeq + index,
            emittedAt: new Date().toISOString(),
            event: { kind, payload: eventPayload },
          });
        }
      }
    },
    { sessionKey, updates, firstEventSeq, turnId: CRON_TURN_ID, runId: CRON_RUN_ID },
  );
}

test.describe('ClawX cron run live status', () => {
  test('renders ACP live status for a cron run without switching sessions', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installIpcMocks(app, {
        gatewayStatus: { state: 'running', port: 18789, pid: 12345, gatewayReady: true },
        kernelFixture: readyKernelFixture(),
        gatewayRpc: {},
        hostApi: {
          ...canonicalConversationMocks('Cron: 早报', [{
            id: 'cron-trigger',
            role: 'user',
            content: CRON_TRIGGER_TEXT,
            timestamp: Date.now() - 1_000,
          }], true),
          [stableStringify(['/api/gateway/status', 'GET'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: { state: 'running', port: 18789, pid: 12345, gatewayReady: true },
            },
          },
          [stableStringify(['/api/agents', 'GET'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: { success: true, agents: [{ id: 'main', name: 'Main', workspace: DEFAULT_WORKSPACE, mainSessionKey: MAIN_SESSION_KEY }] },
            },
          },
        },
      });

      const page = await getStableWindow(app);
      try {
        await page.reload();
      } catch (error) {
        if (!String(error).includes('ERR_FILE_NOT_FOUND')) {
          throw error;
        }
      }

      await expect(page.getByTestId('main-layout')).toBeVisible({ timeout: 30_000 });

      // Open the cron session (default startup lands on the main session).
      const cronSidebarButton = page.getByTestId(`sidebar-session-${CRON_BASE_KEY}`);
      await expect(cronSidebarButton).toBeVisible({ timeout: 30_000 });
      await cronSidebarButton.click();

      await expect(page.getByText(CRON_TRIGGER_TEXT)).toBeVisible({ timeout: 30_000 });

      await emitKernelToolUpdates(app, CRON_BASE_KEY, [{
        sessionUpdate: 'tool_call',
        toolCallId: 'call-web-search',
        title: 'web_search',
        status: 'in_progress',
        content: [{ type: 'content', content: { type: 'text', text: 'AI news June 2026' } }],
        locations: [],
      }], 1);

      await expect(page.getByTestId('acp-tool-call-card')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('acp-tool-call-card')).toContainText('web_search');

      await emitKernelToolUpdates(app, CRON_BASE_KEY, [{
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-web-search',
        title: 'web_search',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'Search complete' } }],
        locations: [],
      }], 2);

      await expect(page.getByText(CRON_TRIGGER_TEXT)).toBeVisible();
    } finally {
      await closeElectronApp(app);
    }
  });

  test('shows cron run summaries when ACP replay is empty', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    const completeCronReply = `该喝水了！💧\n\n${'补充说明 '.repeat(500)}\n\n完整回复结尾`;

    try {
      await installIpcMocks(app, {
        recordHostInvocations: true,
        gatewayStatus: { state: 'running', port: 18789, pid: 12345, gatewayReady: true },
        kernelFixture: readyKernelFixture(),
        gatewayRpc: {},
        hostApi: {
          ...canonicalConversationMocks('Cron: 喝水提醒', [
            { id: 'cron-prompt', role: 'user', content: '提醒我喝水', timestamp: Date.now() - 5000 },
            { id: 'cron-result', role: 'assistant', content: completeCronReply, timestamp: Date.now() },
          ]),
          [stableStringify(['/api/gateway/status', 'GET'])]: {
            ok: true,
            data: { status: 200, ok: true, json: { state: 'running', port: 18789, pid: 12345, gatewayReady: true } },
          },
          [stableStringify(['/api/agents', 'GET'])]: {
            ok: true,
            data: { status: 200, ok: true, json: { success: true, agents: [{ id: 'main', name: 'Main', workspace: DEFAULT_WORKSPACE, mainSessionKey: MAIN_SESSION_KEY }] } },
          },
        },
      });

      const page = await getStableWindow(app);
      try {
        await page.reload();
      } catch (error) {
        if (!String(error).includes('ERR_FILE_NOT_FOUND')) throw error;
      }

      await expect(page.getByTestId('main-layout')).toBeVisible({ timeout: 30_000 });
      const cronSidebarButton = page.getByTestId(`sidebar-session-${CRON_BASE_KEY}`);
      await expect(cronSidebarButton).toBeVisible({ timeout: 30_000 });
      await cronSidebarButton.click();

      await expect.poll(async () => (await getRecordedHostInvocations(app)).some((call) => (
        call.module === 'conversations'
        && call.action === 'get'
        && call.payload?.id === CRON_BASE_KEY
      ))).toBe(true);
      expect((await getRecordedHostInvocations(app)).some((call) => (
        call.module === 'cron' && call.action === 'sessionHistory'
      ))).toBe(false);
      await expect(page.getByText('提醒我喝水')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText('该喝水了！💧')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText('完整回复结尾')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('acp-chat-empty-state')).toHaveCount(0);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('adopts an already-running cron run joined mid-flight (no run.started received)', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installIpcMocks(app, {
        gatewayStatus: { state: 'running', port: 18789, pid: 12345, gatewayReady: true },
        kernelFixture: readyKernelFixture(),
        gatewayRpc: {},
        hostApi: {
          ...canonicalConversationMocks('Cron: 早报', [{
            id: 'cron-trigger',
            role: 'user',
            content: CRON_TRIGGER_TEXT,
            timestamp: Date.now() - 1_000,
          }], true),
          [stableStringify(['/api/gateway/status', 'GET'])]: {
            ok: true,
            data: { status: 200, ok: true, json: { state: 'running', port: 18789, pid: 12345, gatewayReady: true } },
          },
          [stableStringify(['/api/agents', 'GET'])]: {
            ok: true,
            data: { status: 200, ok: true, json: { success: true, agents: [{ id: 'main', name: 'Main', workspace: DEFAULT_WORKSPACE, mainSessionKey: MAIN_SESSION_KEY }] } },
          },
        },
      });

      const page = await getStableWindow(app);
      try {
        await page.reload();
      } catch (error) {
        if (!String(error).includes('ERR_FILE_NOT_FOUND')) {
          throw error;
        }
      }

      await expect(page.getByTestId('main-layout')).toBeVisible({ timeout: 30_000 });
      const cronSidebarButton = page.getByTestId(`sidebar-session-${CRON_BASE_KEY}`);
      await expect(cronSidebarButton).toBeVisible({ timeout: 30_000 });
      await cronSidebarButton.click();
      await expect(page.getByText(CRON_TRIGGER_TEXT)).toBeVisible({ timeout: 30_000 });

      // Simulate joining a run already in progress: the first ACP update the
      // renderer sees is a tool card, and it still renders live in the current session.
      await emitKernelToolUpdates(app, CRON_BASE_KEY, [{
        sessionUpdate: 'tool_call',
        toolCallId: 'call-read-skill',
        title: 'read',
        status: 'in_progress',
        content: [{ type: 'content', content: { type: 'text', text: '~/.openclaw/skills/docx/SKILL.md' } }],
        locations: [],
      }], 1);

      await expect(page.getByTestId('acp-tool-call-card')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('acp-tool-call-card')).toContainText('read');

      await emitKernelToolUpdates(app, CRON_BASE_KEY, [{
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-read-skill',
        title: 'read',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'Read complete' } }],
        locations: [],
      }], 2);

      await expect(page.getByText(CRON_TRIGGER_TEXT)).toBeVisible();
    } finally {
      await closeElectronApp(app);
    }
  });
});
