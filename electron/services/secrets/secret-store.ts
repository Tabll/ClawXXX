import type { ProviderSecret } from '../../shared/providers/types';
import { getClawXProviderStore } from '../providers/store-instance';

type EncryptedSecretEnvelope = {
  version: 1;
  ciphertext: string;
};

export interface SecretCipher {
  encrypt(value: string): Promise<Uint8Array> | Uint8Array;
  decrypt(value: Uint8Array): Promise<string> | string;
}

class ElectronSafeStorageCipher implements SecretCipher {
  private async service() {
    const { safeStorage } = await import('electron');
    if (!safeStorage?.isEncryptionAvailable()) {
      throw new Error('OS credential encryption is unavailable; Provider secret was not stored');
    }
    const backend = safeStorage.getSelectedStorageBackend?.();
    if (backend === 'basic_text') {
      throw new Error('No secure OS keychain backend is available; Provider secret was not stored');
    }
    return safeStorage;
  }

  async encrypt(value: string): Promise<Uint8Array> {
    return (await this.service()).encryptString(value);
  }

  async decrypt(value: Uint8Array): Promise<string> {
    return (await this.service()).decryptString(Buffer.from(value));
  }
}

export interface SecretStore {
  get(accountId: string): Promise<ProviderSecret | null>;
  set(secret: ProviderSecret): Promise<void>;
  delete(accountId: string): Promise<void>;
  has(accountId: string): Promise<boolean>;
  migrateLegacy(): Promise<number>;
}

export class SafeStorageSecretStore implements SecretStore {
  constructor(private readonly cipher: SecretCipher = new ElectronSafeStorageCipher()) {}

  async get(accountId: string): Promise<ProviderSecret | null> {
    const store = await getClawXProviderStore();
    const envelopes = (store.get('providerSecretEnvelopes') ?? {}) as Record<string, EncryptedSecretEnvelope>;
    let envelope = envelopes[accountId];
    if (!envelope) {
      const migrated = await this.migrateLegacyAccount(accountId);
      if (!migrated) return null;
      const refreshed = (store.get('providerSecretEnvelopes') ?? {}) as Record<string, EncryptedSecretEnvelope>;
      envelope = refreshed[accountId];
    }
    if (!envelope || envelope.version !== 1 || typeof envelope.ciphertext !== 'string') {
      throw new Error('Provider credential envelope is invalid');
    }
    const plaintext = await this.cipher.decrypt(Buffer.from(envelope.ciphertext, 'base64'));
    try {
      const secret = JSON.parse(plaintext) as ProviderSecret;
      if (secret.accountId !== accountId) throw new Error('Provider credential envelope identity mismatch');
      return secret;
    } finally {
      // JavaScript strings cannot be reliably zeroed; keep plaintext scoped to
      // this method and never cache, return, stringify or log the envelope body.
    }
  }

  async set(secret: ProviderSecret): Promise<void> {
    const store = await getClawXProviderStore();
    const encrypted = await this.cipher.encrypt(JSON.stringify(secret));
    const envelopes = (store.get('providerSecretEnvelopes') ?? {}) as Record<string, EncryptedSecretEnvelope>;
    envelopes[secret.accountId] = {
      version: 1,
      ciphertext: Buffer.from(encrypted).toString('base64'),
    };
    store.set('providerSecretEnvelopes', envelopes);
    this.eraseLegacyAccount(store, secret.accountId);
  }

  async delete(accountId: string): Promise<void> {
    const store = await getClawXProviderStore();
    const envelopes = (store.get('providerSecretEnvelopes') ?? {}) as Record<string, EncryptedSecretEnvelope>;
    delete envelopes[accountId];
    store.set('providerSecretEnvelopes', envelopes);
    this.eraseLegacyAccount(store, accountId);
  }

  async has(accountId: string): Promise<boolean> {
    const store = await getClawXProviderStore();
    const envelopes = (store.get('providerSecretEnvelopes') ?? {}) as Record<string, EncryptedSecretEnvelope>;
    if (envelopes[accountId]) return true;
    return this.migrateLegacyAccount(accountId);
  }

  async migrateLegacy(): Promise<number> {
    const store = await getClawXProviderStore();
    const secrets = (store.get('providerSecrets') ?? {}) as Record<string, ProviderSecret>;
    const apiKeys = (store.get('apiKeys') ?? {}) as Record<string, string>;
    const ids = new Set([...Object.keys(secrets), ...Object.keys(apiKeys)]);
    let migrated = 0;
    for (const accountId of ids) {
      if (await this.migrateLegacyAccount(accountId)) migrated += 1;
    }
    return migrated;
  }

  private async migrateLegacyAccount(accountId: string): Promise<boolean> {
    const store = await getClawXProviderStore();
    const envelopes = (store.get('providerSecretEnvelopes') ?? {}) as Record<string, EncryptedSecretEnvelope>;
    if (envelopes[accountId]) {
      this.eraseLegacyAccount(store, accountId);
      return true;
    }
    const secrets = (store.get('providerSecrets') ?? {}) as Record<string, ProviderSecret>;
    const apiKeys = (store.get('apiKeys') ?? {}) as Record<string, string>;
    const legacy = secrets[accountId] ?? (apiKeys[accountId]
      ? { type: 'api_key' as const, accountId, apiKey: apiKeys[accountId] }
      : undefined);
    if (!legacy) return false;
    await this.set(legacy);
    return true;
  }

  private eraseLegacyAccount(store: Awaited<ReturnType<typeof getClawXProviderStore>>, accountId: string): void {
    const secrets = (store.get('providerSecrets') ?? {}) as Record<string, ProviderSecret>;
    const apiKeys = (store.get('apiKeys') ?? {}) as Record<string, string>;
    if (Object.prototype.hasOwnProperty.call(secrets, accountId)) {
      delete secrets[accountId];
      store.set('providerSecrets', secrets);
    }
    if (Object.prototype.hasOwnProperty.call(apiKeys, accountId)) {
      delete apiKeys[accountId];
      store.set('apiKeys', apiKeys);
    }
  }
}

let secretStore: SecretStore = new SafeStorageSecretStore();

export function getSecretStore(): SecretStore {
  return secretStore;
}

export function setSecretStoreForTesting(store: SecretStore): () => void {
  const previous = secretStore;
  secretStore = store;
  return () => { secretStore = previous; };
}

export async function getProviderSecret(accountId: string): Promise<ProviderSecret | null> {
  return getSecretStore().get(accountId);
}

export async function setProviderSecret(secret: ProviderSecret): Promise<void> {
  await getSecretStore().set(secret);
}

export async function deleteProviderSecret(accountId: string): Promise<void> {
  await getSecretStore().delete(accountId);
}

export async function hasProviderSecret(accountId: string): Promise<boolean> {
  return getSecretStore().has(accountId);
}

export async function migrateLegacyProviderSecrets(): Promise<number> {
  return getSecretStore().migrateLegacy();
}
