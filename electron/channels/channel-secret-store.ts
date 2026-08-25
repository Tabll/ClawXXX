export type ChannelCredential = {
  accountId: string;
  values: Record<string, string>;
  updatedAt: string;
};

type EncryptedChannelCredential = {
  version: 1;
  ciphertext: string;
};

export interface ChannelSecretCipher {
  encrypt(value: string): Promise<Uint8Array> | Uint8Array;
  decrypt(value: Uint8Array): Promise<string> | string;
}

class ElectronSafeStorageChannelCipher implements ChannelSecretCipher {
  private async service() {
    const { safeStorage } = await import('electron');
    if (!safeStorage?.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text') {
      throw new Error('A secure OS keychain backend is required for Channel credentials');
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

export interface ChannelSecretStore {
  get(accountId: string): Promise<ChannelCredential | undefined>;
  set(credential: ChannelCredential): Promise<void>;
  delete(accountId: string): Promise<void>;
  has(accountId: string): Promise<boolean>;
}

export class SafeStorageChannelSecretStore implements ChannelSecretStore {
  constructor(private readonly cipher: ChannelSecretCipher = new ElectronSafeStorageChannelCipher()) {}

  async get(accountId: string): Promise<ChannelCredential | undefined> {
    const store = await this.store();
    const entries = (store.get('credentials') ?? {}) as Record<string, EncryptedChannelCredential>;
    const envelope = entries[accountId];
    if (!envelope) return undefined;
    if (envelope.version !== 1 || typeof envelope.ciphertext !== 'string') {
      throw new Error('Channel credential envelope is invalid');
    }
    const plaintext = await this.cipher.decrypt(Buffer.from(envelope.ciphertext, 'base64'));
    const credential = JSON.parse(plaintext) as ChannelCredential;
    if (credential.accountId !== accountId || !credential.values || typeof credential.values !== 'object') {
      throw new Error('Channel credential envelope identity mismatch');
    }
    return credential;
  }

  async set(credential: ChannelCredential): Promise<void> {
    if (!credential.accountId.trim() || Object.values(credential.values).some(value => typeof value !== 'string')) {
      throw new Error('Channel credential identity and string values are required');
    }
    const store = await this.store();
    const encrypted = await this.cipher.encrypt(JSON.stringify(credential));
    const entries = (store.get('credentials') ?? {}) as Record<string, EncryptedChannelCredential>;
    entries[credential.accountId] = {
      version: 1,
      ciphertext: Buffer.from(encrypted).toString('base64'),
    };
    store.set('credentials', entries);
  }

  async delete(accountId: string): Promise<void> {
    const store = await this.store();
    const entries = (store.get('credentials') ?? {}) as Record<string, EncryptedChannelCredential>;
    delete entries[accountId];
    store.set('credentials', entries);
  }

  async has(accountId: string): Promise<boolean> {
    const store = await this.store();
    const entries = (store.get('credentials') ?? {}) as Record<string, EncryptedChannelCredential>;
    return Boolean(entries[accountId]);
  }

  private async store() {
    const Store = (await import('electron-store')).default;
    return new Store({
      name: 'clawx-channel-secrets',
      defaults: { schemaVersion: 1, credentials: {} as Record<string, EncryptedChannelCredential> },
    });
  }
}

export class MemoryChannelSecretStore implements ChannelSecretStore {
  private readonly values = new Map<string, ChannelCredential>();

  async get(accountId: string): Promise<ChannelCredential | undefined> {
    const value = this.values.get(accountId);
    return value ? structuredClone(value) : undefined;
  }

  async set(credential: ChannelCredential): Promise<void> {
    this.values.set(credential.accountId, structuredClone(credential));
  }

  async delete(accountId: string): Promise<void> {
    this.values.delete(accountId);
  }

  async has(accountId: string): Promise<boolean> {
    return this.values.has(accountId);
  }
}
