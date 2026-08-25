import electronBinaryPath from 'electron';
import { _electron as electron, expect, test as base, type ElectronApplication, type Page } from '@playwright/test';
import { build as buildWithEsbuild } from 'esbuild';
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { KernelEventEnvelopeV1, KernelRuntimeSnapshot } from '../../../shared/kernels/contracts';
import type {
  ConversationExport,
  ConversationSummary,
} from '../../../shared/conversations/contracts';
import type {
  KernelCatalogSnapshot,
  KernelPackageProgressEvent,
} from '../../../shared/host-api/kernels';

export type LaunchElectronOptions = {
  skipSetup?: boolean;
  additionalArgs?: string[];
};

export type KernelFixtureOperation = {
  error?: string;
  result?: unknown;
  catalog?: KernelCatalogSnapshot;
  runtimes?: KernelRuntimeSnapshot[];
  progress?: KernelPackageProgressEvent[];
};

export type KernelHostFixtureConfig = {
  catalog: KernelCatalogSnapshot;
  runtimes: KernelRuntimeSnapshot[];
  operations?: Record<string, KernelFixtureOperation[]>;
};

type IpcMockConfig = {
  gatewayStatus?: Record<string, unknown>;
  gatewayRpc?: Record<string, unknown>;
  hostApi?: Record<string, unknown>;
  hostApiErrors?: Record<string, string>;
  recordHostInvocations?: boolean;
  recordLegacyIpcInvocations?: boolean;
  kernelFixture?: KernelHostFixtureConfig;
};

export type RecordedHostInvocation = {
  module?: string;
  action?: string;
  payload?: Record<string, unknown>;
};

export type RecordedLegacyIpcInvocation = {
  channel: string;
  args: unknown[];
};

export type AttachmentFixtureSession = {
  key: string;
  title: string;
};

export type AttachmentOpenHandlersFixtureResult = {
  ok: boolean;
  platform?: 'darwin' | 'win32' | 'linux';
  handlers?: Array<{
    handlerId: string;
    name: string;
    iconDataUrl?: string;
    isDefault: boolean;
  }>;
  error?: string;
};

export type CanonicalConversationFixture = {
  id: string;
  title?: string;
  createdAt?: string | number;
  updatedAt?: string | number;
  workspaceUri?: string;
  lastKernelId?: 'openclaw' | 'deepseek-harness' | (string & {});
  kernelIds?: Array<'openclaw' | 'deepseek-harness' | (string & {})>;
  lastAgentId?: string;
  hasActiveRun?: boolean;
};

function fixtureIso(value: string | number | undefined, fallback: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return new Date(value).toISOString();
  return fallback;
}

/** Canonical SQLite catalog row used by E2E Host API fixtures. */
export function canonicalConversationSummary(
  input: CanonicalConversationFixture,
): ConversationSummary {
  const createdAt = fixtureIso(input.createdAt, '2026-08-24T00:00:00.000Z');
  const updatedAt = fixtureIso(input.updatedAt, createdAt);
  return {
    id: input.id as ConversationSummary['id'],
    ...(input.title ? { title: input.title } : {}),
    createdAt,
    updatedAt,
    ...(input.workspaceUri ? { workspaceUri: input.workspaceUri } : {}),
    ...(input.lastKernelId ? { lastKernelId: input.lastKernelId } : {}),
    ...(input.kernelIds ? { kernelIds: input.kernelIds } : {}),
    ...(input.lastAgentId ? { lastAgentId: input.lastAgentId } : {}),
    ...(input.hasActiveRun ? { hasActiveRun: true } : {}),
  } as ConversationSummary;
}

export function emptyCanonicalConversation(
  summary: ConversationSummary,
): ConversationExport {
  return {
    schema: 'clawx.conversation-export/v1',
    conversation: summary,
    turns: [],
    runs: [],
    usage: [],
  };
}

/** Exact Host API responses for the first canonical catalog page and exports. */
export function canonicalConversationHostApi(
  summaries: ConversationSummary[],
): Record<string, unknown> {
  return {
    [stableStringify(['conversations', 'list', { limit: 100 }])]: { items: summaries },
    ...Object.fromEntries(summaries.map(summary => [
      stableStringify(['conversations', 'get', { id: summary.id }]),
      emptyCanonicalConversation(summary),
    ])),
  };
}

export function readyKernelFixture(
  kernelId: 'openclaw' | 'deepseek-harness' = 'openclaw',
): KernelHostFixtureConfig {
  const displayName = kernelId === 'openclaw' ? 'OpenClaw' : 'DeepSeek Harness';
  const artifactVersion = kernelId === 'openclaw' ? '2026.8.1-clawx.1' : '0.1.1-clawx.1';
  const runtime: KernelRuntimeSnapshot = {
    kernelId,
    state: 'ready',
    generation: 1,
    artifactVersion,
    diagnostics: [],
  };
  return {
    catalog: {
      source: 'network',
      stale: false,
      refreshedAt: '2026-08-24T00:00:00.000Z',
      entries: [{
        kernelId,
        displayName,
        installation: {
          kernelId,
          state: 'installed',
          activeVersion: artifactVersion,
          updatedAt: '2026-08-24T00:00:00.000Z',
        },
        runtime,
        updateAvailable: false,
        installAllowed: true,
        compatibilityFailures: [],
      }],
    },
    runtimes: [runtime],
  };
}

export type AttachmentHostFixture = {
  workspaceDir: string;
  openClawMediaDir: string;
  outsideDir: string;
  createWorkspaceFile: (relativePath: string, data: string | Uint8Array) => Promise<string>;
  createWorkspaceDirectory: (relativePath: string) => Promise<string>;
  createOpenClawMediaFile: (relativePath: string, data: string | Uint8Array) => Promise<string>;
  createOutsideFile: (relativePath: string, data: string | Uint8Array) => Promise<string>;
  registerStagedAttachment: (id: string, stagedPath: string, displayPath?: string) => Promise<void>;
  emitAcpSessionUpdates: (input: {
    sessionKey: string;
    updates: Array<Record<string, unknown> & { sessionUpdate: string }>;
  }) => Promise<void>;
  setPromptUpdates: (
    prompt: string,
    updates: Array<Record<string, unknown> & { sessionUpdate: string }>,
  ) => Promise<void>;
  deferPromptResponse: (prompt: string) => Promise<void>;
  releasePromptResponse: (prompt: string, timeoutMs?: number) => Promise<void>;
  setSessionReplay: (
    sessionKey: string,
    updates: Array<Record<string, unknown> & { sessionUpdate: string }>,
  ) => Promise<void>;
  setOpenHandlersResult: (result: AttachmentOpenHandlersFixtureResult) => Promise<void>;
  getHostInvocations: () => Promise<RecordedHostInvocation[]>;
  getShellInvocations: () => Promise<RecordedHostInvocation[]>;
  clearInvocations: () => Promise<void>;
};

type ElectronFixtures = {
  electronApp: ElectronApplication;
  page: Page;
  homeDir: string;
  userDataDir: string;
  launchElectronApp: (options?: LaunchElectronOptions) => Promise<ElectronApplication>;
};

const repoRoot = resolve(process.cwd());
const electronEntry = join(repoRoot, 'dist-electron/main/index.js');
let productionAttachmentBundlePromise: Promise<string> | undefined;

function productionAttachmentBundle(): Promise<string> {
  // The app's production registry is closure-owned and cannot accept a provider-free
  // test grant. Bundle the real access service into Electron Main instead of
  // reimplementing its authorization or shell delegation in this fixture.
  productionAttachmentBundlePromise ??= buildWithEsbuild({
    stdin: {
      contents: [
        `export { createAttachmentAccess, StagedAttachmentRegistry } from ${JSON.stringify(join(repoRoot, 'electron/services/attachment-access.ts'))};`,
        `export { AcpSessionAccessRegistry } from ${JSON.stringify(join(repoRoot, 'electron/services/acp-session-access-registry.ts'))};`,
        `export { createMediaApi } from ${JSON.stringify(join(repoRoot, 'electron/services/media-api.ts'))};`,
      ].join('\n'),
      loader: 'ts',
      resolveDir: repoRoot,
      sourcefile: 'attachment-e2e-production-entry.ts',
    },
    bundle: true,
    define: {
      'import.meta.url': JSON.stringify(pathToFileURL(join(repoRoot, 'electron/utils/paths.ts')).href),
    },
    external: ['electron'],
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    tsconfig: join(repoRoot, 'tsconfig.node.json'),
    write: false,
  }).then((result) => {
    const output = result.outputFiles?.[0];
    if (!output) throw new Error('Failed to bundle production attachment services for Electron E2E');
    return output.text;
  });
  return productionAttachmentBundlePromise;
}

async function getStableWindow(app: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + 30_000;
  let page = await app.firstWindow();

  while (Date.now() < deadline) {
    const openWindows = app.windows().filter((candidate) => !candidate.isClosed());
    const currentWindow = openWindows.at(-1) ?? page;

    if (currentWindow && !currentWindow.isClosed()) {
      try {
        await currentWindow.waitForLoadState('domcontentloaded', { timeout: 2_000 });
        return currentWindow;
      } catch (error) {
        const message = String(error);
        if (!message.includes('has been closed') && !message.includes('Timeout')) {
          throw error;
        }
        // The renderer can transiently navigate or replace its execution
        // context while Electron is restoring the main window. Keep polling
        // within the outer deadline instead of turning the 2s probe into the
        // effective timeout for every E2E test.
      }
    }

    try {
      page = await app.waitForEvent('window', { timeout: 2_000 });
    } catch {
      // Keep polling until a stable window is available or the deadline expires.
    }
  }

  throw new Error('No stable Electron window became available');
}

async function closeElectronApp(app: ElectronApplication, timeoutMs = 5_000): Promise<void> {
  const child = app.process();
  const hasExited = () => child.exitCode !== null || child.signalCode !== null;
  const waitForExit = () => (
    hasExited()
      ? Promise.resolve()
      : new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()))
  );
  let exited = hasExited();

  await Promise.race([
    (async () => {
      const [, exitResult] = await Promise.allSettled([
        app.waitForEvent('close', { timeout: timeoutMs }),
        (async () => {
          await app.evaluate(({ app: electronApp }) => {
            electronApp.quit();
          });
          await waitForExit();
        })(),
      ]);

      if (exitResult.status === 'fulfilled' || hasExited()) {
        exited = true;
      }
    })(),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);

  if (exited || hasExited()) {
    return;
  }

  try {
    await app.close();
    await Promise.race([
      waitForExit(),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
    if (hasExited()) return;
  } catch {
    // Fall through to process kill if Playwright cannot close the app cleanly.
  }

  try {
    child.kill('SIGKILL');
    await Promise.race([
      waitForExit(),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  } catch {
    // Ignore process kill failures during e2e teardown.
  }
}

async function seedE2eSettings(userDataDir: string): Promise<void> {
  const settingsPath = join(userDataDir, 'settings.json');
  try {
    await access(settingsPath);
    return;
  } catch {
    // Seed only once per isolated profile. Tests that switch language should
    // keep their persisted setting across relaunches in the same profile.
  }

  await writeFile(settingsPath, JSON.stringify({ language: 'en' }, null, 2), 'utf-8');
}

async function launchClawXElectron(
  homeDir: string,
  userDataDir: string,
  options: LaunchElectronOptions = {},
): Promise<ElectronApplication> {
  if (options.additionalArgs?.some((arg) => arg.startsWith('--use-fake-ui-for-media-stream'))) {
    throw new Error('Electron E2E must not bypass application media permission prompts');
  }
  await seedE2eSettings(userDataDir);
  const inheritedEnv = { ...process.env };
  delete inheritedEnv.CLAWX_E2E_SKIP_SETUP;
  delete inheritedEnv.CLAWX_REMOTE_DEBUGGING_PORT;
  delete inheritedEnv.VITE_DEV_SERVER_URL;
  const electronEnv = process.platform === 'linux'
    ? {
      ELECTRON_DISABLE_SANDBOX: '1',
      DISPLAY: process.env.DISPLAY || ':1',
    }
    : {};
  return await electron.launch({
    executablePath: electronBinaryPath,
    args: ['--lang=en-US', ...(options.additionalArgs ?? []), electronEntry],
    env: {
      ...inheritedEnv,
      ...electronEnv,
      HOME: homeDir,
      USERPROFILE: homeDir,
      APPDATA: join(homeDir, 'AppData', 'Roaming'),
      LOCALAPPDATA: join(homeDir, 'AppData', 'Local'),
      XDG_CONFIG_HOME: join(homeDir, '.config'),
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      LANGUAGE: 'en',
      CLAWX_E2E: '1',
      CLAWX_USER_DATA_DIR: userDataDir,
      OPENCLAW_STATE_DIR: join(homeDir, '.openclaw'),
      OPENCLAW_CONFIG_PATH: join(homeDir, '.openclaw', 'openclaw.json'),
      ...(options.skipSetup ? { CLAWX_E2E_SKIP_SETUP: '1' } : {}),
    },
    timeout: 90_000,
  });
}

export const test = base.extend<ElectronFixtures>({
  homeDir: async ({ browserName: _browserName }, provideHomeDir) => {
    const homeDir = await mkdtemp(join(tmpdir(), 'clawx-e2e-home-'));
    await mkdir(join(homeDir, '.config'), { recursive: true });
    await mkdir(join(homeDir, 'AppData', 'Local'), { recursive: true });
    await mkdir(join(homeDir, 'AppData', 'Roaming'), { recursive: true });
    try {
      await provideHomeDir(homeDir);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  },

  userDataDir: async ({ browserName: _browserName }, provideUserDataDir) => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'clawx-e2e-user-data-'));
    try {
      await provideUserDataDir(userDataDir);
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  },

  launchElectronApp: async ({ homeDir, userDataDir }, provideLauncher) => {
    await provideLauncher(async (options?: LaunchElectronOptions) => await launchClawXElectron(homeDir, userDataDir, options));
  },

  electronApp: async ({ launchElectronApp }, provideElectronApp) => {
    const app = await launchElectronApp();
    let appClosed = false;
    app.once('close', () => {
      appClosed = true;
    });

    try {
      await provideElectronApp(app);
    } finally {
      if (!appClosed) {
        await closeElectronApp(app);
      }
    }
  },

  page: async ({ electronApp }, providePage) => {
    const page = await getStableWindow(electronApp);
    await providePage(page);
  },
});

export async function completeSetup(page: Page): Promise<void> {
  await expect(page.getByTestId('setup-page')).toBeVisible();
  await page.getByTestId('setup-skip-button').click();
  await expect(page.getByTestId('main-layout')).toBeVisible();
}

export { closeElectronApp };
export { getStableWindow };
export { expect };

export async function startMainCpuProfile(app: ElectronApplication): Promise<void> {
  await app.evaluate(async () => {
    const inspector = process.mainModule!.require('node:inspector') as typeof import('node:inspector');
    const globals = globalThis as unknown as { __e2eMainCpuProfiler?: import('node:inspector').Session };
    if (globals.__e2eMainCpuProfiler) throw new Error('Main CPU profiler is already running');

    const session = new inspector.Session();
    session.connect();
    const post = (method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> => (
      new Promise((resolvePost, rejectPost) => {
        session.post(method, params ?? {}, (error, result) => {
          if (error) rejectPost(error);
          else resolvePost((result ?? {}) as Record<string, unknown>);
        });
      })
    );

    try {
      await post('Profiler.enable');
      await post('Profiler.setSamplingInterval', { interval: 1_000 });
      await post('Profiler.start');
      globals.__e2eMainCpuProfiler = session;
    } catch (error) {
      session.disconnect();
      throw error;
    }
  });
}

export async function stopMainCpuProfile(app: ElectronApplication): Promise<Record<string, unknown>> {
  return await app.evaluate(async () => {
    const globals = globalThis as unknown as { __e2eMainCpuProfiler?: import('node:inspector').Session };
    const session = globals.__e2eMainCpuProfiler;
    if (!session) throw new Error('Main CPU profiler is not running');
    delete globals.__e2eMainCpuProfiler;

    const post = (method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> => (
      new Promise((resolvePost, rejectPost) => {
        session.post(method, params ?? {}, (error, result) => {
          if (error) rejectPost(error);
          else resolvePost((result ?? {}) as Record<string, unknown>);
        });
      })
    );

    try {
      const result = await post('Profiler.stop');
      await post('Profiler.disable');
      const profile = result.profile;
      if (!profile || typeof profile !== 'object') throw new Error('Main CPU profiler returned no profile');
      return profile as Record<string, unknown>;
    } finally {
      session.disconnect();
    }
  });
}

export async function installIpcMocks(
  app: ElectronApplication,
  config: IpcMockConfig,
): Promise<void> {
  await app.evaluate(
    async ({ app: _app }, mockConfig) => {
      const { ipcMain } = process.mainModule!.require('electron') as typeof import('electron');
      const invokeHandlers = (ipcMain as unknown as {
        _invokeHandlers?: Map<string, (event: unknown, request: unknown) => Promise<unknown>>;
      })._invokeHandlers;
      // Initialization is asynchronous and now includes the DataService and
      // canonical scheduler. Installing a mock before the production Host API
      // handler exists races registerIpcHandlers and makes Electron reject the
      // later registration as a duplicate. Wait for the real boundary, then
      // replace it; callers still reload the first window after mocks install.
      const deadline = Date.now() + 30_000;
      while (!invokeHandlers?.has('host:invoke') && Date.now() < deadline) {
        await new Promise(resolveWait => setTimeout(resolveWait, 10));
      }
      if (!invokeHandlers?.has('host:invoke')) {
        throw new Error('Timed out waiting for the production host:invoke handler');
      }
      const stableStringify = (value: unknown): string => {
        if (value == null || typeof value !== 'object') return JSON.stringify(value);
        if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
        const entries = Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);
        return `{${entries.join(',')}}`;
      };

      const originalHostInvoke = invokeHandlers.get('host:invoke');
      const globals = globalThis as unknown as {
        __e2eHostInvocations?: RecordedHostInvocation[];
        __e2eLegacyIpcInvocations?: RecordedLegacyIpcInvocation[];
        __e2eKernelFixture?: KernelHostFixtureConfig;
      };
      if (mockConfig.recordHostInvocations) globals.__e2eHostInvocations = [];
      if (mockConfig.recordLegacyIpcInvocations) globals.__e2eLegacyIpcInvocations = [];
      if (mockConfig.kernelFixture) globals.__e2eKernelFixture = mockConfig.kernelFixture;
      type IpcInvokeHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
      const getInvokeHandler = (channel: string): IpcInvokeHandler | undefined => {
        return (ipcMain as unknown as {
          _invokeHandlers?: Map<string, IpcInvokeHandler>;
        })._invokeHandlers?.get(channel);
      };
      const instrumentedLegacyHandlers = new Map<string, IpcInvokeHandler>();

      const respond = (id: unknown, data: unknown) => ({
        id: typeof id === 'string' ? id : undefined,
        ok: true,
        data,
      });
      const fail = (id: unknown, message: string) => ({
        id: typeof id === 'string' ? id : undefined,
        ok: false,
        error: { code: 'INTERNAL', message },
      });

      const unwrapLegacyResponse = (response: unknown): unknown => {
        if (!response || typeof response !== 'object') return response;
        const record = response as Record<string, unknown>;
        const data = record.data;
        if (data && typeof data === 'object' && 'json' in (data as Record<string, unknown>)) {
          return (data as Record<string, unknown>).json;
        }
        return data ?? response;
      };
      const respondGatewayRpc = (id: unknown, response: unknown) => {
        if (response && typeof response === 'object') {
          const record = response as Record<string, unknown>;
          if (record.success === false) {
            return fail(id, String(record.error || 'Gateway RPC failed'));
          }
          if (record.success === true && 'result' in record) {
            return respond(id, record.result);
          }
        }
        return respond(id, response);
      };
      const originalLegacyGatewayRpc = getInvokeHandler('gateway:rpc');
      const originalLegacyFileStat = getInvokeHandler('file:stat');
      const originalLegacyFileReadText = getInvokeHandler('file:readText');
      const originalLegacyFileListTree = getInvokeHandler('file:listTree');
      const getLegacyOverride = (channel: string, original?: IpcInvokeHandler) => {
        const current = getInvokeHandler(channel);
        if (current === instrumentedLegacyHandlers.get(channel)) return null;
        return current && current !== original ? current : null;
      };

      if (mockConfig.recordLegacyIpcInvocations) {
        const forbiddenLegacyChannels = [
          'file:readText',
          'file:readBinary',
          'file:writeText',
          'file:stat',
          'file:listDir',
          'file:listTree',
          'shell:openExternal',
          'shell:showItemInFolder',
          'shell:openPath',
        ];
        for (const channel of forbiddenLegacyChannels) {
          const instrumentedHandler: IpcInvokeHandler = async (_event: unknown, ...args: unknown[]) => {
            globals.__e2eLegacyIpcInvocations?.push({ channel, args });
            if (channel === 'shell:openPath') return 'legacyIpcForbidden';
            if (channel.startsWith('file:')) return { ok: false, error: 'legacyIpcForbidden' };
            return undefined;
          };
          instrumentedLegacyHandlers.set(channel, instrumentedHandler);
          ipcMain.removeHandler(channel);
          ipcMain.handle(channel, instrumentedHandler);
        }
      }

      const legacyPathForHostRequest = (request: {
        module?: string;
        action?: string;
        payload?: Record<string, unknown>;
      }): [string, string] | null => {
        const payload = request.payload ?? {};
        if (request.module === 'gateway') {
          if (request.action === 'status') return ['/api/gateway/status', 'GET'];
          if (request.action === 'start') return ['/api/gateway/start', 'POST'];
          if (request.action === 'restart') return ['/api/gateway/restart', 'POST'];
        }
        if (request.module === 'agents' && request.action === 'list') return ['/api/agents', 'GET'];
        if (request.module === 'settings' && request.action === 'getAll') return ['/api/settings', 'GET'];
        if (request.module === 'channels') {
          if (request.action === 'accounts') return ['/api/channels/accounts', 'GET'];
          if (request.action === 'validateCredentials') return ['/api/channels/credentials/validate', 'POST'];
          if (request.action === 'saveConfig') return ['/api/channels/config', 'POST'];
          if (request.action === 'bindingSave') return ['/api/channels/binding', 'PUT'];
          if (request.action === 'bindingDelete') return ['/api/channels/binding', 'DELETE'];
          if (request.action === 'formValues') {
            const channelType = encodeURIComponent(String(payload.channelType ?? ''));
            return [`/api/channels/config/${channelType}`, 'GET'];
          }
        }
        if (request.module === 'diagnostics' && request.action === 'gatewaySnapshot') {
          return ['/api/diagnostics/gateway-snapshot', 'GET'];
        }
        if (request.module === 'cron' && request.action === 'list') return ['/api/cron/jobs', 'GET'];
        if (request.module === 'skills' && request.action === 'quickAccess') return ['/api/skills/quick-access', 'POST'];
        if (request.module === 'files' && request.action === 'thumbnails') return ['/api/files/thumbnails', 'POST'];
        if (request.module === 'media') {
          if (request.action === 'thumbnails') return ['/api/files/thumbnails', 'POST'];
          if (request.action === 'imageGenerationSettings') return ['/api/media/image-generation', 'GET'];
          if (request.action === 'saveImageGenerationSettings') return ['/api/media/image-generation', 'PUT'];
        }
        if (request.module === 'sessions') {
          if (request.action === 'history') {
            const params = new URLSearchParams();
            if (typeof payload.sessionKey === 'string') params.set('sessionKey', payload.sessionKey);
            if (typeof payload.agentId === 'string') params.set('agentId', payload.agentId);
            if (typeof payload.sessionId === 'string') params.set('sessionId', payload.sessionId);
            if (typeof payload.limit === 'number') params.set('limit', String(payload.limit));
            return [`/api/sessions/transcript?${params.toString()}`, 'GET'];
          }
          if (request.action === 'summaries') return ['/api/sessions/summaries', 'POST'];
        }
        return null;
      };

      if (mockConfig.gatewayRpc || mockConfig.hostApi || mockConfig.hostApiErrors || mockConfig.gatewayStatus || mockConfig.kernelFixture) {
        ipcMain.removeHandler('host:invoke');
        ipcMain.handle('host:invoke', async (event: unknown, request: {
          id?: string;
          module?: string;
          action?: string;
          payload?: Record<string, unknown>;
        }) => {
          if (mockConfig.recordHostInvocations) {
            globals.__e2eHostInvocations?.push({
              module: request?.module,
              action: request?.action,
              payload: request?.payload,
            });
          }

          const typedKey = stableStringify([
            request?.module ?? null,
            request?.action ?? null,
            request?.payload ?? null,
          ]);

          const kernelFixture = globals.__e2eKernelFixture;
          if (kernelFixture && request?.module === 'kernels') {
            const payload = request.payload ?? {};
            const kernelId = typeof payload.kernelId === 'string' ? payload.kernelId : '';
            if (request.action === 'catalog') return respond(request.id, kernelFixture.catalog);
            if (request.action === 'list') return respond(request.id, kernelFixture.runtimes);
            if (request.action === 'status' || request.action === 'health') {
              const snapshot = kernelFixture.runtimes.find(runtime => runtime.kernelId === kernelId);
              return snapshot ? respond(request.id, snapshot) : fail(request.id, `Unknown kernel: ${kernelId}`);
            }
            if (request.action === 'logs') return respond(request.id, []);
            if (request.action === 'versions') return respond(request.id, { versions: [] });
            if (request.action === 'openDirectory') return respond(request.id, { success: true });
            if (request.action === 'exportLogs') {
              return respond(request.id, {
                kernelId,
                fileName: `${kernelId || 'kernel'}-logs.ndjson`,
                content: '',
                entryCount: 0,
              });
            }

            const operationKey = `${request.action ?? ''}:${kernelId}`;
            const script = kernelFixture.operations?.[operationKey];
            const step = script?.length ? script.shift() : undefined;
            if (step?.progress?.length) {
              const { BrowserWindow } = process.mainModule!.require('electron') as typeof import('electron');
              for (const progress of step.progress) {
                for (const window of BrowserWindow.getAllWindows()) {
                  window.webContents.send('kernels:package-progress', progress);
                }
              }
            }
            if (step?.catalog) kernelFixture.catalog = step.catalog;
            if (step?.runtimes) kernelFixture.runtimes = step.runtimes;
            if (step?.error) return fail(request.id, step.error);
            if (step && 'result' in step) {
              const result = step.result;
              if (result && typeof result === 'object') {
                const record = result as Record<string, unknown>;
                const runtime = (
                  record.runtime && typeof record.runtime === 'object'
                    ? record.runtime
                    : typeof record.kernelId === 'string' && typeof record.state === 'string'
                      ? record
                      : undefined
                ) as KernelRuntimeSnapshot | undefined;
                const installation = record.installation as KernelCatalogSnapshot['entries'][number]['installation'] | undefined;
                if (runtime) {
                  kernelFixture.runtimes = [
                    ...kernelFixture.runtimes.filter(item => item.kernelId !== runtime.kernelId),
                    runtime,
                  ];
                  kernelFixture.catalog = {
                    ...kernelFixture.catalog,
                    entries: kernelFixture.catalog.entries.map(entry => entry.kernelId === runtime.kernelId
                      ? { ...entry, runtime, ...(installation ? { installation } : {}) }
                      : entry),
                  };
                }
              }
              return respond(request.id, result);
            }
          }

          if (mockConfig.hostApiErrors && typedKey in mockConfig.hostApiErrors) {
            return fail(request.id, mockConfig.hostApiErrors[typedKey]);
          }

          if (mockConfig.gatewayStatus && request?.module === 'gateway' && request.action === 'status') {
            return respond(request.id, mockConfig.gatewayStatus);
          }

          if (mockConfig.gatewayRpc && request?.module === 'gateway' && request.action === 'rpc') {
            const payload = request.payload ?? {};
            const method = typeof payload.method === 'string' ? payload.method : '';
            const params = 'params' in payload ? payload.params : null;
            const key = stableStringify([method, params ?? null]);
            if (key in mockConfig.gatewayRpc) return respondGatewayRpc(request.id, mockConfig.gatewayRpc[key]);
            if (method === 'sessions.list') {
              const emptySessionsListKey = stableStringify([method, {}]);
              if (emptySessionsListKey in mockConfig.gatewayRpc) {
                return respondGatewayRpc(request.id, mockConfig.gatewayRpc[emptySessionsListKey]);
              }
            }
            const fallbackKey = stableStringify([method, null]);
            if (fallbackKey in mockConfig.gatewayRpc) return respondGatewayRpc(request.id, mockConfig.gatewayRpc[fallbackKey]);
            const legacyGatewayRpc = getLegacyOverride('gateway:rpc', originalLegacyGatewayRpc);
            if (legacyGatewayRpc) {
              return respondGatewayRpc(
                request.id,
                await legacyGatewayRpc(event, method, params, payload.timeoutMs),
              );
            }
            return respond(request.id, {});
          }

          if (mockConfig.hostApi) {
            if (typedKey in mockConfig.hostApi) {
              return respond(request.id, unwrapLegacyResponse(mockConfig.hostApi[typedKey]));
            }

            const legacyPath = legacyPathForHostRequest(request ?? {});
            if (legacyPath) {
              const key = stableStringify(legacyPath);
              if (key in mockConfig.hostApi) {
                return respond(request.id, unwrapLegacyResponse(mockConfig.hostApi[key]));
              }
            }
          }

          if (request?.module === 'files') {
            const payload = request.payload ?? {};
            const path = typeof payload.path === 'string' ? payload.path : '';
            if (request.action === 'resolveWorkspaceContext') {
              const workspaceRoot = typeof payload.workspaceRoot === 'string'
                ? payload.workspaceRoot.trim()
                : '';
              const executionCwd = typeof payload.executionCwd === 'string'
                ? payload.executionCwd.trim()
                : '';
              if (!workspaceRoot || !executionCwd) {
                return respond(request.id, { ok: false, error: 'outsideSandbox' });
              }
              return respond(request.id, {
                ok: true,
                workspaceRoot,
                executionCwd,
              });
            }
            if (request.action === 'stat') {
              const legacyFileStat = getLegacyOverride('file:stat', originalLegacyFileStat);
              if (legacyFileStat) {
                return respond(request.id, await legacyFileStat(event, path));
              }
            }
            if (request.action === 'readText') {
              const legacyFileReadText = getLegacyOverride('file:readText', originalLegacyFileReadText);
              if (legacyFileReadText) {
                return respond(request.id, await legacyFileReadText(event, path));
              }
            }
            if (request.action === 'listTree') {
              const legacyFileListTree = getLegacyOverride('file:listTree', originalLegacyFileListTree);
              if (legacyFileListTree) {
                return respond(request.id, await legacyFileListTree(event, path, payload.opts));
              }
            }
          }

          return originalHostInvoke?.(event, request) ?? respond(request?.id, {});
        });
      }

      if (mockConfig.gatewayStatus) {
        ipcMain.removeHandler('gateway:status');
        ipcMain.handle('gateway:status', async () => mockConfig.gatewayStatus);
      }

      if (mockConfig.kernelFixture) {
        const { BrowserWindow } = process.mainModule!.require('electron') as typeof import('electron');
        setTimeout(() => {
          for (const window of BrowserWindow.getAllWindows()) {
            window.webContents.send('kernels:catalog-changed', { reason: 'e2e-fixture-installed' });
          }
        }, 0);
      }
    },
    config,
  );
}

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);
  return `{${entries.join(',')}}`;
}

export async function installAttachmentHostFixture(
  app: ElectronApplication,
  options: { sessions: AttachmentFixtureSession[] },
): Promise<AttachmentHostFixture> {
  if (options.sessions.length === 0) throw new Error('Attachment fixture requires at least one session');
  const homeDir = await app.evaluate(async () => process.env.HOME || process.env.USERPROFILE || '');
  if (!homeDir) throw new Error('Attachment fixture could not resolve the isolated home directory');
  const fixtureRoot = join(homeDir, 'attachment-e2e');
  const workspacePath = join(fixtureRoot, 'workspace');
  const outsidePath = join(fixtureRoot, 'outside');
  const openClawMediaPath = join(homeDir, '.openclaw', 'media');
  await Promise.all([
    mkdir(workspacePath, { recursive: true }),
    mkdir(outsidePath, { recursive: true }),
    mkdir(openClawMediaPath, { recursive: true }),
  ]);
  const [workspaceDir, outsideDir, openClawMediaDir] = await Promise.all([
    realpath(workspacePath),
    realpath(outsidePath),
    realpath(openClawMediaPath),
  ]);
  const productionAttachmentBundlePath = join(fixtureRoot, 'production-attachment-access.cjs');
  await writeFile(productionAttachmentBundlePath, await productionAttachmentBundle(), 'utf-8');

  const now = Date.now();
  const sessionRecords = options.sessions.map((session, index) => ({
    key: session.key,
    displayName: session.title,
    derivedTitle: session.title,
    workspacePath: workspaceDir,
    updatedAt: new Date(now - index).toISOString(),
  }));
  const sessionsList = { success: true, result: { sessions: sessionRecords } };
  const sessionKeys = options.sessions.map((session) => session.key);
  await installIpcMocks(app, {
    gatewayStatus: { state: 'running', gatewayReady: true, port: 18789, pid: 12345, connectedAt: now },
    kernelFixture: {
      catalog: {
        source: 'network',
        stale: false,
        refreshedAt: new Date(now).toISOString(),
        entries: [{
          kernelId: 'openclaw',
          displayName: 'OpenClaw',
          installation: {
            kernelId: 'openclaw',
            state: 'installed',
            activeVersion: '2026.8.1-clawx.1',
            updatedAt: new Date(now).toISOString(),
          },
          runtime: {
            kernelId: 'openclaw',
            state: 'ready',
            generation: 1,
            artifactVersion: '2026.8.1-clawx.1',
            diagnostics: [],
          },
          updateAvailable: false,
          installAllowed: true,
          compatibilityFailures: [],
        }],
      },
      runtimes: [{
        kernelId: 'openclaw',
        state: 'ready',
        generation: 1,
        artifactVersion: '2026.8.1-clawx.1',
        diagnostics: [],
      }],
    },
    gatewayRpc: {
      [stableStringify(['sessions.list', {}])]: sessionsList,
      [stableStringify(['sessions.list', { includeDerivedTitles: true, includeLastMessage: true }])]: sessionsList,
    },
    hostApi: {
      [stableStringify(['settings', 'getAll', null])]: {
        language: 'en',
        setupComplete: true,
        chatWorkspacePath: workspaceDir,
        recentWorkspacePaths: [workspaceDir],
      },
      [stableStringify(['agents', 'list', null])]: {
        success: true,
        agents: [{
          id: 'main',
          name: 'main',
          workspace: workspaceDir,
          mainSessionKey: options.sessions[0]!.key,
        }],
      },
      [stableStringify(['sessions', 'summaries', { sessionKeys }])]: {
        success: true,
        summaries: options.sessions.map((session, index) => ({
          sessionKey: session.key,
          firstUserText: session.title,
          lastTimestamp: now - index,
          workspacePath: workspaceDir,
        })),
      },
    },
    recordLegacyIpcInvocations: true,
  });

  await app.evaluate(async ({ app: _app }, payload) => {
    const { BrowserWindow, ipcMain, shell } = process.mainModule!.require('electron') as typeof import('electron');
    type AcpUpdate = Record<string, unknown> & { sessionUpdate: string };
    type HostRequest = {
      id?: string;
      module?: string;
      action?: string;
      payload?: Record<string, unknown>;
    };
    type HostHandler = (event: unknown, request: HostRequest) => Promise<unknown>;
    type FixtureState = {
      activeSessionKey: string;
      generation: number;
      replays: Record<string, AcpUpdate[]>;
      promptUpdates: Record<string, AcpUpdate[]>;
      deferredPromptResponses: Record<string, boolean>;
      deferredPromptResolvers: Record<string, (() => void) | undefined>;
      openHandlersResult: AttachmentOpenHandlersFixtureResult;
      hostInvocations: RecordedHostInvocation[];
      shellInvocations: RecordedHostInvocation[];
      stagedAttachments?: { register: (id: string, canonicalPath: string, displayPath?: string) => void };
      activeRun?: {
        conversationId: string;
        turnId: string;
        runId: string;
        kernelId: string;
        generation: number;
        eventSeq: number;
      };
      emitUpdates?: (updates: AcpUpdate[]) => void;
    };
    const globals = globalThis as unknown as { __e2eAttachmentFixture?: FixtureState };
    const state: FixtureState = {
      activeSessionKey: '',
      generation: 0,
      replays: {},
      promptUpdates: {},
      deferredPromptResponses: {},
      deferredPromptResolvers: {},
      openHandlersResult: {
        ok: true,
        platform: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
        handlers: [],
      },
      hostInvocations: [],
      shellInvocations: [],
    };
    globals.__e2eAttachmentFixture = state;

    const instrumentedShell = shell as unknown as {
      openPath: (path: string) => Promise<string>;
      openExternal: (url: string) => Promise<void>;
      showItemInFolder: (path: string) => void;
    };
    instrumentedShell.openPath = async (path) => {
      state.shellInvocations.push({ module: 'shell', action: 'openPath', payload: { path } });
      return '';
    };
    instrumentedShell.openExternal = async (url) => {
      state.shellInvocations.push({ module: 'shell', action: 'openExternal', payload: { url } });
    };
    instrumentedShell.showItemInFolder = (path) => {
      state.shellInvocations.push({ module: 'shell', action: 'showItemInFolder', payload: { path } });
    };

    type ProductionAttachmentModule = {
      AcpSessionAccessRegistry: new () => {
        prepareGrant: (input: {
          sessionKey: string;
          generation: number;
          workspaceRoot: string;
          executionCwd: string;
        }) => Promise<unknown>;
        commitGrant: (grant: unknown) => void;
      };
      StagedAttachmentRegistry: new () => {
        register: (id: string, canonicalPath: string, displayPath?: string) => void;
      };
      createMediaApi: (dependencies: { attachmentAccess: unknown }) => {
        thumbnails: (input: unknown) => Promise<unknown>;
      };
      createAttachmentAccess: (dependencies: {
        sessionAccessRegistry: unknown;
        stagedAttachments: unknown;
      }) => {
        resolveAttachment: (input: unknown) => Promise<unknown>;
        readAttachmentText: (input: unknown) => Promise<unknown>;
        readAttachmentBinary: (input: unknown) => Promise<unknown>;
        openAttachment: (input: unknown) => Promise<unknown>;
      };
    };
    const production = process.mainModule!.require(payload.productionAttachmentBundlePath) as ProductionAttachmentModule;
    const productionSessionAccess = new production.AcpSessionAccessRegistry();
    const productionStagedAttachments = new production.StagedAttachmentRegistry();
    state.stagedAttachments = productionStagedAttachments;
    const productionAttachmentAccess = production.createAttachmentAccess({
      sessionAccessRegistry: productionSessionAccess,
      stagedAttachments: productionStagedAttachments,
    });
    const productionMediaApi = production.createMediaApi({ attachmentAccess: productionAttachmentAccess });

    const respond = (id: unknown, data: unknown) => ({
      id: typeof id === 'string' ? id : undefined,
      ok: true,
      data,
    });
    const textAndResources = (content: unknown) => {
      const blocks = Array.isArray(content) ? content : content && typeof content === 'object' ? [content] : [];
      const text: string[] = [];
      const resources: Array<Record<string, unknown>> = [];
      const images: Array<Record<string, unknown>> = [];
      for (const block of blocks) {
        if (!block || typeof block !== 'object') continue;
        const record = block as Record<string, unknown>;
        if (typeof record.text === 'string') text.push(record.text);
        if (record.type === 'image' && (typeof record.uri === 'string' || typeof record.data === 'string')) {
          images.push({
            type: 'image',
            ...(typeof record.uri === 'string' ? { uri: record.uri } : {}),
            ...(typeof record.data === 'string' ? { data: record.data } : {}),
            ...(typeof record.mimeType === 'string' ? { mimeType: record.mimeType } : {}),
            ...(record._meta && typeof record._meta === 'object' ? { _meta: structuredClone(record._meta) } : {}),
          });
        }
        if (record.type === 'resource_link' && typeof record.uri === 'string') {
          resources.push({
            uri: record.uri,
            name: typeof record.name === 'string' ? record.name : record.uri,
            ...(typeof record.mimeType === 'string' ? { mimeType: record.mimeType } : {}),
            ...(typeof record.size === 'number' ? { size: record.size } : {}),
          });
        }
      }
      return { text: text.join(''), resources, images };
    };
    const emitUpdates = (updates: AcpUpdate[]) => {
      const run = state.activeRun;
      if (!run) return;
      for (const update of updates) {
        const projected = textAndResources(update.content);
        const kind = update.sessionUpdate === 'agent_message_chunk'
          ? 'assistant.delta'
          : update.sessionUpdate === 'agent_message'
            ? 'assistant.final'
            : update.sessionUpdate === 'agent_thought_chunk'
              ? 'reasoning.visibility'
              : update.sessionUpdate === 'tool_call'
                ? 'tool.start'
                : update.sessionUpdate === 'tool_call_update'
                  ? (['completed', 'failed'].includes(String(update.status).toLowerCase()) ? 'tool.result' : 'tool.progress')
                  : update.sessionUpdate === 'usage_update'
                    ? 'usage'
                    : update.sessionUpdate === 'plan'
                      ? 'diagnostic'
                      : null;
        if (!kind) continue;
        const eventPayload = kind === 'assistant.delta' || kind === 'assistant.final'
          ? {
              text: projected.text,
              messageId: update.messageId,
              ...(projected.resources.length > 0 ? { resources: projected.resources } : {}),
              ...(projected.images.length > 0 ? { content: projected.images } : {}),
            }
          : kind === 'reasoning.visibility'
            ? { visibility: 'private', text: projected.text }
            : kind === 'diagnostic'
              ? { category: 'plan', ...update }
              : update;
        run.eventSeq += 1;
        const envelope = {
          protocol: 'clawx.kernel/v1' as const,
          conversationId: run.conversationId,
          turnId: run.turnId,
          runId: run.runId,
          kernelId: run.kernelId,
          generation: run.generation,
          eventSeq: run.eventSeq,
          emittedAt: new Date().toISOString(),
          event: { kind, payload: eventPayload },
        } as KernelEventEnvelopeV1;
        for (const window of BrowserWindow.getAllWindows()) {
          window.webContents.send('chat:kernel-event', envelope);
        }
      }
    };
    state.emitUpdates = emitUpdates;
    const contentBlocks = (turnId: string, content: unknown, role: 'user' | 'assistant') => {
      const values = Array.isArray(content) ? content : content && typeof content === 'object' ? [content] : [];
      return values.flatMap((value, index) => {
        if (!value || typeof value !== 'object') return [];
        const block = value as Record<string, unknown>;
        const id = `${turnId}:block:${index}`;
        if (typeof block.text === 'string') {
          return [{ id, type: 'text', visibility: 'portable', text: block.text }];
        }
        if (block.type === 'image' && (typeof block.uri === 'string' || typeof block.data === 'string')) {
          return [{
            id,
            type: 'image',
            visibility: role === 'user' ? 'portable' : 'kernel',
            ...(role === 'assistant' ? { kernelId: 'openclaw' } : {}),
            ...(typeof block.mimeType === 'string' ? { mimeType: block.mimeType } : {}),
            json: {
              ...(typeof block.uri === 'string' ? { uri: block.uri } : {}),
              ...(typeof block.data === 'string' ? { data: block.data } : {}),
              ...(block._meta && typeof block._meta === 'object' ? { _meta: block._meta } : {}),
            },
          }];
        }
        if (block.type === 'resource_link' && typeof block.uri === 'string') {
          return [{
            id,
            type: 'resource-link',
            visibility: role === 'user' ? 'portable' : 'kernel',
            ...(role === 'assistant' ? { kernelId: 'openclaw' } : {}),
            ...(typeof block.mimeType === 'string' ? { mimeType: block.mimeType } : {}),
            json: {
              uri: block.uri,
              name: typeof block.name === 'string' ? block.name : block.uri,
              ...(typeof block.size === 'number' ? { size: block.size } : {}),
              ...(block._meta && typeof block._meta === 'object' ? { _meta: block._meta } : {}),
            },
          }];
        }
        return [];
      });
    };
    const exportConversation = (sessionKey: string) => {
      const session = payload.sessions.find(item => item.key === sessionKey);
      if (!session) return null;
      const createdAt = '2026-08-24T00:00:00.000Z';
      const updatedAt = '2026-08-24T00:00:01.000Z';
      const turns: Array<Record<string, unknown>> = [];
      const runBuilders: Array<{
        turnId: string;
        assistantTurnId?: string;
        events: Array<Record<string, unknown>>;
      }> = [];
      let currentUserTurnId: string | undefined;
      let currentRun: (typeof runBuilders)[number] | undefined;
      let currentAssistant: { id: string; role: 'assistant'; position: number; createdAt: string; blocks: Array<Record<string, unknown>> } | undefined;
      const flushAssistant = () => {
        if (!currentAssistant) return;
        turns.push(currentAssistant);
        if (currentRun) currentRun.assistantTurnId = currentAssistant.id;
        currentAssistant = undefined;
      };
      for (const [updateIndex, update] of (state.replays[sessionKey] ?? []).entries()) {
        const messageId = typeof update.messageId === 'string' ? update.messageId : `${update.sessionUpdate}-${updateIndex}`;
        if (update.sessionUpdate === 'user_message' || update.sessionUpdate === 'user_message_chunk') {
          flushAssistant();
          currentUserTurnId = `fixture-user:${messageId}`;
          turns.push({
            id: currentUserTurnId,
            role: 'user',
            position: turns.length,
            createdAt,
            blocks: contentBlocks(currentUserTurnId, update.content, 'user'),
          });
          currentRun = { turnId: currentUserTurnId, events: [] };
          runBuilders.push(currentRun);
          continue;
        }
        if (update.sessionUpdate === 'agent_message' || update.sessionUpdate === 'agent_message_chunk') {
          currentAssistant ??= {
            id: `fixture-assistant:${messageId}`,
            role: 'assistant',
            position: turns.length,
            createdAt: updatedAt,
            blocks: [],
          };
          currentAssistant.blocks.push(...contentBlocks(
            `${currentAssistant.id}:${updateIndex}`,
            update.content,
            'assistant',
          ));
          continue;
        }
        const eventKind = update.sessionUpdate === 'agent_thought_chunk'
          ? 'reasoning.visibility'
          : update.sessionUpdate === 'tool_call'
            ? 'tool.start'
            : update.sessionUpdate === 'tool_call_update'
              ? (['completed', 'failed'].includes(String(update.status).toLowerCase()) ? 'tool.result' : 'tool.progress')
              : update.sessionUpdate === 'usage_update'
                ? 'usage'
                : update.sessionUpdate === 'plan'
                  ? 'diagnostic'
                  : null;
        if (eventKind && currentRun) {
          currentRun.events.push({
            eventSeq: currentRun.events.length + 1,
            kind: eventKind,
            payload: eventKind === 'reasoning.visibility'
              ? { visibility: 'private', ...textAndResources(update.content) }
              : eventKind === 'diagnostic'
                ? { category: 'plan', ...update }
                : update,
            emittedAt: updatedAt,
          });
        }
      }
      flushAssistant();
      turns.forEach((turn, position) => { turn.position = position; });
      const summary = {
        id: sessionKey,
        title: session.title,
        createdAt,
        updatedAt,
        workspaceUri: payload.workspaceUri,
        lastKernelId: 'openclaw',
        kernelIds: ['openclaw'],
        lastAgentId: 'main',
      };
      return {
        schema: 'clawx.conversation-export/v1',
        conversation: summary,
        turns,
        runs: runBuilders.flatMap((builder, index) => (
          builder.events.length > 0 || builder.assistantTurnId
            ? [{
                id: `fixture-run:${sessionKey}:${index}`,
                turnId: builder.turnId,
                ...(builder.assistantTurnId ? { assistantTurnId: builder.assistantTurnId } : {}),
                kernelId: 'openclaw',
                kernelVersion: '2026.8.1-clawx.1',
                generation: 1,
                agentId: 'main',
                agentSnapshot: {
                  agentId: 'main',
                  displayName: 'Main',
                  kernelId: 'openclaw',
                  workspaceUri: payload.workspaceUri,
                  canonicalVersion: 1,
                },
                workspaceUri: payload.workspaceUri,
                status: 'completed',
                createdAt,
                startedAt: createdAt,
                completedAt: updatedAt,
                events: builder.events,
              }]
            : []
        )),
        usage: [],
      };
    };
    const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, HostHandler> })._invokeHandlers;
    const originalHostInvoke = handlers?.get('host:invoke');
    ipcMain.removeHandler('host:invoke');
    ipcMain.handle('host:invoke', async (event: unknown, request: HostRequest) => {
      state.hostInvocations.push({ module: request.module, action: request.action, payload: request.payload });

      if (request.module === 'conversations' && request.action === 'list') {
        return respond(request.id, {
          items: payload.sessions.map(session => exportConversation(session.key)!.conversation),
        });
      }
      if (request.module === 'conversations' && request.action === 'get') {
        return respond(request.id, exportConversation(String(request.payload?.id ?? '')));
      }
      if (request.module === 'chat' && request.action === 'selectConversationKernel') {
        const sessionKey = String(request.payload?.sessionKey ?? '');
        state.generation += 1;
        state.activeSessionKey = sessionKey;
        const generation = state.generation;
        const grant = await productionSessionAccess.prepareGrant({
          sessionKey,
          generation,
          workspaceRoot: typeof request.payload?.workspaceRoot === 'string'
            ? request.payload.workspaceRoot
            : payload.workspaceDir,
          executionCwd: typeof request.payload?.cwd === 'string'
            ? request.payload.cwd
            : payload.workspaceDir,
        });
        productionSessionAccess.commitGrant(grant);
        return respond(request.id, { success: true, generation, kernelId: 'openclaw' });
      }
      if (request.module === 'chat' && request.action === 'sendAcpPrompt') {
        const sessionKey = String(request.payload?.sessionKey ?? '');
        const prompt = String(request.payload?.message ?? '');
        if (sessionKey === state.activeSessionKey) {
          state.activeRun = {
            conversationId: String(request.payload?.conversationId ?? sessionKey),
            turnId: String(request.payload?.turnId ?? `fixture-live-turn:${Date.now()}`),
            runId: String(request.payload?.runId ?? request.payload?.messageId ?? `fixture-live-run:${Date.now()}`),
            kernelId: String(request.payload?.kernelId ?? 'openclaw'),
            generation: state.generation,
            eventSeq: 0,
          };
          emitUpdates(state.promptUpdates[prompt] ?? []);
        }
        if (state.deferredPromptResponses[prompt]) {
          await new Promise<void>((resolvePrompt) => {
            state.deferredPromptResolvers[prompt] = resolvePrompt;
          });
          delete state.deferredPromptResolvers[prompt];
        }
        return respond(request.id, {
          success: true,
          generation: state.generation,
          ...(state.activeRun ?? {}),
        });
      }
      if (request.module === 'files' && request.action === 'resolveWorkspaceContext') {
        const workspaceRoot = typeof request.payload?.workspaceRoot === 'string'
          ? request.payload.workspaceRoot.trim()
          : '';
        const executionCwd = typeof request.payload?.executionCwd === 'string'
          ? request.payload.executionCwd.trim()
          : '';
        if (!workspaceRoot || !executionCwd) {
          return respond(request.id, { ok: false, error: 'outsideSandbox' });
        }
        return respond(request.id, {
          ok: true,
          workspaceRoot,
          executionCwd,
        });
      }
      if (request.module === 'files' && request.action === 'resolveAttachment') {
        return respond(request.id, await productionAttachmentAccess.resolveAttachment(request.payload));
      }
      if (request.module === 'files' && request.action === 'readAttachmentText') {
        return respond(request.id, await productionAttachmentAccess.readAttachmentText(request.payload));
      }
      if (request.module === 'files' && request.action === 'readAttachmentBinary') {
        return respond(request.id, await productionAttachmentAccess.readAttachmentBinary(request.payload));
      }
      if (request.module === 'files' && request.action === 'openAttachment') {
        return respond(request.id, await productionAttachmentAccess.openAttachment(request.payload));
      }
      if (request.module === 'files' && request.action === 'listAttachmentOpenHandlers') {
        return respond(request.id, state.openHandlersResult);
      }
      if (request.module === 'files' && request.action === 'openAttachmentWith') {
        return respond(request.id, { ok: true });
      }
      if (request.module === 'files' && request.action === 'revealAttachment') {
        return respond(request.id, { ok: true });
      }
      if (request.module === 'media' && request.action === 'thumbnails') {
        return respond(request.id, await productionMediaApi.thumbnails(request.payload));
      }
      if (request.module === 'diagnostics' && request.action === 'recordAcpTrace') {
        return respond(request.id, { success: true });
      }

      return originalHostInvoke?.(event, request) ?? respond(request.id, {});
    });
  }, {
    workspaceDir,
    workspaceUri: pathToFileURL(workspaceDir).href,
    productionAttachmentBundlePath,
    sessions: options.sessions,
  });

  const writeFixtureFile = async (root: string, relativePath: string, data: string | Uint8Array) => {
    const filePath = resolve(root, relativePath);
    const fromRoot = relative(root, filePath);
    if (!fromRoot || fromRoot === '..' || fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
      throw new Error(`Attachment fixture path escapes its root: ${relativePath}`);
    }
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, data);
    return filePath;
  };
  const readState = async () => await app.evaluate(async () => {
    const state = (globalThis as unknown as {
      __e2eAttachmentFixture?: {
        hostInvocations: RecordedHostInvocation[];
        shellInvocations: RecordedHostInvocation[];
      };
    }).__e2eAttachmentFixture;
    if (!state) throw new Error('Attachment fixture is not installed');
    return {
      hostInvocations: state.hostInvocations,
      shellInvocations: state.shellInvocations,
    };
  });

  return {
    workspaceDir,
    openClawMediaDir,
    outsideDir,
    createWorkspaceFile: async (path, data) => await writeFixtureFile(workspaceDir, path, data),
    createWorkspaceDirectory: async (path) => {
      const directoryPath = join(workspaceDir, path);
      await mkdir(directoryPath, { recursive: true });
      return realpath(directoryPath);
    },
    createOpenClawMediaFile: async (path, data) => await writeFixtureFile(openClawMediaDir, path, data),
    createOutsideFile: async (path, data) => await writeFixtureFile(outsideDir, path, data),
    registerStagedAttachment: async (id, stagedPath, displayPath) => {
      await app.evaluate(async ({ app: _app }, input) => {
        const state = (globalThis as unknown as {
          __e2eAttachmentFixture?: {
            stagedAttachments?: { register: (id: string, canonicalPath: string, displayPath?: string) => void };
          };
        }).__e2eAttachmentFixture;
        if (!state?.stagedAttachments) throw new Error('Attachment staging fixture is not installed');
        state.stagedAttachments.register(input.id, input.stagedPath, input.displayPath);
      }, { id, stagedPath, displayPath });
    },
    emitAcpSessionUpdates: async (input) => {
      await app.evaluate(async ({ app: _app }, event) => {
        const state = (globalThis as unknown as {
          __e2eAttachmentFixture?: {
            activeRun?: { conversationId: string };
            emitUpdates?: (updates: Array<Record<string, unknown> & { sessionUpdate: string }>) => void;
          };
        }).__e2eAttachmentFixture;
        if (!state) throw new Error('Attachment fixture is not installed');
        if (state.activeRun?.conversationId !== event.sessionKey || !state.emitUpdates) {
          throw new Error(`No active canonical run for ${event.sessionKey}`);
        }
        state.emitUpdates(event.updates);
      }, input);
    },
    setPromptUpdates: async (prompt, updates) => {
      await app.evaluate(async ({ app: _app }, input) => {
        const state = (globalThis as unknown as {
          __e2eAttachmentFixture?: { promptUpdates: Record<string, unknown[]> };
        }).__e2eAttachmentFixture;
        if (!state) throw new Error('Attachment fixture is not installed');
        state.promptUpdates[input.prompt] = input.updates;
      }, { prompt, updates });
    },
    deferPromptResponse: async (prompt) => {
      await app.evaluate(async ({ app: _app }, value) => {
        const state = (globalThis as unknown as {
          __e2eAttachmentFixture?: { deferredPromptResponses: Record<string, boolean> };
        }).__e2eAttachmentFixture;
        if (!state) throw new Error('Attachment fixture is not installed');
        state.deferredPromptResponses[value] = true;
      }, prompt);
    },
    releasePromptResponse: async (prompt, timeoutMs = 5_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const released = await app.evaluate(async ({ app: _app }, value) => {
          const state = (globalThis as unknown as {
            __e2eAttachmentFixture?: {
              deferredPromptResponses: Record<string, boolean>;
              deferredPromptResolvers: Record<string, (() => void) | undefined>;
            };
          }).__e2eAttachmentFixture;
          if (!state) throw new Error('Attachment fixture is not installed');
          const resolvePrompt = state.deferredPromptResolvers[value];
          if (!resolvePrompt) return false;
          delete state.deferredPromptResponses[value];
          resolvePrompt();
          return true;
        }, prompt);
        if (released) return;
        await new Promise(resolveWait => setTimeout(resolveWait, 25));
      }
      throw new Error(`Timed out waiting for deferred prompt response: ${prompt}`);
    },
    setSessionReplay: async (sessionKey, updates) => {
      await app.evaluate(async ({ app: _app }, input) => {
        const state = (globalThis as unknown as {
          __e2eAttachmentFixture?: { replays: Record<string, unknown[]> };
        }).__e2eAttachmentFixture;
        if (!state) throw new Error('Attachment fixture is not installed');
        state.replays[input.sessionKey] = input.updates;
      }, { sessionKey, updates });
    },
    setOpenHandlersResult: async (result) => {
      await app.evaluate(async ({ app: _app }, nextResult) => {
        const state = (globalThis as unknown as {
          __e2eAttachmentFixture?: { openHandlersResult: AttachmentOpenHandlersFixtureResult };
        }).__e2eAttachmentFixture;
        if (!state) throw new Error('Attachment fixture is not installed');
        state.openHandlersResult = nextResult;
      }, result);
    },
    getHostInvocations: async () => (await readState()).hostInvocations,
    getShellInvocations: async () => (await readState()).shellInvocations,
    clearInvocations: async () => {
      await app.evaluate(async () => {
        const state = (globalThis as unknown as {
          __e2eAttachmentFixture?: {
            hostInvocations: RecordedHostInvocation[];
            shellInvocations: RecordedHostInvocation[];
          };
        }).__e2eAttachmentFixture;
        if (!state) throw new Error('Attachment fixture is not installed');
        state.hostInvocations = [];
        state.shellInvocations = [];
      });
    },
  };
}

export async function getRecordedHostInvocations(app: ElectronApplication): Promise<RecordedHostInvocation[]> {
  return await app.evaluate(async ({ app: _app }) => (
    (globalThis as unknown as { __e2eHostInvocations?: RecordedHostInvocation[] }).__e2eHostInvocations ?? []
  ));
}

export async function emitKernelStatus(
  app: ElectronApplication,
  snapshot: KernelRuntimeSnapshot,
): Promise<void> {
  await app.evaluate(async ({ app: _app }, nextSnapshot) => {
    const { BrowserWindow } = process.mainModule!.require('electron') as typeof import('electron');
    const globals = globalThis as unknown as { __e2eKernelFixture?: KernelHostFixtureConfig };
    if (globals.__e2eKernelFixture) {
      globals.__e2eKernelFixture.runtimes = [
        ...globals.__e2eKernelFixture.runtimes.filter(item => item.kernelId !== nextSnapshot.kernelId),
        nextSnapshot,
      ];
      globals.__e2eKernelFixture.catalog = {
        ...globals.__e2eKernelFixture.catalog,
        entries: globals.__e2eKernelFixture.catalog.entries.map(entry => entry.kernelId === nextSnapshot.kernelId
          ? { ...entry, runtime: nextSnapshot }
          : entry),
      };
    }
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('kernels:status-changed', nextSnapshot);
    }
  }, snapshot);
}

export async function emitKernelPackageProgress(
  app: ElectronApplication,
  progress: KernelPackageProgressEvent,
): Promise<void> {
  await app.evaluate(async ({ app: _app }, nextProgress) => {
    const { BrowserWindow } = process.mainModule!.require('electron') as typeof import('electron');
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('kernels:package-progress', nextProgress);
    }
  }, progress);
}

export async function emitKernelEvents(
  app: ElectronApplication,
  events: KernelEventEnvelopeV1[],
  intervalMs = 0,
): Promise<void> {
  await app.evaluate(async ({ app: _app }, input) => {
    const { BrowserWindow } = process.mainModule!.require('electron') as typeof import('electron');
    for (const event of input.events) {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send('chat:kernel-event', event);
      }
      if (input.intervalMs > 0) {
        await new Promise(resolveWait => setTimeout(resolveWait, input.intervalMs));
      }
    }
  }, { events, intervalMs });
}

export async function getRecordedLegacyIpcInvocations(app: ElectronApplication): Promise<RecordedLegacyIpcInvocation[]> {
  return await app.evaluate(async ({ app: _app }) => (
    (globalThis as unknown as { __e2eLegacyIpcInvocations?: RecordedLegacyIpcInvocation[] })
      .__e2eLegacyIpcInvocations ?? []
  ));
}

export async function clearRecordedFileAccessInvocations(app: ElectronApplication): Promise<void> {
  await app.evaluate(async ({ app: _app }) => {
    const globals = globalThis as unknown as {
      __e2eHostInvocations?: RecordedHostInvocation[];
      __e2eLegacyIpcInvocations?: RecordedLegacyIpcInvocation[];
    };
    globals.__e2eHostInvocations = [];
    globals.__e2eLegacyIpcInvocations = [];
  });
}
