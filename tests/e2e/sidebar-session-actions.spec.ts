import type { ElectronApplication, Page } from '@playwright/test';
import {
  closeElectronApp,
  expect,
  getStableWindow,
  installIpcMocks,
  test,
} from './fixtures/electron';

const PINNED_SESSION_KEY = 'agent:main:pinned-conversation';
const TARGET_SESSION_KEY = 'agent:main:roadmap-conversation';
const ARCHIVED_SESSION_KEY = 'agent:main:archived-conversation';
const WORKSPACE = '/workspace/launch';
const WORKSPACE_URI = 'file:///workspace/launch';
const NOW = '2026-08-24T00:00:00.000Z';

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
    .join(',')}}`;
}

const conversations = [
  {
    id: TARGET_SESSION_KEY,
    title: 'Roadmap research',
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:06.000Z',
    workspaceUri: WORKSPACE_URI,
    lastKernelId: 'openclaw',
    kernelIds: ['openclaw', 'deepseek-harness'],
    lastAgentId: 'main',
    sourceChannel: 'telegram',
    hasActiveRun: true,
  },
  {
    id: PINNED_SESSION_KEY,
    title: 'Pinned planning',
    createdAt: '2026-08-23T00:00:00.000Z',
    updatedAt: '2026-08-23T00:00:06.000Z',
    pinnedAt: '2026-08-23T00:00:07.000Z',
    workspaceUri: WORKSPACE_URI,
    lastKernelId: 'deepseek-harness',
    kernelIds: ['deepseek-harness'],
    lastAgentId: 'main',
    sourceChannel: 'webchat',
  },
  {
    id: ARCHIVED_SESSION_KEY,
    title: 'Paginated archive',
    createdAt: '2026-08-22T00:00:00.000Z',
    updatedAt: '2026-08-22T00:00:06.000Z',
    workspaceUri: WORKSPACE_URI,
    lastKernelId: 'openclaw',
    kernelIds: ['openclaw'],
    lastAgentId: 'main',
    sourceChannel: 'webchat',
  },
];

function exportConversation(id: string) {
  const conversation = conversations.find(item => item.id === id) ?? conversations[0]!;
  return {
    schema: 'clawx.conversation-export/v1',
    conversation,
    turns: [{
      id: `turn-user-${id}`,
      role: 'user',
      position: 0,
      createdAt: conversation.createdAt,
      blocks: [{ id: `prompt-${id}`, type: 'text', visibility: 'portable', text: 'Offline canonical question' }],
    }, {
      id: `turn-assistant-${id}`,
      role: 'assistant',
      position: 1,
      createdAt: conversation.updatedAt,
      blocks: [{ id: `answer-${id}`, type: 'text', visibility: 'portable', text: 'Offline canonical answer' }],
    }],
    runs: [{
      id: `run-${id}`,
      turnId: `turn-user-${id}`,
      assistantTurnId: `turn-assistant-${id}`,
      kernelId: conversation.lastKernelId,
      kernelVersion: conversation.lastKernelId === 'openclaw' ? '2026.8.1-clawx.1' : '0.1.0-clawx.1',
      generation: 1,
      agentId: 'main',
      agentSnapshot: {
        agentId: 'main',
        displayName: 'Main',
        kernelId: conversation.lastKernelId,
        workspaceUri: WORKSPACE_URI,
        canonicalVersion: 1,
      },
      workspaceUri: WORKSPACE_URI,
      status: 'completed',
      createdAt: conversation.createdAt,
      startedAt: conversation.createdAt,
      completedAt: conversation.updatedAt,
      events: [],
    }],
    usage: [],
  };
}

async function installOfflineConversationMocks(app: ElectronApplication): Promise<void> {
  await installIpcMocks(app, {
    kernelFixture: {
      catalog: {
        source: 'network',
        stale: false,
        refreshedAt: NOW,
        entries: [
          {
            kernelId: 'openclaw',
            displayName: 'OpenClaw',
            installation: { kernelId: 'openclaw', state: 'not-installed', updatedAt: NOW },
            runtime: { kernelId: 'openclaw', state: 'not-installed', generation: 0, diagnostics: [] },
            updateAvailable: false,
            installAllowed: true,
            compatibilityFailures: [],
          },
          {
            kernelId: 'deepseek-harness',
            displayName: 'DeepSeek Harness',
            installation: { kernelId: 'deepseek-harness', state: 'not-installed', updatedAt: NOW },
            runtime: { kernelId: 'deepseek-harness', state: 'not-installed', generation: 0, diagnostics: [] },
            updateAvailable: false,
            installAllowed: true,
            compatibilityFailures: [],
          },
        ],
      },
      runtimes: [
        { kernelId: 'openclaw', state: 'not-installed', generation: 0, diagnostics: [] },
        { kernelId: 'deepseek-harness', state: 'not-installed', generation: 0, diagnostics: [] },
      ],
    },
    hostApi: {
      [stableStringify(['settings', 'getAll', null])]: {
        language: 'en',
        setupComplete: true,
        chatWorkspacePath: WORKSPACE,
        recentWorkspacePaths: [WORKSPACE],
        workspaceLabels: { [WORKSPACE]: 'Launch workspace' },
      },
      [stableStringify(['agents', 'list', null])]: {
        success: true,
        agents: [{
          id: 'main',
          name: 'Main',
          workspace: WORKSPACE,
          mainSessionKey: TARGET_SESSION_KEY,
          supportedKernels: ['openclaw', 'deepseek-harness'],
          defaultForKernels: [],
          projections: [],
          channelTypes: [],
        }],
        defaultAgentId: 'main',
        configuredChannelTypes: [],
        channelOwners: {},
        channelAccountOwners: {},
      },
      [stableStringify(['files', 'resolveWorkspaceContext', {
        workspaceRoot: WORKSPACE,
        executionCwd: WORKSPACE,
      }])]: { ok: true, workspaceRoot: WORKSPACE, executionCwd: WORKSPACE },
    },
  });

  await app.evaluate(async ({ app: _app }, input) => {
    const { ipcMain } = process.mainModule!.require('electron') as typeof import('electron');
    const handlers = (ipcMain as unknown as {
      _invokeHandlers?: Map<string, (event: unknown, request: unknown) => Promise<unknown>>;
    })._invokeHandlers;
    const original = handlers?.get('host:invoke');
    const rows = input.rows as Array<Record<string, unknown>>;
    const requests: Array<{ module?: string; action?: string; payload?: Record<string, unknown> }> = [];
    const respond = (id: unknown, data: unknown) => ({
      id: typeof id === 'string' ? id : undefined,
      ok: true,
      data,
    });
    const matches = (row: Record<string, unknown>, payload: Record<string, unknown>) => {
      const query = String(payload.query ?? '').toLowerCase();
      if (query && !String(row.title ?? '').toLowerCase().includes(query)) return false;
      if (payload.lastKernelId && row.lastKernelId !== payload.lastKernelId) return false;
      if (payload.participatedKernelId
        && !(row.kernelIds as unknown[] | undefined)?.includes(payload.participatedKernelId)) return false;
      if (payload.agentId && row.lastAgentId !== payload.agentId) return false;
      if (payload.sourceChannel && row.sourceChannel !== payload.sourceChannel) return false;
      return true;
    };

    ipcMain.removeHandler('host:invoke');
    ipcMain.handle('host:invoke', async (event: unknown, request: {
      id?: string;
      module?: string;
      action?: string;
      payload?: Record<string, unknown>;
    }) => {
      requests.push({ module: request.module, action: request.action, payload: request.payload });
      const payload = request.payload ?? {};
      if (request.module === 'conversations' && request.action === 'list') {
        return request.payload?.cursor === 'page-2'
          ? respond(request.id, { items: [rows[2]] })
          : respond(request.id, { items: rows.slice(0, 2), nextCursor: 'page-2' });
      }
      if (request.module === 'conversations' && request.action === 'search') {
        return respond(request.id, rows.filter(row => matches(row, payload)));
      }
      if (request.module === 'conversations' && request.action === 'get') {
        return respond(request.id, input.exports[String(payload.id)] ?? null);
      }
      if (request.module === 'conversations' && request.action === 'export') {
        return respond(request.id, input.exports[String(payload.id)]);
      }
      if (request.module === 'conversations' && request.action === 'rename') {
        const row = rows.find(candidate => candidate.id === payload.id);
        if (row) row.title = payload.title;
        return respond(request.id, { success: true });
      }
      if (request.module === 'conversations' && request.action === 'pin') {
        const row = rows.find(candidate => candidate.id === payload.id);
        if (row) row.pinnedAt = payload.pinned ? new Date().toISOString() : undefined;
        return respond(request.id, { success: true });
      }
      if (request.module === 'conversations' && request.action === 'delete') {
        return respond(request.id, { success: true });
      }
      if (request.module === 'chat' && request.action === 'selectConversationKernel') {
        return { id: request.id, ok: false, error: { code: 'NO_KERNEL', message: 'No kernel installed' } };
      }
      return original?.(event, request) ?? respond(request.id, {});
    });
    Object.assign(globalThis, { __offlineConversationRequests: requests });
  }, {
    rows: conversations,
    exports: Object.fromEntries(conversations.map(row => [row.id, exportConversation(row.id)])),
  });
}

async function reloadStableWindow(app: ElectronApplication): Promise<Page> {
  const page = await getStableWindow(app);
  await page.reload();
  await expect(page.getByTestId('main-layout')).toBeVisible({ timeout: 30_000 });
  return page;
}

test.describe('canonical offline Conversation catalog', () => {
  test('paginates, filters, opens, renames, pins, exports, and deletes with no kernel installed', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      await installOfflineConversationMocks(app);
      const page = await reloadStableWindow(app);
      const target = page.getByTestId(`sidebar-session-${TARGET_SESSION_KEY}`);

      await expect(target).toBeVisible();
      await expect(page.getByTestId(`sidebar-session-${PINNED_SESSION_KEY}`)).toBeVisible();
      await expect(page.getByTestId(`sidebar-session-${ARCHIVED_SESSION_KEY}`)).toHaveCount(0);
      await page.getByTestId('sidebar-catalog-load-more').click();
      await expect(page.getByTestId(`sidebar-session-${ARCHIVED_SESSION_KEY}`)).toBeVisible();

      await page.getByTestId('sidebar-search-button').click();
      await page.getByTestId('sidebar-session-search-input').fill('roadmap');
      await page.getByTestId('sidebar-session-filter-kernel').selectOption('deepseek-harness');
      await page.getByTestId('sidebar-session-filter-kernel-scope').selectOption('participated');
      await page.getByTestId('sidebar-session-filter-source').selectOption('telegram');
      await page.getByTestId('sidebar-session-filter-workspace').selectOption(WORKSPACE);
      await page.getByTestId('sidebar-session-filter-attention').selectOption('busy');
      await expect.poll(async () => app.evaluate(() => (
        (globalThis as typeof globalThis & {
          __offlineConversationRequests?: Array<{ module?: string; action?: string; payload?: Record<string, unknown> }>;
        }).__offlineConversationRequests?.some(request => (
          request.module === 'conversations'
          && request.action === 'search'
          && request.payload?.query === 'roadmap'
          && request.payload?.participatedKernelId === 'deepseek-harness'
          && request.payload?.sourceChannel === 'telegram'
        )) ?? false
      ))).toBe(true);
      await expect(page.getByTestId(`sidebar-session-search-result-${TARGET_SESSION_KEY}`))
        .toContainText('Roadmap research');
      await expect(page.getByTestId(`sidebar-session-search-result-${PINNED_SESSION_KEY}`)).toHaveCount(0);
      await page.getByTestId(`sidebar-session-search-result-${TARGET_SESSION_KEY}`).click();

      await expect(page.getByText('Offline canonical question')).toBeVisible();
      await expect(page.getByText('Offline canonical answer')).toBeVisible();
      await expect(page.getByTestId('chat-kernel-selector')).toBeDisabled();
      await expect(page.getByTestId('sidebar-kernel-status-openclaw')).toContainText('Not installed');
      await expect(page.getByTestId('sidebar-kernel-status-deepseek-harness')).toContainText('Not installed');

      await target.dblclick();
      await page.getByTestId('sidebar-session-rename-input').fill('Offline roadmap');
      await page.getByTestId('sidebar-session-rename-input').press('Enter');
      await expect(target).toContainText('Offline roadmap');

      await target.click({ button: 'right' });
      await page.getByTestId(`sidebar-session-context-pin-${TARGET_SESSION_KEY}`).click({ force: true });
      await expect(page.getByTestId(`sidebar-session-pinned-${TARGET_SESSION_KEY}`)).toBeVisible();

      await target.click({ button: 'right' });
      await page.getByTestId(`sidebar-session-context-export-${TARGET_SESSION_KEY}`).click({ force: true });
      await expect.poll(async () => app.evaluate(() => (
        (globalThis as typeof globalThis & {
          __offlineConversationRequests?: Array<{ module?: string; action?: string }>;
        }).__offlineConversationRequests?.some(request => (
          request.module === 'conversations' && request.action === 'export'
        )) ?? false
      ))).toBe(true);

      await target.hover();
      await page.getByTestId(`sidebar-session-delete-${TARGET_SESSION_KEY}`).click();
      await page.getByTestId('confirm-dialog-confirm-button').click();
      await expect(target).toHaveCount(0);

      const requests = await app.evaluate(() => (
        (globalThis as typeof globalThis & {
          __offlineConversationRequests?: Array<{ module?: string; action?: string; payload?: Record<string, unknown> }>;
        }).__offlineConversationRequests ?? []
      ));
      const conversationRequests = requests.filter(request => request.module === 'conversations');
      expect(conversationRequests.some(request => (
        request.action === 'list' && request.payload?.limit === 100 && !request.payload.cursor
      )), 'initial canonical page').toBe(true);
      expect(conversationRequests.some(request => (
        request.action === 'list' && request.payload?.limit === 100 && request.payload.cursor === 'page-2'
      )), 'cursor page').toBe(true);
      expect(conversationRequests.some(request => (
        request.action === 'search'
        && request.payload?.query === 'roadmap'
        && request.payload?.participatedKernelId === 'deepseek-harness'
        && request.payload?.sourceChannel === 'telegram'
      )), 'filtered canonical search').toBe(true);
      expect(conversationRequests.some(request => (
        request.action === 'get' && request.payload?.id === TARGET_SESSION_KEY
      )), 'offline canonical get').toBe(true);
      for (const action of ['rename', 'pin', 'export', 'delete']) {
        expect(conversationRequests.some(request => (
          request.action === action && request.payload?.id === TARGET_SESSION_KEY
        )), `canonical ${action}`).toBe(true);
      }
      expect(conversationRequests.find(request => request.action === 'delete')?.payload?.hard).toBe(true);
      expect(requests.some(request => request.module === 'sessions')).toBe(false);
      expect(requests.some(request => request.module === 'chat' && request.action === 'selectConversationKernel')).toBe(false);
    } finally {
      await closeElectronApp(app);
    }
  });
});
