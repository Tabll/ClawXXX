import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { inspectClawXDatabase } from './data-recovery';

export type BackupCapableClient = { backupTo(path: string): Promise<void> };

type BackupManifest = {
  schema: 'clawx.backup/v1';
  createdAt: string;
  files: Array<{ path: string; bytes: number; sha256: string }>;
};

function files(root: string): string[] {
  if (!existsSync(root)) return [];
  const result: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const path = pending.pop()!;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Backup source contains a symbolic link: ${path}`);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) pending.push(join(path, name));
    } else if (stat.isFile()) {
      result.push(path);
    }
  }
  return result.sort();
}

function enforceOwnerOnlyTree(root: string): void {
  if (!existsSync(root)) return;
  const pending = [root];
  while (pending.length > 0) {
    const path = pending.pop()!;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Owner-only data tree contains a symbolic link: ${path}`);
    if (stat.isDirectory()) {
      try { chmodSync(path, 0o700); } catch { /* Windows ACL verification is performed by platform release tests. */ }
      for (const name of readdirSync(path)) pending.push(join(path, name));
      continue;
    }
    if (stat.isFile()) {
      try { chmodSync(path, 0o600); } catch { /* Best effort on Windows; do not broaden existing ACLs. */ }
    }
  }
}

function manifestFor(root: string, createdAt: string): BackupManifest {
  return {
    schema: 'clawx.backup/v1',
    createdAt,
    files: files(root).filter(path => !path.endsWith('manifest.json')).map(path => {
      const data = readFileSync(path);
      return {
        path: relative(root, path).replaceAll('\\', '/'),
        bytes: data.byteLength,
        sha256: createHash('sha256').update(data).digest('hex'),
      };
    }),
  };
}

export class ClawXDataBackupManager {
  async create(input: {
    client: BackupCapableClient;
    blobRoot: string;
    destination: string;
    createdAt?: string;
  }): Promise<BackupManifest> {
    const staging = `${input.destination}.partial-${randomUUID()}`;
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    try {
      await input.client.backupTo(join(staging, 'clawx.sqlite'));
      if (existsSync(input.blobRoot)) cpSync(input.blobRoot, join(staging, 'blobs'), { recursive: true, dereference: false });
      enforceOwnerOnlyTree(staging);
      const manifest = manifestFor(staging, input.createdAt ?? new Date().toISOString());
      writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
      enforceOwnerOnlyTree(staging);
      this.verify(staging);
      mkdirSync(dirname(input.destination), { recursive: true, mode: 0o700 });
      if (existsSync(input.destination)) throw new Error(`Backup destination already exists: ${input.destination}`);
      renameSync(staging, input.destination);
      return manifest;
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }

  verify(root: string): BackupManifest {
    const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as BackupManifest;
    if (manifest.schema !== 'clawx.backup/v1') throw new Error('Unsupported ClawX backup manifest');
    for (const entry of manifest.files) {
      const path = resolve(root, entry.path);
      const child = relative(resolve(root), path);
      if (child.startsWith('..') || isAbsolute(child)) throw new Error('Backup manifest path escaped root');
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.bytes) {
        throw new Error(`Backup file metadata mismatch: ${entry.path}`);
      }
      const hash = createHash('sha256').update(readFileSync(path)).digest('hex');
      if (hash !== entry.sha256) throw new Error(`Backup hash mismatch: ${entry.path}`);
    }
    inspectClawXDatabase(join(root, 'clawx.sqlite'));
    return manifest;
  }

  restore(input: {
    snapshot: string;
    databasePath: string;
    blobRoot: string;
    quarantineRoot?: string;
  }): { quarantined: string[] } {
    this.verify(input.snapshot);
    const quarantineRoot = input.quarantineRoot ?? join(dirname(input.databasePath), 'restore-quarantine');
    mkdirSync(quarantineRoot, { recursive: true, mode: 0o700 });
    const quarantined: Array<{ source: string; destination: string }> = [];
    const quarantine = (source: string) => {
      if (!existsSync(source)) return;
      const destination = join(quarantineRoot, `${source.split(/[\\/]/).at(-1)}.${randomUUID()}.previous`);
      renameSync(source, destination);
      quarantined.push({ source, destination });
    };
    try {
      quarantine(input.databasePath);
      quarantine(`${input.databasePath}-wal`);
      quarantine(`${input.databasePath}-shm`);
      quarantine(input.blobRoot);
      mkdirSync(dirname(input.databasePath), { recursive: true, mode: 0o700 });
      copyFileSync(join(input.snapshot, 'clawx.sqlite'), input.databasePath);
      if (existsSync(join(input.snapshot, 'blobs'))) {
        cpSync(join(input.snapshot, 'blobs'), input.blobRoot, { recursive: true, dereference: false });
      }
      enforceOwnerOnlyTree(input.databasePath);
      if (existsSync(input.blobRoot)) enforceOwnerOnlyTree(input.blobRoot);
      inspectClawXDatabase(input.databasePath);
      return { quarantined: quarantined.map(item => item.destination) };
    } catch (error) {
      if (existsSync(input.databasePath)) rmSync(input.databasePath, { force: true });
      if (existsSync(input.blobRoot)) rmSync(input.blobRoot, { recursive: true, force: true });
      for (const item of [...quarantined].reverse()) {
        if (existsSync(item.destination)) renameSync(item.destination, item.source);
      }
      throw error;
    }
  }
}
