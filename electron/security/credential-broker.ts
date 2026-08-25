import type { KernelGeneration, KernelId } from '@shared/kernels/contracts';
import type { CanonicalProviderAccount } from '@shared/domains/providers';
import { providerCredentialReference } from '@shared/domains/providers';
import { getCanonicalProviderAccount } from '../services/providers/provider-store';
import { getProviderSecret } from '../services/secrets/secret-store';
import type { ProviderSecret } from '../shared/providers/types';

export type CredentialPurpose = 'model-request' | 'channel-connect' | 'provider-validate';

export type CredentialProcessIdentity = {
  kernelId: KernelId;
  generation: KernelGeneration;
  pid: number;
  artifactVersion: string;
};

export type CredentialRequest = CredentialProcessIdentity & {
  accountId: string;
  purpose: CredentialPurpose;
};

export type CredentialBrokerAuditEvent = {
  at: string;
  outcome: 'allowed' | 'denied' | 'revoked';
  kernelId: KernelId;
  generation: KernelGeneration;
  pid: number;
  accountId?: string;
  purpose?: CredentialPurpose;
  reason?: string;
};

export type CredentialBrokerDependencies = {
  getAccount(accountId: string): Promise<CanonicalProviderAccount | undefined>;
  getSecret(accountId: string): Promise<ProviderSecret | null>;
  audit?(event: CredentialBrokerAuditEvent): void;
  now?(): Date;
  maxConcurrentRequestsPerProcess?: number;
};

type RegisteredProcess = CredentialProcessIdentity & {
  inflight: number;
  allowedPurposes: ReadonlySet<CredentialPurpose>;
};

const CREDENTIAL_PURPOSES = new Set<CredentialPurpose>([
  'model-request',
  'channel-connect',
  'provider-validate',
]);

function processKey(identity: Pick<CredentialProcessIdentity, 'kernelId' | 'generation' | 'pid'>): string {
  return `${identity.kernelId}\0${identity.generation}\0${identity.pid}`;
}

function assertProcessIdentity(identity: CredentialProcessIdentity): void {
  if (!identity.kernelId || !Number.isSafeInteger(identity.generation) || identity.generation < 1) {
    throw new Error('Credential process kernel identity is invalid');
  }
  if (!Number.isSafeInteger(identity.pid) || identity.pid < 1 || !identity.artifactVersion.trim()) {
    throw new Error('Credential process OS/artifact identity is invalid');
  }
}

function secretValue(secret: ProviderSecret | null): string | undefined {
  if (!secret) return undefined;
  if (secret.type === 'api_key') return secret.apiKey;
  if (secret.type === 'oauth') return secret.accessToken;
  return secret.apiKey;
}

/**
 * Main-owned authorization boundary for runtime credentials. Runtime processes
 * are registered only after stdio ready PID/generation/artifact verification;
 * account metadata and projection status are checked on every request, and no
 * value is cached after the request settles.
 */
export class CredentialBroker {
  private readonly processes = new Map<string, RegisteredProcess>();
  private readonly now: () => Date;
  private readonly maxConcurrent: number;

  constructor(private readonly dependencies: CredentialBrokerDependencies = {
    getAccount: getCanonicalProviderAccount,
    getSecret: getProviderSecret,
  }) {
    this.now = dependencies.now ?? (() => new Date());
    this.maxConcurrent = dependencies.maxConcurrentRequestsPerProcess ?? 8;
    if (!Number.isSafeInteger(this.maxConcurrent) || this.maxConcurrent < 1) {
      throw new Error('CredentialBroker concurrency limit must be a positive safe integer');
    }
  }

  registerProcess(
    identity: CredentialProcessIdentity,
    authorization: { purposes?: readonly CredentialPurpose[] } = {},
  ): () => void {
    assertProcessIdentity(identity);
    const allowedPurposes = new Set<CredentialPurpose>(authorization.purposes ?? ['model-request']);
    if (allowedPurposes.size === 0 || [...allowedPurposes].some(purpose => !CREDENTIAL_PURPOSES.has(purpose))) {
      throw new Error('Credential process purpose authorization is invalid');
    }
    const key = processKey(identity);
    if (this.processes.has(key)) throw new Error('Credential process identity is already registered');
    this.processes.set(key, { ...identity, inflight: 0, allowedPurposes });
    return () => this.revokeProcess(identity);
  }

  revokeProcess(identity: Pick<CredentialProcessIdentity, 'kernelId' | 'generation' | 'pid'>): void {
    const key = processKey(identity);
    const registered = this.processes.get(key);
    if (!registered) return;
    this.processes.delete(key);
    this.audit({
      outcome: 'revoked',
      kernelId: registered.kernelId,
      generation: registered.generation,
      pid: registered.pid,
    });
  }

  revokeKernelGeneration(kernelId: KernelId, generation: KernelGeneration): void {
    for (const registered of [...this.processes.values()]) {
      if (registered.kernelId === kernelId && registered.generation === generation) {
        this.revokeProcess(registered);
      }
    }
  }

  async resolve(request: CredentialRequest): Promise<string> {
    assertProcessIdentity(request);
    if (!request.accountId.trim()) return this.deny(request, 'Credential account id is required');
    const registered = this.processes.get(processKey(request));
    if (!registered || registered.artifactVersion !== request.artifactVersion) {
      return this.deny(request, 'Credential bridge process identity is not registered');
    }
    if (!CREDENTIAL_PURPOSES.has(request.purpose) || !registered.allowedPurposes.has(request.purpose)) {
      return this.deny(request, 'Credential purpose is not authorized for this process');
    }
    if (registered.inflight >= this.maxConcurrent) {
      return this.deny(request, 'Credential bridge request budget is exhausted');
    }
    registered.inflight += 1;
    try {
      const account = await this.dependencies.getAccount(request.accountId);
      if (!account || account.enabled === false) return this.deny(request, 'Provider account is unavailable');
      if (account.credentialRef !== providerCredentialReference(account.id)) {
        return this.deny(request, 'Provider credential reference is invalid');
      }
      const projection = account.projections.find(item => item.kernelId === request.kernelId);
      if (request.purpose !== 'provider-validate'
        && (!projection || (projection.state !== 'ready' && projection.state !== 'partial'))) {
        return this.deny(request, 'Provider account is not projected to this kernel');
      }
      const value = secretValue(await this.dependencies.getSecret(account.id));
      if (!value) return this.deny(request, 'Provider credential is unavailable');
      this.audit({
        outcome: 'allowed',
        kernelId: request.kernelId,
        generation: request.generation,
        pid: request.pid,
        accountId: request.accountId,
        purpose: request.purpose,
      });
      return value;
    } finally {
      registered.inflight -= 1;
    }
  }

  isRegistered(identity: Pick<CredentialProcessIdentity, 'kernelId' | 'generation' | 'pid'>): boolean {
    return this.processes.has(processKey(identity));
  }

  private deny(request: CredentialRequest, reason: string): never {
    this.audit({
      outcome: 'denied',
      kernelId: request.kernelId,
      generation: request.generation,
      pid: request.pid,
      accountId: request.accountId,
      purpose: request.purpose,
      reason,
    });
    throw new Error(reason);
  }

  private audit(event: Omit<CredentialBrokerAuditEvent, 'at'>): void {
    this.dependencies.audit?.({ ...event, at: this.now().toISOString() });
  }
}
