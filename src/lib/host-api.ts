import type {
  AgentCreatePayload,
  AgentUpdatePayload,
  AcpTraceRecordPayload,
  AttachmentFileRef,
  AttachmentSourceRef,
  ChannelAccountsPayload,
  ChannelSaveConfigPayload,
  ChannelTargetsPayload,
  ClawHubSearchPayload,
  CronSessionHistoryPayload,
  DialogMessagePayload,
  DialogOpenPayload,
  EmbeddingSettingsPayload,
  FilePreviewTreeOptions,
  FileReadBinaryOptions,
  ImageGenerationSettingsPayload,
  MediaThumbnailEntry,
  OpenClawDoctorMode,
  OpenClawDoctorResult,
  OpenClawDreamsAction,
  OpenAttachmentWithPayload,
  OpenWorkspaceWithPayload,
  ProviderAccount,
  ProviderConfig,
  ProviderOAuthRequestPayload,
  ProviderKernelDefaultPayload,
  ProviderReconcilePayload,
  ProviderUpdateWithKeyPayload,
  ProviderValidationPayload,
  ReadAttachmentBinaryPayload,
  ResolveAttachmentPayload,
  SaveImagePayload,
  SettingsKey,
  SettingsSnapshot,
  SettingsValue,
  ShellOpenExternalPayload,
  ShellPathPayload,
  SkillQuickAccessPayload,
  SkillUpdateConfigPayload,
  SkillUpdatePayload,
  UpdateChannel,
  WorkspaceContextInput,
  WorkspaceFileRef,
} from '@shared/host-api/contract';
import type { WebBrowserNavigatePayload } from '@shared/web-browser';
import type {
  AcpChatCancelPayload,
  AcpChatLoadPayload,
  AcpChatPromptPayload,
  AcpChatRespondPermissionPayload,
  AcpChatSetConfigOptionPayload,
} from '@shared/acp-chat/types';
import type { CronJobCreateInput, CronJobUpdateInput } from '@shared/types/cron';
import type {
  KernelId,
  KernelRunConfiguration,
  KernelRunIdentity,
  KernelRunRequest,
} from '@shared/kernels/contracts';
import type { KernelDirectoryKind } from '@shared/host-api/kernels';
import type { ConversationId, ConversationQueryFilters, TurnId } from '@shared/conversations/contracts';
export type {
  KernelCrashRecord,
  KernelLogEntry,
  KernelRuntimeDiagnostics,
} from '@shared/host-api/kernels';
import { invokeHost } from './host-api-client';

export type {
  AttachmentAccessError,
  AttachmentFileRef,
  AttachmentOpenHandler,
  AttachmentOpenHandlersResult,
  AttachmentRemoteRef,
  AttachmentReadError,
  AttachmentSourceRef,
  ChannelAccountsResult,
  ChannelCredentialValidationResult,
  ChannelFormValuesResult,
  ChannelGroupItem,
  ChannelSaveConfigResult,
  ChannelTargetOption,
  ChannelTargetsResult,
  ClawHubInstalledSkill,
  ClawHubListResult,
  ClawHubSearchResult,
  CronSessionHistoryResult,
  DeliveryChannelAccount,
  DeliveryChannelGroup,
  DeliveryTargetsResult,
  DiagnosticsGatewaySnapshotGateway,
  DiagnosticsGatewaySnapshotResult,
  DiagnosticsSnapshotResult,
  GatewayHealthSummary,
  GatewayRecoverySnapshot,
  GatewayRecoveryState,
  ImageGenerationProvidersResult,
  ImageGenerationSettingsResult,
  EmbeddingSettingsResult,
  LocalSkillsResult,
  LogContentResult,
  LogDirResult,
  OpenClawCliCommandResult,
  OpenClawDoctorResult,
  OpenClawStatusResult,
  OpenAttachmentResult,
  ProviderAccountKeyInfo,
  ProviderDefaultAccountResult,
  ProviderKernelDefault,
  ProviderKernelProjection,
  ProviderValidationResult,
  ReadAttachmentBinaryResult,
  ReadAttachmentTextResult,
  ResolveAttachmentResult,
  ConversationGetResult,
  ConversationListResult,
  ConversationSearchResult,
  SettingsResetResult,
  SettingsSnapshot,
  SkillConfigsResult,
  SkillsStatusResult,
  StagedFileResult,
  UsageHistoryEntry,
  WorkspaceContextInput,
  WorkspaceFileRef,
  WorkspaceNativeFileError,
  WorkspaceNativeFileResult,
  WorkspaceOpenHandlersResult,
} from '@shared/host-api/contract';

export const hostApi = {
  app: {
    relaunch: () => invokeHost('app', 'relaunch'),
    openClawDoctor: async (mode: OpenClawDoctorMode): Promise<OpenClawDoctorResult> => ({
      ...(await invokeHost('app', 'openClawDoctor', { mode })),
      mode,
    }),
  },
  openclaw: {
    status: () => invokeHost('openclaw', 'status'),
    getSkillsDir: () => invokeHost('openclaw', 'getSkillsDir'),
    getCliCommand: () => invokeHost('openclaw', 'getCliCommand'),
  },
  kernels: {
    catalog: (refresh = false) => invokeHost('kernels', 'catalog', { refresh }),
    install: (kernelId: KernelId) => invokeHost('kernels', 'install', { kernelId }),
    update: (kernelId: KernelId) => invokeHost('kernels', 'update', { kernelId }),
    repair: (kernelId: KernelId) => invokeHost('kernels', 'repair', { kernelId }),
    rollback: (kernelId: KernelId) => invokeHost('kernels', 'rollback', { kernelId }),
    uninstall: (kernelId: KernelId) => invokeHost('kernels', 'uninstall', { kernelId }),
    versions: (kernelId: KernelId) => invokeHost('kernels', 'versions', { kernelId }),
    openDirectory: (kernelId: KernelId, kind: KernelDirectoryKind) => (
      invokeHost('kernels', 'openDirectory', { kernelId, kind })
    ),
    list: () => invokeHost('kernels', 'list'),
    status: (kernelId: KernelId) => invokeHost('kernels', 'status', { kernelId }),
    start: (kernelId: KernelId) => invokeHost('kernels', 'start', { kernelId }),
    stop: (kernelId: KernelId) => invokeHost('kernels', 'stop', { kernelId }),
    restart: (kernelId: KernelId) => invokeHost('kernels', 'restart', { kernelId }),
    health: (kernelId: KernelId) => invokeHost('kernels', 'health', { kernelId }),
    logs: (kernelId: KernelId, options?: { afterSequence?: number; limit?: number }) => (
      invokeHost('kernels', 'logs', { kernelId, ...options })
    ),
    logDirectory: (kernelId: KernelId) => invokeHost('kernels', 'logDirectory', { kernelId }),
    exportLogs: (kernelId: KernelId) => invokeHost('kernels', 'exportLogs', { kernelId }),
    setAutoStart: (kernelId: KernelId, enabled: boolean) => (
      invokeHost('kernels', 'setAutoStart', { kernelId, enabled })
    ),
    execute: (input: KernelRunRequest) => invokeHost('kernels', 'execute', input),
    cancel: (input: KernelRunIdentity) => invokeHost('kernels', 'cancel', input),
    updateConfiguration: (input: KernelRunConfiguration) => (
      invokeHost('kernels', 'updateConfiguration', input)
    ),
    resolvePermission: (
      input: KernelRunIdentity & { requestId: string; decision: 'allow-once' | 'reject-once' },
    ) => invokeHost('kernels', 'resolvePermission', input),
    diagnostics: (kernelId: KernelId) => invokeHost('kernels', 'diagnostics', { kernelId }),
  },
  shell: {
    openExternal: (url: string) => invokeHost('shell', 'openExternal', { url } satisfies ShellOpenExternalPayload),
    showItemInFolder: (path: string) => invokeHost('shell', 'showItemInFolder', { path } satisfies ShellPathPayload),
    openPath: (path: string) => invokeHost('shell', 'openPath', { path } satisfies ShellPathPayload),
  },
  webBrowser: {
    navigate: (url: string) => invokeHost('webBrowser', 'navigate', { url } satisfies WebBrowserNavigatePayload),
    openExternal: (url: string) => (
      invokeHost('webBrowser', 'openExternal', { url } satisfies WebBrowserNavigatePayload)
    ),
  },
  dialog: {
    open: (input: DialogOpenPayload) => invokeHost('dialog', 'open', input),
    message: (input: DialogMessagePayload) => invokeHost('dialog', 'message', input),
  },
  window: {
    syncTrafficLightPosition: (sidebarCollapsed: boolean) => (
      invokeHost('window', 'syncTrafficLightPosition', { sidebarCollapsed })
    ),
    minimize: () => invokeHost('window', 'minimize'),
    maximize: () => invokeHost('window', 'maximize'),
    close: () => invokeHost('window', 'close'),
    isMaximized: () => invokeHost('window', 'isMaximized'),
  },
  updates: {
    status: () => invokeHost('updates', 'status'),
    version: () => invokeHost('updates', 'version'),
    check: () => invokeHost('updates', 'check'),
    download: () => invokeHost('updates', 'download'),
    install: () => invokeHost('updates', 'install'),
    setChannel: (channel: UpdateChannel) => invokeHost('updates', 'setChannel', { channel }),
    setAutoDownload: (enable: boolean) => invokeHost('updates', 'setAutoDownload', { enable }),
    cancelAutoInstall: () => invokeHost('updates', 'cancelAutoInstall'),
  },
  uv: {
    installAll: () => invokeHost('uv', 'installAll'),
  },
  settings: {
    getAll: () => invokeHost('settings', 'getAll'),
    get: (key: SettingsKey) => invokeHost('settings', 'get', { key }),
    set: (key: SettingsKey, value: SettingsValue) => invokeHost('settings', 'set', { key, value }),
    setMany: (patch: Partial<SettingsSnapshot>) => (
      invokeHost('settings', 'setMany', { patch })
    ),
    reset: () => invokeHost('settings', 'reset'),
  },
  openClawDreams: {
    status: () => invokeHost('openClawDreams', 'status'),
    diary: () => invokeHost('openClawDreams', 'diary'),
    run: (action: OpenClawDreamsAction) => invokeHost('openClawDreams', 'run', { action }),
    setEnabled: (enabled: boolean) => invokeHost('openClawDreams', 'setEnabled', { enabled }),
    openFullUi: () => invokeHost('openClawDreams', 'openFullUi'),
  },
  logs: {
    recent: (tailLines = 100) => invokeHost('logs', 'recent', { tailLines }),
    dir: () => invokeHost('logs', 'dir'),
    listFiles: () => invokeHost('logs', 'listFiles'),
    readFile: (path: string, tailLines?: number) => (
      invokeHost('logs', 'readFile', { path, tailLines })
    ),
  },
  channels: {
    accounts: (options?: ChannelAccountsPayload) => (
      invokeHost('channels', 'accounts', options)
    ),
    targets: (input: ChannelTargetsPayload) => (
      invokeHost('channels', 'targets', input)
    ),
    configured: () => invokeHost('channels', 'configured'),
    formValues: (channelType: string, accountId?: string) => (
      invokeHost('channels', 'formValues', { channelType, accountId })
    ),
    saveConfig: (input: ChannelSaveConfigPayload) => invokeHost('channels', 'saveConfig', input),
    deleteConfig: (channelType: string, accountId?: string) => (
      invokeHost('channels', 'deleteConfig', { channelType, accountId })
    ),
    validateCredentials: (
      channelType: string,
      config: Record<string, unknown>,
      input?: { accountId?: string; kernelId?: KernelId },
    ) => (
      invokeHost('channels', 'validateCredentials', { channelType, config, ...input })
    ),
    saveBinding: (input: {
      channelType: string;
      accountId: string;
      kernelId: KernelId;
      agentId: string;
      targetId?: string;
      conversationPolicy?: 'reuse' | 'per-thread' | 'per-message';
    }) => (
      invokeHost('channels', 'bindingSave', input)
    ),
    deleteBinding: (input: { channelType: string; accountId?: string }) => (
      invokeHost('channels', 'bindingDelete', input)
    ),
    startLogin: (channelType: string, input?: { accountId?: string; kernelId?: KernelId }) => (
      invokeHost('channels', 'startLogin', { channelType, ...input })
    ),
    cancelLogin: (channelType: string, input?: { accountId?: string; kernelId?: KernelId }) => (
      invokeHost('channels', 'cancelLogin', { channelType, ...input })
    ),
  },
  agents: {
    list: () => invokeHost('agents', 'list'),
    create: (input: AgentCreatePayload) => invokeHost('agents', 'create', input),
    update: (id: string, input: Omit<AgentUpdatePayload, 'id'>) => (
      invokeHost('agents', 'update', {
        id,
        ...input,
      })
    ),
    updateModel: (id: string, modelRef: string | null) => (
      invokeHost('agents', 'updateModel', { id, modelRef })
    ),
    delete: (id: string) => invokeHost('agents', 'delete', { id, preserveHistory: true }),
    setDefault: (id: string, kernelId: string) => (
      invokeHost('agents', 'setDefault', { id, kernelId })
    ),
    reconcile: (id: string, kernelIds?: string[]) => (
      invokeHost('agents', 'reconcile', { id, kernelIds })
    ),
    assignChannel: (id: string, channelType: string) => (
      invokeHost('agents', 'assignChannel', { id, channelType })
    ),
    removeChannel: (id: string, channelType: string) => (
      invokeHost('agents', 'removeChannel', { id, channelType })
    ),
  },
  diagnostics: {
    snapshot: () => invokeHost('diagnostics', 'snapshot'),
    gatewaySnapshot: () => invokeHost('diagnostics', 'gatewaySnapshot'),
    acpTrace: () => invokeHost('diagnostics', 'acpTrace'),
    recordAcpTrace: (input: AcpTraceRecordPayload) => invokeHost('diagnostics', 'recordAcpTrace', input),
  },
  providers: {
    list: () => invokeHost('providers', 'list'),
    get: (providerId: string) => invokeHost('providers', 'get', { providerId }),
    getDefault: () => invokeHost('providers', 'getDefault'),
    hasApiKey: (providerId: string) => (
      invokeHost('providers', 'hasApiKey', { providerId })
    ),
    validateKey: (input: ProviderValidationPayload) => invokeHost('providers', 'validateKey', input),
    save: (input: { config: ProviderConfig; credentialHandle?: string }) => invokeHost('providers', 'save', input),
    delete: (providerId: string) => invokeHost('providers', 'delete', { providerId }),
    setApiKey: (providerId: string, credentialHandle: string) => (
      invokeHost('providers', 'setApiKey', { providerId, credentialHandle })
    ),
    updateWithKey: (input: ProviderUpdateWithKeyPayload) => invokeHost('providers', 'updateWithKey', input),
    deleteApiKey: (providerId: string) => (
      invokeHost('providers', 'deleteApiKey', { providerId })
    ),
    setDefault: (providerId: string) => (
      invokeHost('providers', 'setDefault', { providerId })
    ),
    accounts: () => invokeHost('providers', 'accounts'),
    vendors: () => invokeHost('providers', 'vendors'),
    accountKeyInfo: () => invokeHost('providers', 'accountKeyInfo'),
    getDefaultAccount: () => invokeHost('providers', 'getDefaultAccount'),
    getAccount: (accountId: string) => (
      invokeHost('providers', 'getAccount', { accountId })
    ),
    hasAccountApiKey: (accountId: string) => (
      invokeHost('providers', 'hasAccountApiKey', { accountId })
    ),
    createAccount: (input: { account: ProviderAccount; credentialHandle?: string }) => (
      invokeHost('providers', 'createAccount', input)
    ),
    updateAccount: (accountId: string, updates: Partial<ProviderAccount>, credentialHandle?: string) => (
      invokeHost('providers', 'updateAccount', { accountId, updates, credentialHandle })
    ),
    deleteAccount: (accountId: string) => (
      invokeHost('providers', 'deleteAccount', { accountId })
    ),
    deleteAccountApiKey: (accountId: string) => (
      invokeHost('providers', 'deleteAccountApiKey', { accountId })
    ),
    setDefaultAccount: (accountId: string) => (
      invokeHost('providers', 'setDefaultAccount', { accountId })
    ),
    kernelDefaults: () => invokeHost('providers', 'kernelDefaults'),
    setKernelDefault: (input: ProviderKernelDefaultPayload) => (
      invokeHost('providers', 'setKernelDefault', input)
    ),
    reconcileAccount: (input: ProviderReconcilePayload) => (
      invokeHost('providers', 'reconcileAccount', input)
    ),
    requestOAuth: (input: ProviderOAuthRequestPayload) => invokeHost('providers', 'requestOAuth', input),
    cancelOAuth: () => invokeHost('providers', 'cancelOAuth'),
    submitOAuth: (input: { code: string }) => invokeHost('providers', 'submitOAuth', input),
  },
  files: {
    stagePaths: (input: { filePaths: string[] }) => invokeHost('files', 'stagePaths', input),
    stageBuffer: (input: { base64: string; fileName: string; mimeType?: string }) => (
      invokeHost('files', 'stageBuffer', input)
    ),
    readText: (path: string) => invokeHost('files', 'readText', { path }),
    readBinary: (path: string, opts?: FileReadBinaryOptions) => (
      invokeHost('files', 'readBinary', { path, opts })
    ),
    writeText: (path: string, content: string) => (
      invokeHost('files', 'writeText', { path, content })
    ),
    stat: (path: string) => invokeHost('files', 'stat', { path }),
    listDir: (path: string) => invokeHost('files', 'listDir', { path }),
    listTree: (path: string, opts?: FilePreviewTreeOptions) => (
      invokeHost('files', 'listTree', { path, opts })
    ),
    resolveWorkspaceContext: (input: WorkspaceContextInput) => (
      invokeHost('files', 'resolveWorkspaceContext', input)
    ),
    readWorkspaceText: (ref: WorkspaceFileRef) => invokeHost('files', 'readWorkspaceText', ref),
    readWorkspaceBinary: (input: WorkspaceFileRef & { maxBytes?: number }) => (
      invokeHost('files', 'readWorkspaceBinary', input)
    ),
    statWorkspaceFile: (ref: WorkspaceFileRef) => invokeHost('files', 'statWorkspaceFile', ref),
    listWorkspaceOpenHandlers: (ref: WorkspaceFileRef) => (
      invokeHost('files', 'listWorkspaceOpenHandlers', ref)
    ),
    openWorkspaceWith: (input: OpenWorkspaceWithPayload) => (
      invokeHost('files', 'openWorkspaceWith', input)
    ),
    revealWorkspaceFile: (ref: WorkspaceFileRef) => invokeHost('files', 'revealWorkspaceFile', ref),
    resolveAttachment: (input: ResolveAttachmentPayload) => invokeHost('files', 'resolveAttachment', input),
    readAttachmentText: (ref: AttachmentFileRef) => invokeHost('files', 'readAttachmentText', ref),
    readAttachmentBinary: (input: ReadAttachmentBinaryPayload) => (
      invokeHost('files', 'readAttachmentBinary', input)
    ),
    openAttachment: (ref: AttachmentSourceRef) => invokeHost('files', 'openAttachment', ref),
    listAttachmentOpenHandlers: (ref: AttachmentFileRef) => (
      invokeHost('files', 'listAttachmentOpenHandlers', ref)
    ),
    openAttachmentWith: (input: OpenAttachmentWithPayload) => (
      invokeHost('files', 'openAttachmentWith', input)
    ),
    revealAttachment: (ref: AttachmentFileRef) => invokeHost('files', 'revealAttachment', ref),
  },
  media: {
    thumbnails: (input: { paths: MediaThumbnailEntry[] }) => invokeHost('media', 'thumbnails', input),
    saveImage: (input: SaveImagePayload) => invokeHost('media', 'saveImage', input),
    imageGenerationSettings: () => invokeHost('media', 'imageGenerationSettings'),
    saveImageGenerationSettings: (input: ImageGenerationSettingsPayload) => (
      invokeHost('media', 'saveImageGenerationSettings', input)
    ),
    imageGenerationProviders: () => invokeHost('media', 'imageGenerationProviders'),
    testImageGeneration: (input: { agentId?: string; prompt?: string; model?: string }) => (
      invokeHost('media', 'testImageGeneration', input)
    ),
  },
  embeddings: {
    settings: () => invokeHost('embeddings', 'settings'),
    saveSettings: (input: EmbeddingSettingsPayload) => invokeHost('embeddings', 'saveSettings', input),
    clearSettings: () => invokeHost('embeddings', 'clearSettings'),
  },
  conversations: {
    list: (input?: ConversationQueryFilters & { limit?: number; cursor?: string }) => (
      invokeHost('conversations', 'list', input)
    ),
    search: (
      query: string,
      input?: number | (ConversationQueryFilters & { limit?: number }),
    ) => invokeHost('conversations', 'search', {
      query,
      ...(typeof input === 'number' ? { limit: input } : input),
    }),
    get: (id: ConversationId) => invokeHost('conversations', 'get', { id }),
    rename: (id: ConversationId, title: string) => (
      invokeHost('conversations', 'rename', { id, title })
    ),
    pin: (id: ConversationId, pinned: boolean) => (
      invokeHost('conversations', 'pin', { id, pinned })
    ),
    delete: (id: ConversationId, hard = false) => (
      invokeHost('conversations', 'delete', { id, hard })
    ),
    branch: (
      sourceConversationId: ConversationId,
      sourceTurnId: TurnId,
      input?: { branchConversationId?: ConversationId; title?: string },
    ) => invokeHost('conversations', 'branch', {
      sourceConversationId,
      sourceTurnId,
      ...input,
    }),
    export: (id: ConversationId) => invokeHost('conversations', 'export', { id }),
  },
  chat: {
    selectConversationKernel: (input: AcpChatLoadPayload) => (
      invokeHost('chat', 'selectConversationKernel', input)
    ),
    sendAcpPrompt: (input: AcpChatPromptPayload) => invokeHost('chat', 'sendAcpPrompt', input),
    cancelAcpSession: (input: AcpChatCancelPayload) => invokeHost('chat', 'cancelAcpSession', input),
    setAcpSessionConfigOption: (input: AcpChatSetConfigOptionPayload) => (
      invokeHost('chat', 'setAcpSessionConfigOption', input)
    ),
    respondAcpPermission: (input: AcpChatRespondPermissionPayload) => (
      invokeHost('chat', 'respondAcpPermission', input)
    ),
  },
  cron: {
    list: () => invokeHost('cron', 'list'),
    create: (input: CronJobCreateInput) => invokeHost('cron', 'create', input),
    update: (id: string, input: CronJobUpdateInput) => invokeHost('cron', 'update', { id, input }),
    delete: (id: string) => invokeHost('cron', 'delete', { id }),
    toggle: (id: string, enabled: boolean) => invokeHost('cron', 'toggle', { id, enabled }),
    trigger: (id: string) => invokeHost('cron', 'trigger', { id }),
    cancel: (id: string) => invokeHost('cron', 'cancel', { id }),
    sessionHistory: (input: CronSessionHistoryPayload) => invokeHost('cron', 'sessionHistory', input),
    deliveryTargets: () => invokeHost('cron', 'deliveryTargets'),
  },
  skills: {
    catalog: () => invokeHost('skills', 'catalog'),
    mutate: (input: import('@shared/host-api/contract').CanonicalSkillMutationPayload) => (
      invokeHost('skills', 'mutate', input)
    ),
    retry: (input: import('@shared/host-api/contract').CanonicalSkillRetryPayload) => (
      invokeHost('skills', 'retry', input)
    ),
    local: () => invokeHost('skills', 'local'),
    configs: () => invokeHost('skills', 'configs'),
    allConfigs: () => invokeHost('skills', 'allConfigs'),
    getConfig: (skillKey: string) => invokeHost('skills', 'getConfig', { skillKey }),
    updateConfig: (input: SkillUpdateConfigPayload) => invokeHost('skills', 'updateConfig', input),
    updateConfigs: (updates: SkillUpdateConfigPayload[]) => invokeHost('skills', 'updateConfigs', { updates }),
    status: () => invokeHost('skills', 'status'),
    update: (input: SkillUpdatePayload) => invokeHost('skills', 'update', input),
    quickAccess: (input: SkillQuickAccessPayload) => invokeHost('skills', 'quickAccess', input),
    clawhubCapability: () => invokeHost('skills', 'clawhubCapability'),
    clawhubList: () => invokeHost('skills', 'clawhubList'),
    clawhubSearch: (input: ClawHubSearchPayload) => invokeHost('skills', 'clawhubSearch', input),
    clawhubInstall: (input: import('@shared/host-api/contract').ClawHubInstallPayload) => (
      invokeHost('skills', 'clawhubInstall', input)
    ),
    clawhubUninstall: (input: import('@shared/host-api/contract').ClawHubUninstallPayload) => (
      invokeHost('skills', 'clawhubUninstall', input)
    ),
    clawhubOpenSkillReadme: (input: { skillKey?: string; slug?: string; baseDir?: string }) => (
      invokeHost('skills', 'clawhubOpenSkillReadme', input)
    ),
    clawhubOpenSkillPath: (input: { skillKey?: string; slug?: string; baseDir?: string }) => (
      invokeHost('skills', 'clawhubOpenSkillPath', input)
    ),
  },
  usage: {
    recentTokenHistory: (limit?: number) => (
      invokeHost('usage', 'recentTokenHistory', { limit })
    ),
    query: (input: import('@shared/host-api/contract').UsageHistoryPayload & { from: string; to: string }) => (
      invokeHost('usage', 'query', input)
    ),
  },
};

export type HostApi = typeof hostApi;
