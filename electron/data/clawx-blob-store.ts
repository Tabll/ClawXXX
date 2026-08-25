import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_MAX_BLOB_BYTES = 256 * 1024 * 1024;

export type StoredBlob = {
  hash: string;
  byteLength: number;
  mimeType: string;
  path: string;
};

export class ClawXBlobStore {
  readonly objectsRoot: string;

  constructor(
    readonly root: string,
    private readonly maxBlobBytes = DEFAULT_MAX_BLOB_BYTES,
  ) {
    this.objectsRoot = join(root, 'objects');
    mkdirSync(this.objectsRoot, { recursive: true, mode: 0o700 });
    try { chmodSync(root, 0o700); } catch { /* Platform ACL enforcement is owned by the DataService process. */ }
    try { chmodSync(this.objectsRoot, 0o700); } catch { /* See above. */ }
  }

  put(data: Uint8Array, mimeType: string): StoredBlob {
    if (data.byteLength > this.maxBlobBytes) {
      throw new Error(`Blob exceeds ${this.maxBlobBytes} byte policy limit`);
    }
    if (!mimeType.trim()) throw new Error('Blob MIME type is required');
    const hash = createHash('sha256').update(data).digest('hex');
    const destination = this.pathFor(hash);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    if (existsSync(destination)) {
      this.verify(hash, data.byteLength);
      return { hash, byteLength: data.byteLength, mimeType, path: destination };
    }

    const temporary = `${destination}.partial-${process.pid}-${randomUUID()}`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporary, 'wx', 0o600);
      let offset = 0;
      while (offset < data.byteLength) offset += writeSync(descriptor, data, offset);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      try { chmodSync(temporary, 0o600); } catch { /* Best effort on Windows. */ }
      renameSync(temporary, destination);
      this.verify(hash, data.byteLength);
      return { hash, byteLength: data.byteLength, mimeType, path: destination };
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      if (existsSync(temporary)) unlinkSync(temporary);
      if (existsSync(destination)) {
        this.verify(hash, data.byteLength);
        return { hash, byteLength: data.byteLength, mimeType, path: destination };
      }
      throw error;
    }
  }

  readVerified(hash: string): Uint8Array {
    const path = this.pathFor(hash);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Blob ${hash} is not a regular file`);
    if (stat.size > this.maxBlobBytes) throw new Error(`Blob ${hash} exceeds the read policy limit`);
    const data = readFileSync(path);
    const actual = createHash('sha256').update(data).digest('hex');
    if (actual !== hash) throw new Error(`Blob hash verification failed for ${hash}`);
    return data;
  }

  verify(hash: string, expectedBytes?: number): void {
    const data = this.readVerified(hash);
    if (expectedBytes !== undefined && data.byteLength !== expectedBytes) {
      throw new Error(`Blob length verification failed for ${hash}`);
    }
  }

  remove(hash: string): void {
    const path = this.pathFor(hash);
    if (existsSync(path)) unlinkSync(path);
  }

  pathFor(hash: string): string {
    if (!SHA256_PATTERN.test(hash)) throw new Error('Blob hash must be lowercase SHA-256 hex');
    const path = resolve(this.objectsRoot, hash.slice(0, 2), hash);
    const child = relative(resolve(this.objectsRoot), path);
    if (child.startsWith('..') || isAbsolute(child)) throw new Error('Blob path escaped the object root');
    return path;
  }
}
