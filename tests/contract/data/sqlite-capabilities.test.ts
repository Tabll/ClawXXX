// @vitest-environment node

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

describe('packaged Node SQLite capability contract', () => {
  it('supports WAL, FTS5, foreign keys, quick/integrity checks and consistent backup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-sqlite-capability-'));
    const path = join(root, 'source.sqlite');
    const snapshot = join(root, 'snapshot.sqlite');
    const db = new DatabaseSync(path);
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE parent(id TEXT PRIMARY KEY);
      CREATE TABLE child(id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parent(id));
      CREATE VIRTUAL TABLE search USING fts5(value);
      INSERT INTO search(value) VALUES ('portable history');
    `);
    expect((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal');
    expect((db.prepare("SELECT value FROM search WHERE search MATCH 'portable'").get() as { value: string }).value)
      .toBe('portable history');
    expect(Object.values(db.prepare('PRAGMA quick_check').get() as Record<string, unknown>)[0]).toBe('ok');
    expect(Object.values(db.prepare('PRAGMA integrity_check').get() as Record<string, unknown>)[0]).toBe('ok');
    await backup(db, snapshot);
    db.close();

    const restored = new DatabaseSync(snapshot, { readOnly: true });
    expect((restored.prepare('SELECT COUNT(*) AS count FROM search').get() as { count: number }).count).toBe(1);
    restored.close();
  });
});
