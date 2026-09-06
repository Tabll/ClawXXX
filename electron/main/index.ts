/**
 * Electron Main Process Entry
 * Manages window creation, system tray, and IPC handlers
 */
import { app, BrowserWindow, nativeImage, session, shell, type Session } from 'electron';
import { join } from 'path';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { GatewayManager } from '../gateway/manager';
import { registerOpenClawConfigCoordinator } from '../gateway/config-delivery';
import { registerIpcHandlers } from './ipc-handlers';
import { HostApiRegistry } from './ipc/host-invoke';
import { createTray } from './tray';
import { createMenu } from './menu';
import { registerZoomShortcuts } from './zoom-shortcuts';

import { appUpdater, registerUpdateHandlers } from './updater';
import { logger } from '../utils/logger';
import { warmupNetworkOptimization } from '../utils/uv-env';
import { initTelemetry } from '../utils/telemetry';

import { ClawHubService } from '../gateway/clawhub';
import { extensionRegistry } from '../extensions/registry';
import { loadExtensionsFromManifest } from '../extensions/loader';
import { registerAllBuiltinExtensions } from '../extensions/builtin';
import { loadExternalMainExtensions } from '../extensions/_ext-bridge.generated';
import {
  ensureClawXContext,
  ensureClawXDefaultIdentity,
  repairClawXOnlyBootstrapFiles,
} from '../utils/openclaw-workspace';
import { autoInstallCliIfNeeded, generateCompletionCache, installCompletionToProfile } from '../utils/openclaw-cli';
import { isQuitting, setQuitting } from './app-state';
import { getMacTrafficLightPosition, syncMacTrafficLightPosition } from './traffic-light-layout';
import { getSetting } from '../utils/store';
import { applyProxySettings } from './proxy';
import { syncLaunchAtStartupSettingFromStore } from './launch-at-startup';
import { WebBrowserGuestRegistry, installWebBrowserGuestPolicy } from './web-browser-policy';
import { configureWebBrowserSession } from './web-browser-session';
import {
  clearPendingSecondInstanceFocus,
  consumeMainWindowReady,
  createMainWindowFocusState,
  requestSecondInstanceFocus,
} from './main-window-focus';
import {
  createQuitLifecycleState,
  markQuitCleanupCompleted,
  requestQuitLifecycleAction,
} from './quit-lifecycle';
import { createSignalQuitHandler } from './signal-quit';
import { acquireProcessInstanceFileLock } from './process-instance-lock';
import { ensureBuiltinSkillsInstalled, ensurePreinstalledSkillsInstalled, trimBundledOpenClawSkillsAndConfigs } from '../utils/skill-config';

import { deviceOAuthManager } from '../utils/device-oauth';
import { browserOAuthManager } from '../utils/browser-oauth';
import { whatsAppLoginManager } from '../utils/whatsapp-login';
import { syncAllProviderAuthToRuntime } from '../services/providers/provider-runtime-sync';
import { configureCanonicalProviderStore } from '../services/providers/provider-store';
import { ensureProviderStoreMigrated } from '../services/providers/provider-migration';
import { migrateLegacyProviderSecrets } from '../services/secrets/secret-store';
import { ClawXDataServiceUtilityHost, type RemoteDataServiceClient } from '../data/data-service-utility-host';
import { ElectronDataServiceTransport } from '../data/electron-utility-transport';
import { prepareClawXDataStore } from '../data/data-recovery';
import { KernelLaunchRegistry } from '../kernels/launch-registry';
import { KernelSupervisorRegistry } from '../kernels/supervisor-registry';
import { RuntimeLifecycleCoordinator } from '../kernels/runtime-lifecycle-coordinator';
import { getKernelAutoStartPolicies } from '../kernels/auto-start-policy';
import {
  clearOpenClawChannelHandoffEndpoint,
  configureOpenClawChannelHandoffEndpoint,
  configureOpenClawRuntimeLocation,
  clearOpenClawRuntimeLocation,
  createDevelopmentOpenClawRuntimeLocation,
  resolveOpenClawRuntimeLocation,
  type OpenClawRuntimeLocation,
} from '../kernels/openclaw/runtime-location';
import {
  buildDeepSeekHarnessEnvironment,
  createDevelopmentDeepSeekHarnessRuntimeLocation,
  resolveDeepSeekHarnessRuntimeLocation,
  type DeepSeekHarnessRuntimeLocation,
} from '../kernels/deepseek-harness/runtime-location';
import { OpenClawKernelDriver } from '../kernels/openclaw/openclaw-driver';
import { OpenClawAcpChatAdapter } from '../kernels/openclaw/acp-chat-adapter';
import { createOpenClawGatewayControlPlane } from '../kernels/openclaw/gateway-control-plane';
import { assertNoForbiddenOpenClawHistory } from '../kernels/openclaw/managed-history-guard';
import { assertManagedOpenClawRuntimeProtocol } from '../kernels/openclaw/runtime-location';
import { RemoteConversationStoreProtocolClient } from '../data/conversation-store-client';
import { AcpSessionAccessRegistry } from '../services/acp-session-access-registry';
import { createAcpChatService, type AcpChatService } from '../services/acp-chat-service';
import { OpenClawLegacyExtensionAdapter } from '../extensions/openclaw-legacy-adapter';
import type { KernelDriver } from '@shared/kernels/contracts';
import { ConversationRouter } from '../conversations/conversation-router';
import { HOST_EVENT_CHANNELS } from '@shared/host-events/contract';
import { CredentialBroker, type CredentialPurpose } from '../security/credential-broker';
import {
  ProviderProjectionReconciler,
  createOpenClawProviderProjectionAdapter,
  createSupervisorProviderAdapter,
} from '../services/providers/provider-projection-reconciler';
import type { KernelProviderDefault } from '@shared/domains/providers';
import type { KernelAgentDefault } from '@shared/domains/agents';
import { CanonicalAgentService } from '../domains/agents/agent-service';
import { ensureCanonicalAgentCatalog } from '../domains/agents/agent-migration';
import {
  AgentProjectionReconciler,
  createSupervisorAgentProjectionAdapter,
} from '../domains/agents/agent-projection-reconciler';
import { createOpenClawAgentProjectionAdapter } from '../domains/agents/openclaw-agent-adapter';
import { listAgentsSnapshot } from '../utils/agent-config';
import { CanonicalSkillPackageStore, assertIndependentSkillRoots } from '../domains/skills/skill-package-store';
import { CanonicalSkillService } from '../domains/skills/skill-service';
import { ensureCanonicalSkillCatalog } from '../domains/skills/skill-migration';
import { SkillProjectionReconciler } from '../domains/skills/skill-projection-reconciler';
import { createOpenClawSkillProjectionAdapter } from '../domains/skills/openclaw-skill-adapter';
import { createSupervisorSkillProjectionAdapter } from '../domains/skills/supervisor-skill-adapter';
import { listLocalSkills } from '../services/skills/local-skill-service';
import { getOpenClawSkillsDir } from '../utils/paths';
import { SafeStorageChannelSecretStore } from '../channels/channel-secret-store';
import {
  CanonicalChannelAccountService,
  ensureCanonicalChannelCatalog,
} from '../channels/channel-account-service';
import { scanLegacyOpenClawChannels } from '../channels/channel-migration';
import { ChannelConnectorRegistry } from '../channels/channel-connector-registry';
import { registerBuiltinChannelConnectors } from '../channels/connectors';
import { ChannelAdapterRegistry } from '../channels/channel-adapter-registry';
import { RelayChannelAdapter } from '../channels/relay-channel-adapter';
import { OpenClawChannelAdapter } from '../channels/openclaw-channel-adapter';
import {
  ManagedOpenClawChannelBackend,
  ensureHandoffPluginProjection,
} from '../channels/managed-openclaw-channel-backend';
import { ChannelHandoffServer } from '../channels/channel-handoff-server';
import { ChannelOwnerCoordinator } from '../channels/channel-owner-coordinator';
import { ChannelBindingService } from '../channels/channel-binding-service';
import { ChannelOrchestrator } from '../channels/channel-orchestrator';
import { ClawXScheduler } from '../scheduler/clawx-scheduler';
import { listCanonicalOpenClawChannelTargets } from '../services/channels-api';
import { RemoteKernelPackageStateStore } from '../kernels/package-manager/state';
import { KernelPackageManager } from '../kernels/package-manager';
import { KernelPackageController } from '../kernels/package-manager/controller';
import {
  createKernelHostCompatibility,
  loadKernelDistributionConfiguration,
} from '../kernels/package-manager/config';
import type { KernelRuntimeSnapshot } from '@shared/kernels/contracts';

const WINDOWS_APP_USER_MODEL_ID = 'app.clawx.desktop';
const isE2EMode = process.env.CLAWX_E2E === '1';
const requestedUserDataDir = process.env.CLAWX_USER_DATA_DIR?.trim();
const requestedRemoteDebuggingPort = process.env.CLAWX_REMOTE_DEBUGGING_PORT?.trim();

if (requestedRemoteDebuggingPort) {
  app.commandLine.appendSwitch('remote-debugging-port', requestedRemoteDebuggingPort);
}

if (isE2EMode && requestedUserDataDir) {
  app.setPath('userData', requestedUserDataDir);
}

// On Linux, set CHROME_DESKTOP so Chromium can find the correct .desktop file.
// On Wayland this maps the running window to clawx.desktop (→ icon + app grouping);
// on X11 it supplements the StartupWMClass matching.
// Must be called before app.whenReady() / before any window is created.
if (process.platform === 'linux') {
  const linuxApp = app as typeof app & { setDesktopName?: (desktopName: string) => void };
  linuxApp.setDesktopName?.('clawx.desktop');
}

// Prevent multiple instances of the app from running simultaneously.
// Without this, two instances each spawn their own gateway process on the
// same port, then each treats the other's gateway as "orphaned" and kills
// it — creating an infinite kill/restart loop on Windows.
// The losing process must exit immediately so it never reaches Gateway startup.
const gotElectronLock = isE2EMode ? true : app.requestSingleInstanceLock();
if (!gotElectronLock) {
  console.info('[ClawX] Another instance already holds the single-instance lock; exiting duplicate process');
  app.exit(0);
}
let releaseProcessInstanceFileLock: () => void = () => {};
let gotFileLock = true;
if (gotElectronLock && !isE2EMode) {
  try {
    const fileLock = acquireProcessInstanceFileLock({
      userDataDir: app.getPath('userData'),
      lockName: 'clawx',
      force: true, // Electron lock already guarantees exclusivity; force-clean orphan/recycled-PID locks
    });
    gotFileLock = fileLock.acquired;
    releaseProcessInstanceFileLock = fileLock.release;
    if (!fileLock.acquired) {
      const ownerDescriptor = fileLock.ownerPid
        ? `${fileLock.ownerFormat ?? 'legacy'} pid=${fileLock.ownerPid}`
        : fileLock.ownerFormat === 'unknown'
          ? 'unknown lock format/content'
          : 'unknown owner';
      console.info(
        `[ClawX] Another instance already holds process lock (${fileLock.lockPath}, ${ownerDescriptor}); exiting duplicate process`,
      );
      app.exit(0);
    }
  } catch (error) {
    console.warn('[ClawX] Failed to acquire process instance file lock; continuing with Electron single-instance lock only', error);
  }
}
const gotTheLock = gotElectronLock && gotFileLock;

// Global references
let mainWindow: BrowserWindow | null = null;
let gatewayManager!: GatewayManager;
let clawHubService!: ClawHubService;
let dataServiceHost: ClawXDataServiceUtilityHost | undefined;
let mainDataClient: RemoteDataServiceClient | undefined;
let conversationRouter: ConversationRouter | undefined;
let openClawAcp: { service: AcpChatService; access: AcpSessionAccessRegistry } | undefined;
let openClawRuntimeLocation: OpenClawRuntimeLocation | undefined;
let deepSeekHarnessRuntimeLocation: DeepSeekHarnessRuntimeLocation | undefined;
let providerProjectionReconciler: ProviderProjectionReconciler | undefined;
let agentService: CanonicalAgentService | undefined;
let agentProjectionReconciler: AgentProjectionReconciler | undefined;
let skillService: CanonicalSkillService | undefined;
let skillProjectionReconciler: SkillProjectionReconciler | undefined;
let skillPackageStore: CanonicalSkillPackageStore | undefined;
let channelAccountService: CanonicalChannelAccountService | undefined;
let channelAdapterRegistry: ChannelAdapterRegistry | undefined;
let channelOwnerCoordinator: ChannelOwnerCoordinator | undefined;
let channelBindingService: ChannelBindingService | undefined;
let channelOrchestrator: ChannelOrchestrator | undefined;
let clawXScheduler: ClawXScheduler | undefined;
let kernelPackageController: KernelPackageController | undefined;
let channelHandoffServer: ChannelHandoffServer | undefined;
let relayChannelAdapter: RelayChannelAdapter | undefined;
let openClawChannelAdapter: OpenClawChannelAdapter | undefined;
const activeKernelDrivers = new Map<string, KernelDriver>();
const hostApiRegistry = new HostApiRegistry();
const webBrowserGuestRegistry = new WebBrowserGuestRegistry();
let webBrowserSession!: Session;
const mainWindowFocusState = createMainWindowFocusState();
const quitLifecycleState = createQuitLifecycleState();
const kernelLaunchRegistry = new KernelLaunchRegistry();
const kernelSupervisorRegistry = new KernelSupervisorRegistry(
  (kernelId, generation) => kernelLaunchRegistry.resolve(kernelId, generation),
  { isLaunchAvailable: kernelId => kernelLaunchRegistry.has(kernelId) },
);
const runtimeLifecycleCoordinator = new RuntimeLifecycleCoordinator();
const credentialBroker = new CredentialBroker({
  getAccount: async accountId => {
    const { getCanonicalProviderAccount } = await import('../services/providers/provider-store');
    return getCanonicalProviderAccount(accountId);
  },
  getSecret: async accountId => {
    const { getProviderSecret } = await import('../services/secrets/secret-store');
    return getProviderSecret(accountId);
  },
  audit: event => logger.debug('[credential-broker] authorization event', event),
});

function sendMainWindowEvent(channel: string, payload: unknown): void {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  win.webContents.send(channel, payload);
}

async function resolveManagedOpenClawRuntime(): Promise<OpenClawRuntimeLocation | undefined> {
  const userDataRoot = app.getPath('userData');
  if (app.isPackaged) {
    const installation = await mainDataClient?.call<import('@shared/kernels/package-manager').KernelInstallationRecord | undefined>(
      'getKernelInstallation',
      'openclaw',
    );
    if (!installation) return undefined;
    return resolveOpenClawRuntimeLocation({
      installation,
      packageRoot: join(userDataRoot, 'kernels'),
      userDataRoot,
    });
  }

  const packageDir = process.env.CLAWX_OPENCLAW_DEV_PACKAGE_DIR?.trim()
    || join(__dirname, '../../node_modules/openclaw');
  const packagePath = join(packageDir, 'package.json');
  const entryPath = join(packageDir, 'openclaw.mjs');
  if (!existsSync(packagePath) || !existsSync(entryPath)) return undefined;
  const metadata = JSON.parse(readFileSync(packagePath, 'utf8')) as { version?: string };
  return createDevelopmentOpenClawRuntimeLocation({
    packageDir,
    userDataRoot,
    artifactVersion: metadata.version ? `${metadata.version}+development` : 'development',
  });
}

async function registerManagedOpenClawRuntime(window: BrowserWindow): Promise<void> {
  openClawRuntimeLocation = await resolveManagedOpenClawRuntime();
  if (!openClawRuntimeLocation) {
    logger.info('OpenClaw optional runtime is not installed; no OpenClaw lifecycle or file side effects will run');
    return;
  }
  configureOpenClawRuntimeLocation(openClawRuntimeLocation);
  const access = new AcpSessionAccessRegistry();
  const service = createAcpChatService(window, access, gatewayManager);
  openClawAcp = { service, access };

  kernelLaunchRegistry.register('openclaw', async (generation) => {
    if (!dataServiceHost || !openClawRuntimeLocation) {
      throw new Error('OpenClaw cannot start before DataService and its verified runtime are ready');
    }
    const dataClient = await dataServiceHost.connect({ role: 'kernel', kernelId: 'openclaw', generation });
    const store = new RemoteConversationStoreProtocolClient(dataClient, 'openclaw');
    const credentialIdentity = {
      kernelId: 'openclaw' as const,
      generation,
      pid: process.pid,
      artifactVersion: openClawRuntimeLocation.artifactVersion,
    };
    const revokeCredentials = credentialBroker.registerProcess(credentialIdentity);
    const chat = new OpenClawAcpChatAdapter(
      service,
      async () => { await assertNoForbiddenOpenClawHistory(openClawRuntimeLocation!); },
    );
    const driver = new OpenClawKernelDriver({
      generation,
      runtime: openClawRuntimeLocation,
      gateway: gatewayManager,
      chat,
      control: createOpenClawGatewayControlPlane(gatewayManager),
      hooks: {
        beforeStart: async () => {
          assertManagedOpenClawRuntimeProtocol(openClawRuntimeLocation!);
          await assertNoForbiddenOpenClawHistory(openClawRuntimeLocation!);
          await syncAllProviderAuthToRuntime();
          await ensureClawXDefaultIdentity();
          await repairClawXOnlyBootstrapFiles();
          await ensureBuiltinSkillsInstalled();
          await trimBundledOpenClawSkillsAndConfigs();
          await ensurePreinstalledSkillsInstalled();
        },
        afterStart: async () => {
          await ensureClawXContext();
          if (app.isPackaged) {
            await autoInstallCliIfNeeded((installedPath) => {
              mainWindow?.webContents.send('openclaw:cli-installed', installedPath);
            });
            generateCompletionCache();
            installCompletionToProfile();
          }
        },
        afterStop: async () => {
          revokeCredentials();
          await assertNoForbiddenOpenClawHistory(openClawRuntimeLocation!);
          await dataClient.disconnect();
          if (activeKernelDrivers.get('openclaw') === driver) activeKernelDrivers.delete('openclaw');
        },
      },
    });
    activeKernelDrivers.set('openclaw', driver);
    return {
      kind: 'driver',
      driver,
      artifactVersion: openClawRuntimeLocation.artifactVersion,
      host: {
        store,
        // ConversationRouter is the sole canonical event writer. The in-process
        // runtime forwards this same event to the supervisor after this hook.
        emit: async () => undefined,
        log: (level, message, fields) => {
          logger[level](`[kernel:openclaw:g${generation}] ${message}`, fields ?? {});
          kernelSupervisorRegistry.recordLog('openclaw', generation, level, message, fields);
        },
        requestCredential: async (input) => {
          if (input.kernelId !== 'openclaw' || input.generation !== generation) {
            throw new Error('Credential request is outside the OpenClaw generation');
          }
          return credentialBroker.resolve({
            ...credentialIdentity,
            accountId: input.accountId,
            purpose: input.purpose,
          });
        },
      },
    };
  });
}

async function resolveManagedDeepSeekHarnessRuntime(): Promise<DeepSeekHarnessRuntimeLocation | undefined> {
  const userDataRoot = app.getPath('userData');
  if (app.isPackaged) {
    const installation = await mainDataClient?.call<import('@shared/kernels/package-manager').KernelInstallationRecord | undefined>(
      'getKernelInstallation',
      'deepseek-harness',
    );
    if (!installation) return undefined;
    return resolveDeepSeekHarnessRuntimeLocation({
      installation,
      packageRoot: join(userDataRoot, 'kernels'),
      userDataRoot,
    });
  }
  const packageDir = process.env.CLAWX_DSH_DEV_PACKAGE_DIR?.trim();
  if (!packageDir) return undefined;
  return createDevelopmentDeepSeekHarnessRuntimeLocation({
    packageDir,
    userDataRoot,
    artifactVersion: process.env.CLAWX_DSH_DEV_ARTIFACT_VERSION ?? 'development',
    capabilitiesDigest: process.env.CLAWX_DSH_DEV_CAPABILITIES_DIGEST ?? 'development-unverified',
  });
}

async function registerManagedDeepSeekHarnessRuntime(): Promise<void> {
  deepSeekHarnessRuntimeLocation = await resolveManagedDeepSeekHarnessRuntime();
  if (!deepSeekHarnessRuntimeLocation) {
    logger.info('DeepSeek Harness optional runtime is not installed; no DSH process will be started');
    return;
  }
  const location = deepSeekHarnessRuntimeLocation;
  kernelLaunchRegistry.register('deepseek-harness', (generation) => ({
    command: location.nodeExecutable,
    args: [location.entryPath],
    cwd: location.packageDir,
    env: buildDeepSeekHarnessEnvironment(location, generation),
    artifactVersion: location.artifactVersion,
    startupTimeoutMs: 30_000,
    shutdownTimeoutMs: 10_000,
    ...(() => {
      let revoke = () => {};
      return {
        onProcessReady: (identity: import('../kernels/stdio-kernel-process').KernelOwnedProcessIdentity) => {
          revoke = credentialBroker.registerProcess(identity);
        },
        onProcessExit: () => { revoke(); },
        handleHostRequest: async (request: import('../kernels/stdio-kernel-process').KernelHostRequest) => {
          if (request.method !== 'credential.resolve'
            || !request.params
            || typeof request.params !== 'object'
            || Array.isArray(request.params)) {
            throw new Error('Unsupported or invalid kernel host request');
          }
          const params = request.params as Record<string, unknown>;
          const accountId = typeof params.accountId === 'string' ? params.accountId.trim() : '';
          const purpose = params.purpose;
          if (!accountId
            || (purpose !== 'model-request' && purpose !== 'channel-connect' && purpose !== 'provider-validate')) {
            throw new Error('Credential request account or purpose is invalid');
          }
          const value = await credentialBroker.resolve({
            kernelId: request.kernelId,
            generation: request.generation,
            pid: request.pid,
            artifactVersion: request.artifactVersion,
            accountId,
            purpose: purpose as CredentialPurpose,
          });
          return { value };
        },
      };
    })(),
  }));
}

async function initializeChannelRuntime(): Promise<void> {
  if (!mainDataClient || !conversationRouter) {
    throw new Error('Channel runtime requires ClawX DataService and ConversationRouter');
  }
  channelAccountService = new CanonicalChannelAccountService(
    mainDataClient,
    new SafeStorageChannelSecretStore(),
  );
  await ensureCanonicalChannelCatalog({
    service: channelAccountService,
    scanLegacy: openClawRuntimeLocation ? scanLegacyOpenClawChannels : async () => [],
  });

  const connectors = new ChannelConnectorRegistry();
  registerBuiltinChannelConnectors(connectors, {
    projectionRoot: join(app.getPath('userData'), 'kernel-config', 'channel-relay'),
    persistCredential: (accountId, values) => channelAccountService!.updateSecrets(accountId, values),
  });
  channelAdapterRegistry = new ChannelAdapterRegistry();
  relayChannelAdapter = new RelayChannelAdapter(connectors);
  channelAdapterRegistry.register(relayChannelAdapter);

  if (openClawRuntimeLocation) {
    channelHandoffServer = new ChannelHandoffServer();
    const endpoint = await channelHandoffServer.start();
    configureOpenClawChannelHandoffEndpoint(endpoint);
    const pluginPath = app.isPackaged
      ? join(openClawRuntimeLocation.packageDir, 'clawx-channel-handoff')
      : join(process.cwd(), 'kernels', 'openclaw', 'overlay', 'clawx-channel-handoff');
    if (!existsSync(join(pluginPath, 'openclaw.plugin.json'))) {
      throw new Error(`Verified OpenClaw Channel handoff plugin is missing: ${pluginPath}`);
    }
    await ensureHandoffPluginProjection(pluginPath);
    const backend = new ManagedOpenClawChannelBackend(
      gatewayManager,
      channelHandoffServer,
      pluginPath,
      (channelType, nativeAccountId, query) => listCanonicalOpenClawChannelTargets({
        channelType,
        accountId: nativeAccountId,
        query,
      }),
      (accountId, values) => channelAccountService!.updateSecrets(accountId, values),
    );
    openClawChannelAdapter = new OpenClawChannelAdapter(backend);
    channelAdapterRegistry.register(openClawChannelAdapter);
  }

  await channelAccountService.extendSupportedKernels(account => (
    channelAdapterRegistry!.list()
      .filter(adapter => adapter.supportedChannels.includes(account.channelType))
      .map(adapter => adapter.kernelId)
  ));

  let admission: ChannelOrchestrator | undefined;
  channelOwnerCoordinator = new ChannelOwnerCoordinator(
    mainDataClient,
    channelAccountService,
    channelAdapterRegistry,
    async envelope => {
      if (!admission) throw new Error('Channel Orchestrator is not ready');
      await admission.acceptInbound(envelope);
    },
  );
  channelOrchestrator = new ChannelOrchestrator(
    mainDataClient,
    conversationRouter,
    channelOwnerCoordinator,
  );
  admission = channelOrchestrator;
  channelBindingService = new ChannelBindingService(mainDataClient, channelOwnerCoordinator);
}

async function stopChannelRuntime(): Promise<void> {
  channelOrchestrator?.stop();
  await channelOwnerCoordinator?.stop().catch(error => {
    logger.warn('Channel owner shutdown failed', error);
  });
  await Promise.allSettled([
    relayChannelAdapter?.stop(),
    openClawChannelAdapter?.stop(),
  ]);
  await channelHandoffServer?.stop().catch(error => {
    logger.warn('Channel handoff shutdown failed', error);
  });
  clearOpenClawChannelHandoffEndpoint();
}

/**
 * Resolve the icons directory path (works in both dev and packaged mode)
 */
function getIconsDir(): string {
  if (app.isPackaged) {
    // Packaged: icons are in extraResources → process.resourcesPath/resources/icons
    return join(process.resourcesPath, 'resources', 'icons');
  }
  // Development: relative to dist-electron/main/
  return join(__dirname, '../../resources/icons');
}

/**
 * Get the app icon for the current platform
 */
function getAppIcon(): Electron.NativeImage | undefined {
  if (process.platform === 'darwin') return undefined; // macOS uses the app bundle icon

  const iconsDir = getIconsDir();
  const iconPath =
    process.platform === 'win32'
      ? join(iconsDir, 'icon.ico')
      : join(iconsDir, 'icon.png');
  const icon = nativeImage.createFromPath(iconPath);
  return icon.isEmpty() ? undefined : icon;
}

/**
 * Create the main application window
 */
function createWindow(): BrowserWindow {
  const isMac = process.platform === 'darwin';
  const isWindows = process.platform === 'win32';
  const useCustomTitleBar = isWindows;
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    icon: getAppIcon(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webviewTag: true, // Enable <webview> for embedding OpenClaw Control UI
    },
    titleBarStyle: isMac ? 'hiddenInset' : useCustomTitleBar ? 'hidden' : 'default',
    trafficLightPosition: isMac
      ? getMacTrafficLightPosition(false)
      : undefined,
    frame: isMac || !useCustomTitleBar,
    show: false,
  });

  installWebBrowserGuestPolicy(win.webContents, {
    browserSession: webBrowserSession,
    registry: webBrowserGuestRegistry,
  });

  registerZoomShortcuts(win);

  // Handle external links — only allow safe protocols to prevent arbitrary
  // command execution via shell.openExternal() (e.g. file://, ms-msdt:, etc.)
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        shell.openExternal(url);
      } else {
        logger.warn(`Blocked openExternal for disallowed protocol: ${parsed.protocol}`);
      }
    } catch {
      logger.warn(`Blocked openExternal for malformed URL: ${url}`);
    }
    return { action: 'deny' };
  });

  return win;
}

function loadMainWindow(win: BrowserWindow): void {
  const shouldSkipSetupForE2E = process.env.CLAWX_E2E_SKIP_SETUP === '1';

  if (process.env.VITE_DEV_SERVER_URL) {
    const rendererUrl = new URL(process.env.VITE_DEV_SERVER_URL);
    if (shouldSkipSetupForE2E) {
      rendererUrl.searchParams.set('e2eSkipSetup', '1');
    }
    win.loadURL(rendererUrl.toString());
    if (!isE2EMode) {
      win.webContents.openDevTools();
    }
  } else {
    win.loadFile(join(__dirname, '../../dist/index.html'), {
      query: shouldSkipSetupForE2E
        ? { e2eSkipSetup: '1' }
        : undefined,
    });
  }
}

function focusWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) {
    return;
  }

  if (win.isMinimized()) {
    win.restore();
  }

  win.show();
  win.focus();
}

function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  clearPendingSecondInstanceFocus(mainWindowFocusState);
  focusWindow(mainWindow);
}

function createMainWindow(): BrowserWindow {
  const win = createWindow();

  win.once('ready-to-show', () => {
    if (mainWindow !== win) {
      return;
    }

    if (process.platform === 'darwin') {
      void getSetting('sidebarCollapsed').then((sidebarCollapsed) => {
        syncMacTrafficLightPosition(win, sidebarCollapsed);
      });
    }

    const action = consumeMainWindowReady(mainWindowFocusState);
    if (action === 'focus') {
      focusWindow(win);
      return;
    }

    win.show();
  });

  win.on('close', (event) => {
    if (!isQuitting() && !isE2EMode) {
      event.preventDefault();
      win.hide();
    }
  });

  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null;
    }
  });

  mainWindow = win;
  return win;
}

/**
 * Initialize the application
 */
async function initialize(): Promise<void> {
  // Initialize logger first
  logger.init();
  kernelSupervisorRegistry.configureLogRoot(join(app.getPath('userData'), 'logs', 'kernels'));
  logger.info('=== ClawX Application Starting ===');
  logger.debug(
    `Runtime: platform=${process.platform}/${process.arch}, electron=${process.versions.electron}, node=${process.versions.node}, packaged=${app.isPackaged}, pid=${process.pid}, ppid=${process.ppid}`
  );

  const dataRoot = join(app.getPath('userData'), 'state');
  const databasePath = join(dataRoot, 'clawx.sqlite');
  const recovery = prepareClawXDataStore({
    databasePath,
    quarantineRoot: join(dataRoot, 'quarantine'),
  });
  if (recovery.state === 'read-only') {
    throw new Error(`ClawX data store is read-only; runtime dispatch is disabled. ${recovery.diagnostic ?? ''}`.trim());
  }
  if (recovery.state === 'quarantined' || recovery.state === 'restored-backup') {
    logger.warn('ClawX data recovery completed before DataService startup', recovery);
  } else {
    logger.info(`ClawX data recovery check: ${recovery.state}`);
  }
  const dataEntry = join(__dirname, '../data/utility-process-entry.js');
  dataServiceHost = new ClawXDataServiceUtilityHost(() => new ElectronDataServiceTransport(
    dataEntry,
    databasePath,
    join(dataRoot, 'blobs'),
  ));
  await dataServiceHost.start();
  mainDataClient = await dataServiceHost.connect({ role: 'main' });
  const kernelPackageState = new RemoteKernelPackageStateStore(mainDataClient);
  const kernelDistribution = loadKernelDistributionConfiguration({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    projectRoot: process.cwd(),
  });
  const kernelHostCompatibility = createKernelHostCompatibility({ hostVersion: app.getVersion() });
  const kernelPackageManager = kernelDistribution.trustStore
    ? new KernelPackageManager({
      root: join(app.getPath('userData'), 'kernels'),
      state: kernelPackageState,
      trustStore: kernelDistribution.trustStore,
      host: kernelHostCompatibility,
      isVersionInUse: (kernelId, artifactVersion) => (
        kernelSupervisorRegistry.isVersionInUse(kernelId, artifactVersion)
      ),
      isKernelBusy: kernelId => kernelSupervisorRegistry.isKernelBusy(kernelId),
    })
    : undefined;
  if (kernelPackageManager) {
    await kernelPackageManager.recoverInterruptedOperations();
  } else if (kernelDistribution.unavailableReason) {
    logger.warn(kernelDistribution.unavailableReason);
  }
  kernelPackageController = new KernelPackageController({
    ...(kernelPackageManager ? { manager: kernelPackageManager } : {}),
    ...(kernelDistribution.unavailableReason
      ? { unavailableReason: kernelDistribution.unavailableReason }
      : {}),
    state: kernelPackageState,
    supervisors: kernelSupervisorRegistry,
    host: kernelHostCompatibility,
    channel: kernelDistribution.channel,
    catalogUrls: kernelDistribution.catalogUrls,
    mirrorBaseUrls: kernelDistribution.mirrorBaseUrls,
    onProgress: progress => sendMainWindowEvent(HOST_EVENT_CHANNELS.kernels.packageProgress, progress),
    onChanged: () => sendMainWindowEvent(HOST_EVENT_CHANNELS.kernels.catalogChanged, undefined),
    onActivated: async (kernelId) => {
      // The immutable launch resolver captures an exact verified artifact.
      // Prevent a stale launch after activation; the next app generation
      // rebuilds all dependent adapters and projections from the new pointer.
      kernelLaunchRegistry.unregister(kernelId);
      if (kernelId === 'openclaw') {
        clearOpenClawRuntimeLocation();
        openClawRuntimeLocation = undefined;
      } else if (kernelId === 'deepseek-harness') {
        deepSeekHarnessRuntimeLocation = undefined;
      }
      return { restartRequired: true };
    },
    onUninstalled: async (kernelId) => {
      kernelLaunchRegistry.unregister(kernelId);
      if (kernelId === 'openclaw') {
        clearOpenClawRuntimeLocation();
        openClawRuntimeLocation = undefined;
      } else if (kernelId === 'deepseek-harness') {
        deepSeekHarnessRuntimeLocation = undefined;
      }
    },
    openDirectory: async (kernelId, kind) => {
      const directory = kind === 'logs'
        ? join(app.getPath('userData'), 'logs', 'kernels', kernelId)
        : join(app.getPath('userData'), 'kernel-config', kernelId);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const failure = await shell.openPath(directory);
      if (failure) throw new Error(failure);
    },
  });
  const agentWorkspaceRoot = join(app.getPath('userData'), 'workspaces');
  const defaultAgentWorkspaceUri = (agentId: string): string => {
    const workspace = join(agentWorkspaceRoot, agentId);
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    return pathToFileURL(workspace).href;
  };
  agentService = new CanonicalAgentService(mainDataClient, defaultAgentWorkspaceUri);
  configureCanonicalProviderStore(mainDataClient);
  await ensureProviderStoreMigrated();
  await migrateLegacyProviderSecrets();
  conversationRouter = new ConversationRouter({
    supervisors: kernelSupervisorRegistry,
    mainData: mainDataClient,
    connectKernelData: async (kernelId, generation) => {
      if (!dataServiceHost) throw new Error('ClawX DataService is not available');
      return dataServiceHost.connect({ role: 'kernel', kernelId, generation });
    },
    resolveProviderDefault: kernelId => (
      mainDataClient!.call<KernelProviderDefault | undefined>('getProviderDefault', kernelId)
    ),
    resolveAgentSnapshot: input => agentService!.resolveRunSnapshot(input),
  });
  conversationRouter.on('event', (event) => {
    sendMainWindowEvent(HOST_EVENT_CHANNELS.chat.kernelEvent, event);
  });
  conversationRouter.on('started', (event) => {
    sendMainWindowEvent(HOST_EVENT_CHANNELS.conversations.catalogChanged, {
      conversationId: event.conversationId,
      kernelId: event.kernelId,
      hasActiveRun: true,
      updatedAt: event.updatedAt,
    });
  });
  conversationRouter.on('terminal', (event) => {
    sendMainWindowEvent(HOST_EVENT_CHANNELS.conversations.catalogChanged, {
      conversationId: event.conversationId,
      kernelId: event.kernelId,
      hasActiveRun: false,
      updatedAt: event.updatedAt,
    });
  });
  logger.info('ClawX DataService utility process is ready');

  webBrowserSession = configureWebBrowserSession({
    registry: webBrowserGuestRegistry,
    getMainWindow: () => mainWindow,
  });

  if (!isE2EMode) {
    // Warm up network optimization (non-blocking)
    void warmupNetworkOptimization();

    // Initialize Telemetry early
    await initTelemetry();

    // Apply persisted proxy settings before creating windows or network requests.
    await applyProxySettings();
    await syncLaunchAtStartupSettingFromStore();
  } else {
    logger.info('Running in E2E mode: startup side effects minimized');
  }

  // Set application menu
  await createMenu();

  // Create the main window
  const window = createMainWindow();

  // Optional OpenClaw is registered only after DataService and the window exist.
  // In packaged builds absence is the normal first-launch state.
  await registerManagedOpenClawRuntime(window);
  await registerManagedDeepSeekHarnessRuntime();
  const dshSkillRoot = join(app.getPath('userData'), 'kernel-config', 'deepseek-harness', 'skills');
  await assertIndependentSkillRoots(getOpenClawSkillsDir(), dshSkillRoot);
  skillPackageStore = new CanonicalSkillPackageStore(join(dataRoot, 'skill-packages'));
  skillService = new CanonicalSkillService(mainDataClient, skillPackageStore);
  await ensureCanonicalSkillCatalog({ service: skillService, scanOpenClawSkills: listLocalSkills });
  skillProjectionReconciler = new SkillProjectionReconciler(mainDataClient, skillPackageStore, [
    createOpenClawSkillProjectionAdapter(kernelSupervisorRegistry, skillPackageStore),
    createSupervisorSkillProjectionAdapter(kernelSupervisorRegistry, 'deepseek-harness'),
  ]);
  await skillProjectionReconciler.reconcileAll();
  await skillProjectionReconciler.reconcileDeleted();
  await ensureCanonicalAgentCatalog({
    data: mainDataClient,
    defaultWorkspaceUri: defaultAgentWorkspaceUri('main'),
    openClawAvailable: await kernelSupervisorRegistry.isLaunchAvailable('openclaw'),
    loadOpenClawSnapshot: async () => {
      const snapshot = await listAgentsSnapshot();
      return {
        agents: snapshot.agents.map(agent => ({
          id: agent.id,
          name: agent.name,
          workspace: agent.workspace,
          modelRef: agent.modelRef,
        })),
        defaultAgentId: snapshot.defaultAgentId,
      };
    },
  });
  agentProjectionReconciler = new AgentProjectionReconciler(mainDataClient, [
    createOpenClawAgentProjectionAdapter(kernelSupervisorRegistry),
    createSupervisorAgentProjectionAdapter(kernelSupervisorRegistry, 'deepseek-harness'),
  ]);
  await agentProjectionReconciler.reconcileAll();
  await agentProjectionReconciler.reconcileDeleted();
  const agentDefaults = await mainDataClient.call<KernelAgentDefault[]>('listAgentDefaults');
  await Promise.all(agentDefaults.map(entry => agentProjectionReconciler!.reconcileDefault(entry)));
  await initializeChannelRuntime();
  clawXScheduler = new ClawXScheduler(
    mainDataClient,
    conversationRouter,
    channelOrchestrator,
  );
  providerProjectionReconciler = new ProviderProjectionReconciler(mainDataClient, [
    createOpenClawProviderProjectionAdapter(kernelSupervisorRegistry),
    createSupervisorProviderAdapter(kernelSupervisorRegistry, 'deepseek-harness'),
  ]);
  kernelSupervisorRegistry.on('status', (snapshot: KernelRuntimeSnapshot) => {
    sendMainWindowEvent(HOST_EVENT_CHANNELS.kernels.statusChanged, snapshot);
    if (snapshot.state !== 'ready' || !mainDataClient) return;
    if (providerProjectionReconciler) {
      void providerProjectionReconciler.reconcileAll(snapshot.kernelId).then(async () => {
        const defaults = await mainDataClient!.call<KernelProviderDefault[]>('listProviderDefaults');
        await Promise.all(defaults
          .filter(entry => entry.kernelId === snapshot.kernelId)
          .map(entry => providerProjectionReconciler!.reconcileDefault(entry)));
      }).catch(error => logger.warn(`Provider reconciliation failed for ${snapshot.kernelId}`, error));
    }
    if (agentProjectionReconciler) {
      void agentProjectionReconciler.reconcileAll(snapshot.kernelId).then(async () => {
        await agentProjectionReconciler!.reconcileDeleted(snapshot.kernelId);
        const defaults = await mainDataClient!.call<KernelAgentDefault[]>('listAgentDefaults');
        await Promise.all(defaults
          .filter(entry => entry.kernelId === snapshot.kernelId)
          .map(entry => agentProjectionReconciler!.reconcileDefault(entry)));
      }).catch(error => logger.warn(`Agent reconciliation failed for ${snapshot.kernelId}`, error));
    }
    if (skillProjectionReconciler) {
      void (async () => {
        if (snapshot.kernelId === 'openclaw' && skillService) {
          await ensureCanonicalSkillCatalog({ service: skillService, scanOpenClawSkills: listLocalSkills });
        }
        await skillProjectionReconciler!.reconcileAll(snapshot.kernelId);
        await skillProjectionReconciler!.reconcileDeleted(snapshot.kernelId);
      })().catch(error => logger.warn(`Skill reconciliation failed for ${snapshot.kernelId}`, error));
    }
  });

  // Override security headers ONLY for the OpenClaw Gateway Control UI.
  // The URL filter ensures this callback only fires for gateway requests,
  // avoiding unnecessary overhead on every other HTTP response.
  session.defaultSession.webRequest.onHeadersReceived(
    { urls: ['http://127.0.0.1:18789/*', 'http://localhost:18789/*'] },
    (details, callback) => {
      const headers = { ...details.responseHeaders };
      delete headers['X-Frame-Options'];
      delete headers['x-frame-options'];
      if (headers['Content-Security-Policy']) {
        headers['Content-Security-Policy'] = headers['Content-Security-Policy'].map(
          (csp) => csp.replace(/frame-ancestors\s+'none'/g, "frame-ancestors 'self' *")
        );
      }
      if (headers['content-security-policy']) {
        headers['content-security-policy'] = headers['content-security-policy'].map(
          (csp) => csp.replace(/frame-ancestors\s+'none'/g, "frame-ancestors 'self' *")
        );
      }
      callback({ responseHeaders: headers });
    },
  );

  // Register IPC handlers
  registerIpcHandlers(
    gatewayManager,
    clawHubService,
    window,
    hostApiRegistry,
    webBrowserSession,
    webBrowserGuestRegistry,
    kernelSupervisorRegistry,
    openClawAcp,
    mainDataClient,
    conversationRouter,
    providerProjectionReconciler,
    agentService,
    agentProjectionReconciler,
    skillService,
    skillProjectionReconciler,
    channelAccountService,
    channelBindingService,
    channelOwnerCoordinator,
    channelAdapterRegistry,
    clawXScheduler,
    kernelPackageController,
  );

  loadMainWindow(window);

  // Create system tray
  if (!isE2EMode) {
    createTray(window);
  }

  // Initialize extension system
  await extensionRegistry.initialize({
    kernels: new OpenClawLegacyExtensionAdapter({
      gateway: gatewayManager,
      list: async () => kernelSupervisorRegistry.snapshots(),
      getDriver: (kernelId) => activeKernelDrivers.get(kernelId),
      diagnostics: (kernelId) => ({
        ...kernelSupervisorRegistry.diagnostics(kernelId),
        logDirectory: kernelSupervisorRegistry.logDirectory(kernelId),
      }),
      getInstallation: async (kernelId) => mainDataClient?.call('getKernelInstallation', kernelId),
      getRuntimeVersion: async (kernelId, artifactVersion) => (
        mainDataClient?.call('getKernelRuntimeVersion', kernelId, artifactVersion)
      ),
    }).createKernelApi(),
    getMainWindow: () => mainWindow,
    hostApi: {
      register: (extensionId, contributions) => (
        hostApiRegistry.registerExtensionContributions(extensionId, contributions)
      ),
    },
  });

  // Wire marketplace provider to ClawHubService if an extension provides one
  const marketplaceProvider = extensionRegistry.getMarketplaceProvider();
  if (marketplaceProvider) {
    clawHubService.setMarketplaceProvider(marketplaceProvider);
  }

  // Register update handlers
  registerUpdateHandlers(appUpdater, window);

  // Note: Auto-check for updates is driven by the renderer (update store init)
  // so it respects the user's "Auto-check for updates" setting.

  // Plugin installation is now configuration-driven:
  // - When a channel is added via UI: ensureXxxPluginInstalled() in IPC handlers
  // - When Gateway starts: ensureConfiguredPluginsUpgraded() in config-sync.ts
  // No need to pre-install all bundled plugins at app startup.

  // Bridge gateway and host-side events before any auto-start logic runs, so
  // renderer subscribers observe the full startup lifecycle.
  gatewayManager.on('status', (status: { state: string }) => {
    sendMainWindowEvent('gateway:status-changed', status);
    if (status.state === 'running' && !isE2EMode) {
      void ensureClawXContext().catch((error) => {
        logger.warn('Failed to re-merge ClawX context after gateway reconnect:', error);
      });
    }
  });

  gatewayManager.on('error', (error) => {
    sendMainWindowEvent('gateway:error', { message: error.message });
  });

  gatewayManager.on('notification', (notification) => {
    sendMainWindowEvent('gateway:notification', notification);
  });

  gatewayManager.on('gateway:health', (data) => {
    sendMainWindowEvent('gateway:health-changed', data);
  });

  gatewayManager.on('gateway:presence', (data) => {
    sendMainWindowEvent('gateway:presence-changed', data);
  });

  gatewayManager.on('chat:message', (data) => {
    sendMainWindowEvent('gateway:chat-message', data);
  });

  gatewayManager.on('chat:runtime-event', (data) => {
    sendMainWindowEvent('chat:runtime-event', data);
  });

  gatewayManager.on('channel:status', (data) => {
    sendMainWindowEvent('gateway:channel-status', data);
    sendMainWindowEvent('channels:status-changed', data);
  });

  gatewayManager.on('exit', (code) => {
    sendMainWindowEvent('gateway:exit', { code });
  });

  deviceOAuthManager.on('oauth:code', (payload) => {
    sendMainWindowEvent('oauth:code', payload);
  });

  deviceOAuthManager.on('oauth:success', (payload) => {
    sendMainWindowEvent('oauth:success', { ...payload, success: true });
  });

  deviceOAuthManager.on('oauth:error', (error) => {
    sendMainWindowEvent('oauth:error', error);
  });

  browserOAuthManager.on('oauth:code', (payload) => {
    sendMainWindowEvent('oauth:code', payload);
  });

  browserOAuthManager.on('oauth:success', (payload) => {
    sendMainWindowEvent('oauth:success', { ...payload, success: true });
  });

  browserOAuthManager.on('oauth:error', (error) => {
    sendMainWindowEvent('oauth:error', error);
  });

  whatsAppLoginManager.on('qr', (data) => {
    sendMainWindowEvent('channel:whatsapp-qr', data);
  });

  whatsAppLoginManager.on('success', (data) => {
    sendMainWindowEvent('channel:whatsapp-success', data);
  });

  whatsAppLoginManager.on('error', (error) => {
    sendMainWindowEvent('channel:whatsapp-error', error);
  });

  // Start each installed runtime according to its independent policy. The
  // legacy Gateway participates through the same coordinator until M6 wraps it
  // as OpenClawKernelDriver.
  if (!isE2EMode) {
    const policies = await getKernelAutoStartPolicies();
    const failures = await runtimeLifecycleCoordinator.autoStart(policies);
    for (const failure of failures) {
      logger.error(`Runtime auto-start failed (${failure.id}): ${failure.error}`);
      mainWindow?.webContents.send('gateway:error', failure.error);
    }
    const channelResults = await channelOwnerCoordinator?.reconcile() ?? [];
    for (const result of channelResults) {
      if (!result.ok) logger.warn(`Channel owner activation failed (${result.accountId}/${result.kernelId}): ${result.error}`);
    }
    await channelOrchestrator?.retryPending();
  } else if (isE2EMode) {
    logger.info('Kernel auto-start skipped in E2E mode');
  }
  await clawXScheduler.start();

}

if (gotTheLock) {
  const requestQuitOnSignal = createSignalQuitHandler({
    logInfo: (message) => logger.info(message),
    requestQuit: () => app.quit(),
  });

  process.on('exit', () => {
    releaseProcessInstanceFileLock();
  });

  process.once('SIGINT', () => requestQuitOnSignal('SIGINT'));
  process.once('SIGTERM', () => requestQuitOnSignal('SIGTERM'));

  app.on('will-quit', () => {
    releaseProcessInstanceFileLock();
  });

  if (process.platform === 'win32') {
    app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID);
  }

  gatewayManager = new GatewayManager();
  registerOpenClawConfigCoordinator(gatewayManager);
  clawHubService = new ClawHubService();
  runtimeLifecycleCoordinator.register({
    id: 'managed-kernel-supervisors',
    autoStart: async (policies) => kernelSupervisorRegistry.autoStartAll(policies),
    stop: async (deadlineMs) => kernelSupervisorRegistry.stopAllForQuit(deadlineMs),
    forceTerminate: async () => kernelSupervisorRegistry.forceTerminateAll(),
  });

  // Register builtin extensions and load manifest
  registerAllBuiltinExtensions();
  loadExternalMainExtensions();
  void loadExtensionsFromManifest().catch((err) => {
    logger.warn('Failed to load extensions from manifest:', err);
  });

  // When a second instance is launched, focus the existing window instead.
  app.on('second-instance', () => {
    logger.info('Second ClawX instance detected; redirecting to the existing window');

    const focusRequest = requestSecondInstanceFocus(
      mainWindowFocusState,
      Boolean(mainWindow && !mainWindow.isDestroyed()),
    );

    if (focusRequest === 'focus-now') {
      focusMainWindow();
      return;
    }

    logger.debug('Main window is not ready yet; deferring second-instance focus until ready-to-show');
  });

  // Application lifecycle
  app.whenReady().then(async () => {
    try {
      await initialize();
    } catch (error) {
      logger.error('Application initialization failed:', error);
      return;
    }

    // Register only after initialization so activation cannot race the initial
    // window or claim the single browser guest before host handlers are ready.
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        loadMainWindow(createMainWindow());
      } else {
        focusMainWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' || isE2EMode) {
      app.quit();
    }
  });

  app.on('before-quit', (event) => {
    setQuitting();
    const action = requestQuitLifecycleAction(quitLifecycleState);

    if (action === 'allow-quit') {
      return;
    }

    event.preventDefault();

    if (action === 'cleanup-in-progress') {
      logger.debug('Quit requested while cleanup already in progress; waiting for shutdown task to finish');
      return;
    }

    void extensionRegistry.teardownAll();

    const stopPromise = (async () => {
      await clawXScheduler?.stop().catch((err) => {
        logger.warn('ClawXScheduler shutdown error during quit:', err);
      });
      await stopChannelRuntime();
      await runtimeLifecycleCoordinator.stopAllForQuit(4500).catch((err) => {
        logger.warn('Runtime lifecycle shutdown error during quit:', err);
      });
      await conversationRouter?.close().catch((err) => {
        logger.warn('ConversationRouter shutdown error during quit:', err);
      });
      await dataServiceHost?.close().catch((err) => {
        logger.warn('DataService shutdown error during quit:', err);
      });
    })();
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), 5000);
    });

    void Promise.race([stopPromise.then(() => 'stopped' as const), timeoutPromise]).then((result) => {
      if (result === 'timeout') {
        logger.warn('Runtime shutdown timed out during app quit; proceeding with forced quit');
        void runtimeLifecycleCoordinator.forceTerminateAll().catch((err) => {
          logger.warn('Forced runtime termination failed after quit timeout:', err);
        });
      }
      markQuitCleanupCompleted(quitLifecycleState);
      app.quit();
    });
  });

  // Best-effort Gateway cleanup on unexpected crashes.
  // These handlers attempt to terminate the Gateway child process within a
  // short timeout before force-exiting, preventing orphaned processes.
  const emergencyRuntimeCleanup = (reason: string, error: unknown): void => {
    logger.error(`${reason}:`, error);
    try {
      channelOrchestrator?.stop();
      void clawXScheduler?.stop().catch(() => undefined);
      void channelOwnerCoordinator?.stop().catch(() => undefined);
      void channelHandoffServer?.stop().catch(() => undefined);
      void runtimeLifecycleCoordinator.forceTerminateAll().catch(() => { /* ignore */ });
      void dataServiceHost?.close().catch(() => { /* ignore */ });
    } catch {
      // ignore — cleanup may not be callable if state is corrupted
    }
    // Give Gateway stop a brief window, then force-exit.
    setTimeout(() => {
      process.exit(1);
    }, 3000).unref();
  };

  process.on('uncaughtException', (error) => {
    emergencyRuntimeCleanup('Uncaught exception in main process', error);
  });

  process.on('unhandledRejection', (reason) => {
    emergencyRuntimeCleanup('Unhandled promise rejection in main process', reason);
  });
}

// Export for testing
export {
  mainWindow,
  gatewayManager,
  dataServiceHost,
  mainDataClient,
  conversationRouter,
  clawXScheduler,
  kernelLaunchRegistry,
  kernelSupervisorRegistry,
  kernelPackageController,
  runtimeLifecycleCoordinator,
  providerProjectionReconciler,
  agentService,
  agentProjectionReconciler,
};
