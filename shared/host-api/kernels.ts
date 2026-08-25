import type {
  KernelId,
  KernelRunConfiguration,
  KernelRunIdentity,
  KernelRunRequest,
  KernelRuntimeSnapshot,
} from '../kernels/contracts';
import type {
  KernelCompatibilityFailure,
  KernelDownloadProgress,
  KernelInstallationRecord,
  KernelRuntimeVersionRecord,
  KernelUninstallResult,
} from '../kernels/package-manager';

export type KernelLogLevel = 'debug' | 'info' | 'warn' | 'error';

export type KernelLogEntry = {
  sequence: number;
  kernelId: KernelId;
  generation: number;
  timestamp: string;
  level: KernelLogLevel;
  stream: 'lifecycle' | 'stderr' | 'protocol';
  message: string;
};

export type KernelCrashRecord = {
  kernelId: KernelId;
  generation: number;
  timestamp: string;
  artifactVersion?: string;
  message: string;
};

export type KernelRuntimeDiagnostics = {
  snapshot: KernelRuntimeSnapshot;
  crashes: KernelCrashRecord[];
  logs: KernelLogEntry[];
  logDirectory?: string;
};

export type KernelLogExport = {
  kernelId: KernelId;
  fileName: string;
  content: string;
  entryCount: number;
};

export type KernelCatalogEntry = {
  kernelId: KernelId;
  displayName: string;
  description?: string;
  installation: KernelInstallationRecord;
  runtime: KernelRuntimeSnapshot;
  availableVersion?: string;
  updateAvailable: boolean;
  installAllowed: boolean;
  compatibilityFailures: KernelCompatibilityFailure[];
};

export type KernelCatalogSnapshot = {
  entries: KernelCatalogEntry[];
  source: 'network' | 'cache' | 'builtin';
  stale: boolean;
  warning?: string;
  refreshedAt: string;
};

export type KernelPackageMutationResult = {
  installation: KernelInstallationRecord;
  runtime: KernelRuntimeSnapshot;
  restartRequired?: boolean;
};

export type KernelUninstallMutationResult = KernelUninstallResult & {
  installation: KernelInstallationRecord;
  runtime: KernelRuntimeSnapshot;
};

export type KernelRuntimeVersionList = {
  versions: KernelRuntimeVersionRecord[];
};

export type KernelDirectoryKind = 'data' | 'logs';

export type KernelHostApi = {
  catalog(input?: { refresh?: boolean }): Promise<KernelCatalogSnapshot>;
  install(input: { kernelId: KernelId }): Promise<KernelPackageMutationResult>;
  update(input: { kernelId: KernelId }): Promise<KernelPackageMutationResult>;
  repair(input: { kernelId: KernelId }): Promise<KernelPackageMutationResult>;
  rollback(input: { kernelId: KernelId }): Promise<KernelPackageMutationResult>;
  uninstall(input: { kernelId: KernelId }): Promise<KernelUninstallMutationResult>;
  versions(input: { kernelId: KernelId }): Promise<KernelRuntimeVersionList>;
  openDirectory(input: { kernelId: KernelId; kind: KernelDirectoryKind }): Promise<{ success: true }>;
  list(): Promise<KernelRuntimeSnapshot[]>;
  status(input: { kernelId: KernelId }): Promise<KernelRuntimeSnapshot>;
  start(input: { kernelId: KernelId }): Promise<KernelRuntimeSnapshot>;
  stop(input: { kernelId: KernelId }): Promise<void>;
  restart(input: { kernelId: KernelId }): Promise<KernelRuntimeSnapshot>;
  health(input: { kernelId: KernelId }): Promise<KernelRuntimeSnapshot>;
  logs(input: {
    kernelId: KernelId;
    afterSequence?: number;
    limit?: number;
  }): Promise<KernelLogEntry[]>;
  logDirectory(input: { kernelId: KernelId }): Promise<{ path?: string }>;
  exportLogs(input: { kernelId: KernelId }): Promise<KernelLogExport>;
  setAutoStart(input: { kernelId: KernelId; enabled: boolean }): Promise<KernelRuntimeSnapshot>;
  execute(input: KernelRunRequest): Promise<KernelRunIdentity & { acceptedAt: string }>;
  cancel(input: KernelRunIdentity): Promise<{ acknowledged: boolean }>;
  updateConfiguration(input: KernelRunConfiguration): Promise<void>;
  resolvePermission(input: KernelRunIdentity & {
    requestId: string;
    decision: 'allow-once' | 'reject-once';
    optionId?: string;
    answer?: string;
  }): Promise<void>;
  diagnostics(input: { kernelId: KernelId }): Promise<KernelRuntimeDiagnostics>;
};

export type KernelPackageProgressEvent = KernelDownloadProgress;

export function assertExecutionIdentity(input: KernelRunIdentity): void {
  if (!input.conversationId || !input.turnId || !input.runId || !input.kernelId) {
    throw new Error('Kernel execution identity is incomplete');
  }
  if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
    throw new Error('Kernel execution generation must be a positive safe integer');
  }
}
