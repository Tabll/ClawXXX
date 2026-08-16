import type { ElectronApplication, Page } from '@playwright/test';
import {
  closeElectronApp,
  expect,
  getRecordedHostInvocations,
  getStableWindow,
  installIpcMocks,
  test,
} from './fixtures/electron';

const PINNED_SESSION_KEY = 'agent:main:pinned-conversation';
const TARGET_SESSION_KEY = 'agent:main:roadmap-conversation';
const DEFAULT_SESSION_KEY = 'agent:main:main';
const WORKSPACE = '/workspace/launch';
const LIST_TS = 1_755_000_000_000;
const SESSIONS_LIST_PAYLOAD = { includeDerivedTitles: true, includeLastMessage: true };

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
    .join(',')}}`;
}

function acpLoadResponse(sessionKey: string) {
  const basePayload = {
    sessionKey,
    workspaceRoot: WORKSPACE,
    cwd: WORKSPACE,
  };
  return {
    [stableStringify(['chat', 'loadAcpSession', basePayload])]: { success: true, generation: 1 },
    [stableStringify(['chat', 'loadAcpSession', {
      ...basePayload,
      createIfMissing: true,
    }])]: { success: true, generation: 1 },
  };
}

function pinMetadataResponse(sessionKeys: string[]) {
  return {
    success: true,
    summaries: sessionKeys.map((sessionKey) => ({
      sessionKey,
      firstUserText: null,
      lastTimestamp: null,
      workspacePath: null,
      pinned: sessionKey === PINNED_SESSION_KEY,
    })),
  };
}

async function installSidebarActionMocks(app: ElectronApplication): Promise<void> {
  const sessions = [
    {
      key: TARGET_SESSION_KEY,
      displayName: 'Roadmap research',
      derivedTitle: 'Roadmap research',
      workspacePath: WORKSPACE,
      updatedAt: LIST_TS,
      status: 'done',
      hasActiveRun: false,
    },
    {
      key: PINNED_SESSION_KEY,
      displayName: 'Pinned planning',
      derivedTitle: 'Pinned planning',
      workspacePath: WORKSPACE,
      updatedAt: LIST_TS - 10_000,
      status: 'done',
      hasActiveRun: false,
    },
  ];
  const sessionKeys = sessions.map((session) => session.key);
  const sessionList = { success: true, result: { ts: LIST_TS, sessions } };

  await installIpcMocks(app, {
    recordHostInvocations: true,
    gatewayStatus: {
      state: 'running',
      gatewayReady: true,
      port: 18789,
      pid: 5252,
      connectedAt: LIST_TS - 100_000,
    },
    gatewayRpc: {
      [stableStringify(['sessions.subscribe', {}])]: { success: true, result: {} },
      [stableStringify(['sessions.list', SESSIONS_LIST_PAYLOAD])]: sessionList,
      [stableStringify(['sessions.list', {}])]: sessionList,
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
        agents: [{ id: 'main', name: 'Main', workspace: WORKSPACE, mainSessionKey: TARGET_SESSION_KEY }],
        defaultAgentId: 'main',
      },
      [stableStringify(['sessions', 'summaries', { sessionKeys, metadataOnly: true }])]: {
        ...pinMetadataResponse(sessionKeys),
      },
      [stableStringify(['sessions', 'summaries', {
        sessionKeys: [...sessionKeys, DEFAULT_SESSION_KEY],
        metadataOnly: true,
      }])]: pinMetadataResponse([...sessionKeys, DEFAULT_SESSION_KEY]),
      [stableStringify(['sessions', 'summaries', {
        sessionKeys: [DEFAULT_SESSION_KEY],
        metadataOnly: true,
      }])]: pinMetadataResponse([DEFAULT_SESSION_KEY]),
      [stableStringify(['sessions', 'pin', { id: TARGET_SESSION_KEY, pinned: true }])]: {
        success: true,
      },
      [stableStringify(['sessions', 'delete', { id: TARGET_SESSION_KEY }])]: {
        success: true,
      },
      [stableStringify(['files', 'resolveWorkspaceContext', {
        workspaceRoot: WORKSPACE,
        executionCwd: WORKSPACE,
      }])]: { ok: true, workspaceRoot: WORKSPACE, executionCwd: WORKSPACE },
      ...acpLoadResponse(PINNED_SESSION_KEY),
      ...acpLoadResponse(TARGET_SESSION_KEY),
      ...acpLoadResponse(DEFAULT_SESSION_KEY),
    },
  });
}

async function reloadStableWindow(app: ElectronApplication): Promise<Page> {
  const page = await getStableWindow(app);
  try {
    await page.reload();
  } catch (error) {
    if (!String(error).includes('ERR_FILE_NOT_FOUND')) throw error;
  }
  await expect(page.getByTestId('main-layout')).toBeVisible({ timeout: 30_000 });
  return page;
}

async function appearsBefore(page: Page, firstTestId: string, secondTestId: string): Promise<boolean> {
  return page.evaluate(([first, second]) => {
    const firstNode = document.querySelector(`[data-testid="${first}"]`);
    const secondNode = document.querySelector(`[data-testid="${second}"]`);
    return Boolean(
      firstNode
      && secondNode
      && (firstNode.compareDocumentPosition(secondNode) & Node.DOCUMENT_POSITION_FOLLOWING),
    );
  }, [firstTestId, secondTestId]);
}

test.describe('ClawX sidebar conversation actions', () => {
  test('pins, searches, and batch-deletes within the workspace-grouped sidebar', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      await installSidebarActionMocks(app);
      const page = await reloadStableWindow(app);
      const pinnedTestId = `sidebar-session-${PINNED_SESSION_KEY}`;
      const targetTestId = `sidebar-session-${TARGET_SESSION_KEY}`;

      await expect(page.getByTestId(pinnedTestId)).toBeVisible();
      await expect(page.getByTestId(targetTestId)).toBeVisible();
      await expect.poll(() => appearsBefore(page, pinnedTestId, targetTestId)).toBe(true);

      await page.getByTestId(targetTestId).click({ button: 'right' });
      await expect(page.getByTestId('sidebar-session-context-menu')).toBeVisible();
      await page.getByTestId(`sidebar-session-context-pin-${TARGET_SESSION_KEY}`).click();
      await expect(page.getByTestId(`sidebar-session-pinned-${TARGET_SESSION_KEY}`)).toBeVisible();
      await expect.poll(() => appearsBefore(page, targetTestId, pinnedTestId)).toBe(true);

      await page.getByTestId('sidebar-search-button').click();
      await page.getByTestId('sidebar-session-search-input').fill('roadmap');
      await expect(page.getByTestId(`sidebar-session-search-result-${TARGET_SESSION_KEY}`)).toContainText(
        'Roadmap research',
      );
      await expect(page.getByTestId(`sidebar-session-search-result-${PINNED_SESSION_KEY}`)).toHaveCount(0);
      await page.getByTestId(`sidebar-session-search-result-${TARGET_SESSION_KEY}`).click();
      await expect(page.getByTestId('sidebar-session-search-dialog')).toHaveCount(0);

      await page.getByTestId('sidebar-more-button').click();
      const batchOperationOption = page.getByTestId('sidebar-batch-operation-option');
      await expect(page.getByTestId('sidebar-more-menu')).toBeVisible();
      await expect(batchOperationOption).toBeVisible();
      await batchOperationOption.click();
      await page.getByTestId(`sidebar-session-select-${TARGET_SESSION_KEY}`).check();
      await expect(page.getByTestId('sidebar-batch-selected-count')).toHaveText('1 selected');
      await page.getByTestId('sidebar-batch-delete-button').click();
      await page.getByTestId('confirm-dialog-confirm-button').click();
      await expect(page.getByTestId(targetTestId)).toHaveCount(0);

      await expect.poll(async () => (await getRecordedHostInvocations(app)).some((entry) => (
        entry.module === 'sessions'
        && entry.action === 'pin'
        && entry.payload?.id === TARGET_SESSION_KEY
        && entry.payload?.pinned === true
      ))).toBe(true);
      await expect.poll(async () => (await getRecordedHostInvocations(app)).some((entry) => (
        entry.module === 'sessions'
        && entry.action === 'delete'
        && entry.payload?.id === TARGET_SESSION_KEY
      ))).toBe(true);
    } finally {
      await closeElectronApp(app);
    }
  });
});
