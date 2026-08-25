import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.CLAWX_ELECTRON_SQLITE_CHILD !== '1') {
  const electronPath = (await import('electron')).default;
  const result = spawnSync(electronPath, [fileURLToPath(import.meta.url)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CLAWX_ELECTRON_SQLITE_CHILD: '1' },
    encoding: 'utf8',
    stdio: 'inherit',
  });
  process.exit(result.status ?? 1);
}

const { backup, DatabaseSync } = await import('node:sqlite');
const root = mkdtempSync(join(tmpdir(), 'clawx-electron-sqlite-'));
try {
  const sourcePath = join(root, 'source.sqlite');
  const backupPath = join(root, 'backup', 'snapshot.sqlite');
  const database = new DatabaseSync(sourcePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE VIRTUAL TABLE search USING fts5(value);
    INSERT INTO search(value) VALUES ('electron packaged sqlite');
  `);
  const journal = database.prepare('PRAGMA journal_mode').get().journal_mode;
  const match = database.prepare("SELECT value FROM search WHERE search MATCH 'packaged'").get().value;
  const check = Object.values(database.prepare('PRAGMA integrity_check').get())[0];
  await import('node:fs').then(({ mkdirSync }) => mkdirSync(dirname(backupPath), { recursive: true }));
  await backup(database, backupPath);
  database.close();
  const snapshot = new DatabaseSync(backupPath, { readOnly: true });
  const rows = snapshot.prepare('SELECT COUNT(*) AS count FROM search').get().count;
  snapshot.close();
  if (journal !== 'wal' || match !== 'electron packaged sqlite' || check !== 'ok' || rows !== 1) {
    throw new Error(`SQLite smoke mismatch: ${JSON.stringify({ journal, match, check, rows })}`);
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    node: process.versions.node,
    journal,
    fts5: true,
    backup: true,
  }) + '\n');
} finally {
  rmSync(root, { recursive: true, force: true });
}
