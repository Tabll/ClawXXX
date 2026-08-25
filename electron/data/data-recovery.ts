import { randomUUID } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type DataRecoveryResult = {
  state: 'new' | 'healthy' | 'read-only' | 'restored-backup' | 'quarantined';
  databasePath: string;
  quarantinePaths: string[];
  diagnostic?: string;
};

export function inspectClawXDatabase(path: string): void {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const quick = String(Object.values(database.prepare('PRAGMA quick_check').get() as Record<string, unknown>)[0]);
    const integrity = String(Object.values(database.prepare('PRAGMA integrity_check').get() as Record<string, unknown>)[0]);
    if (quick !== 'ok' || integrity !== 'ok') throw new Error(`SQLite checks failed: quick=${quick}, integrity=${integrity}`);
  } finally {
    database.close();
  }
}

export function prepareClawXDataStore(input: {
  databasePath: string;
  backupPath?: string;
  quarantineRoot?: string;
  now?: string;
}): DataRecoveryResult {
  if (!existsSync(input.databasePath)) {
    return { state: 'new', databasePath: input.databasePath, quarantinePaths: [] };
  }
  try {
    inspectClawXDatabase(input.databasePath);
    try {
      accessSync(input.databasePath, constants.W_OK);
      for (const path of [input.databasePath, `${input.databasePath}-wal`, `${input.databasePath}-shm`]) {
        if (!existsSync(path)) continue;
        try { chmodSync(path, 0o600); } catch { /* Best effort on Windows; release tests validate effective ACLs. */ }
      }
      return { state: 'healthy', databasePath: input.databasePath, quarantinePaths: [] };
    } catch {
      return {
        state: 'read-only',
        databasePath: input.databasePath,
        quarantinePaths: [],
        diagnostic: 'Database is consistent but the owner cannot write it; mutation and runtime dispatch must remain disabled.',
      };
    }
  } catch (error) {
    const quarantineRoot = input.quarantineRoot ?? join(dirname(input.databasePath), 'quarantine');
    mkdirSync(quarantineRoot, { recursive: true, mode: 0o700 });
    const stamp = (input.now ?? new Date().toISOString()).replaceAll(/[:.]/g, '-');
    const quarantinePaths: string[] = [];
    for (const source of [input.databasePath, `${input.databasePath}-wal`, `${input.databasePath}-shm`]) {
      if (!existsSync(source)) continue;
      const destination = join(quarantineRoot, `${basename(source)}.${stamp}.${randomUUID()}.corrupt`);
      renameSync(source, destination);
      quarantinePaths.push(destination);
    }
    if (input.backupPath && existsSync(input.backupPath)) {
      copyFileSync(input.backupPath, input.databasePath);
      try { chmodSync(input.databasePath, 0o600); } catch { /* See owner-only note above. */ }
      try {
        inspectClawXDatabase(input.databasePath);
        return {
          state: 'restored-backup',
          databasePath: input.databasePath,
          quarantinePaths,
          diagnostic: error instanceof Error ? error.message : String(error),
        };
      } catch (backupError) {
        const invalidBackup = join(quarantineRoot, `${basename(input.databasePath)}.${stamp}.invalid-backup`);
        renameSync(input.databasePath, invalidBackup);
        quarantinePaths.push(invalidBackup);
        return {
          state: 'quarantined',
          databasePath: input.databasePath,
          quarantinePaths,
          diagnostic: `Primary and backup are invalid: ${String(backupError)}`,
        };
      }
    }
    return {
      state: 'quarantined',
      databasePath: input.databasePath,
      quarantinePaths,
      diagnostic: error instanceof Error ? error.message : String(error),
    };
  }
}
