import { randomUUID } from 'node:crypto';

type StagedCredential = {
  value: string;
  expiresAt: number;
};

/** Short-lived Main-memory handoff from the isolated preload secret field. */
export class CredentialStagingVault {
  private readonly entries = new Map<string, StagedCredential>();

  constructor(
    private readonly options: {
      ttlMs?: number;
      maxEntries?: number;
      maxBytes?: number;
      now?: () => number;
    } = {},
  ) {}

  stage(value: string): string {
    this.sweep();
    if (!value || Buffer.byteLength(value, 'utf8') > (this.options.maxBytes ?? 64 * 1024)) {
      throw new Error('Credential value is empty or exceeds the secure staging limit');
    }
    if (this.entries.size >= (this.options.maxEntries ?? 64)) {
      throw new Error('Secure credential staging capacity is exhausted');
    }
    const handle = `credential-stage://${randomUUID()}`;
    this.entries.set(handle, {
      value,
      expiresAt: this.now() + (this.options.ttlMs ?? 2 * 60_000),
    });
    return handle;
  }

  read(handle: string): string {
    this.sweep();
    const entry = this.entries.get(handle);
    if (!entry) throw new Error('Credential staging handle is invalid or expired');
    return entry.value;
  }

  consume(handle: string): string {
    const value = this.read(handle);
    this.entries.delete(handle);
    return value;
  }

  discard(handle: string): void {
    this.entries.delete(handle);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    this.sweep();
    return this.entries.size;
  }

  private sweep(): void {
    const now = this.now();
    for (const [handle, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(handle);
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
