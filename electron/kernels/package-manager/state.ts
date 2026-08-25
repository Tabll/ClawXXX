import type { KernelId } from '@shared/kernels/contracts';
import type {
  KernelActivationHistoryRecord,
  KernelCatalogStateRecord,
  KernelInstallationRecord,
  KernelRuntimeVersionRecord,
} from '@shared/kernels/package-manager';

export type CommitKernelActivationInput = {
  kernelId: KernelId;
  activeVersion: string;
  lastKnownGoodVersion: string;
  expectedActiveVersion: string | null;
  reason: KernelActivationHistoryRecord['reason'];
  manifest: KernelInstallationRecord['manifest'];
  updatedAt: string;
};

/**
 * The package manager never owns a JSON state file. Implementations of this
 * port must persist through the single-owner ClawX DataService transaction
 * boundary.
 */
export interface KernelPackageStateStore {
  putOperation(input: {
    id: string;
    kind: string;
    targetType: string;
    targetId: string;
    desiredState: unknown;
    createdAt: string;
  }): Promise<void>;
  completeOperation(input: { id: string; ok: boolean; error?: string; updatedAt: string }): Promise<void>;
  getKernelCatalogState(channel: KernelCatalogStateRecord['channel']): Promise<KernelCatalogStateRecord | undefined>;
  putKernelCatalogState(input: KernelCatalogStateRecord): Promise<void>;
  getKernelInstallation(kernelId: KernelId): Promise<KernelInstallationRecord | undefined>;
  listKernelInstallations(): Promise<KernelInstallationRecord[]>;
  putKernelInstallation(input: KernelInstallationRecord): Promise<void>;
  upsertKernelRuntimeVersion(input: KernelRuntimeVersionRecord): Promise<void>;
  getKernelRuntimeVersion(kernelId: KernelId, artifactVersion: string): Promise<KernelRuntimeVersionRecord | undefined>;
  listKernelRuntimeVersions(kernelId?: KernelId): Promise<KernelRuntimeVersionRecord[]>;
  removeKernelRuntimeVersion(kernelId: KernelId, artifactVersion: string): Promise<void>;
  commitKernelActivation(input: CommitKernelActivationInput): Promise<KernelInstallationRecord>;
  listKernelActivationHistory(kernelId: KernelId, limit?: number): Promise<KernelActivationHistoryRecord[]>;
}

export type GenericDataServiceClient = {
  call<T = unknown>(method: string, ...args: unknown[]): Promise<T>;
};

/** Typed package-state facade for the utility-process DataService client. */
export class RemoteKernelPackageStateStore implements KernelPackageStateStore {
  constructor(private readonly client: GenericDataServiceClient) {}

  putOperation(input: {
    id: string;
    kind: string;
    targetType: string;
    targetId: string;
    desiredState: unknown;
    createdAt: string;
  }): Promise<void> {
    return this.client.call('putOperation', input);
  }

  completeOperation(input: { id: string; ok: boolean; error?: string; updatedAt: string }): Promise<void> {
    return this.client.call('completeOperation', input);
  }

  getKernelCatalogState(channel: KernelCatalogStateRecord['channel']): Promise<KernelCatalogStateRecord | undefined> {
    return this.client.call('getKernelCatalogState', channel);
  }

  putKernelCatalogState(input: KernelCatalogStateRecord): Promise<void> {
    return this.client.call('putKernelCatalogState', input);
  }

  getKernelInstallation(kernelId: KernelId): Promise<KernelInstallationRecord | undefined> {
    return this.client.call('getKernelInstallation', kernelId);
  }

  listKernelInstallations(): Promise<KernelInstallationRecord[]> {
    return this.client.call('listKernelInstallations');
  }

  putKernelInstallation(input: KernelInstallationRecord): Promise<void> {
    return this.client.call('putKernelInstallation', input);
  }

  upsertKernelRuntimeVersion(input: KernelRuntimeVersionRecord): Promise<void> {
    return this.client.call('upsertKernelRuntimeVersion', input);
  }

  getKernelRuntimeVersion(kernelId: KernelId, artifactVersion: string): Promise<KernelRuntimeVersionRecord | undefined> {
    return this.client.call('getKernelRuntimeVersion', kernelId, artifactVersion);
  }

  listKernelRuntimeVersions(kernelId?: KernelId): Promise<KernelRuntimeVersionRecord[]> {
    return this.client.call('listKernelRuntimeVersions', kernelId);
  }

  removeKernelRuntimeVersion(kernelId: KernelId, artifactVersion: string): Promise<void> {
    return this.client.call('removeKernelRuntimeVersion', kernelId, artifactVersion);
  }

  commitKernelActivation(input: CommitKernelActivationInput): Promise<KernelInstallationRecord> {
    return this.client.call('commitKernelActivation', input);
  }

  listKernelActivationHistory(kernelId: KernelId, limit?: number): Promise<KernelActivationHistoryRecord[]> {
    return this.client.call('listKernelActivationHistory', kernelId, limit);
  }
}
