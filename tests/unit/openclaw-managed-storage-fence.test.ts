// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('production native SQLite history fence', () => {
  it.each(['agent', 'state'])('blocks durable %s history without deleting old rows or disabling auth/config', async kind => {
    const { installClawXStorageFence } = await import(pathToFileURL(resolve('node_modules/openclaw/dist/clawx-managed-storage.js')).href);
    const root = mkdtempSync(join(tmpdir(), 'clawx-storage-fence-'));
    const db = new DatabaseSync(join(root, 'native.sqlite'));
    const table = kind === 'agent' ? 'sessions' : 'cron_jobs';
    try {
      db.exec(`CREATE TABLE ${table}(value TEXT); INSERT INTO ${table} VALUES ('old-history'); CREATE TABLE auth_profile_store(value TEXT)`);
      installClawXStorageFence(db, kind, { CLAWX_MANAGED_RUNTIME: '1' });
      for (const sql of [`INSERT INTO ${table} VALUES ('new')`, `UPDATE ${table} SET value='new'`, `DELETE FROM ${table}`]) {
        expect(() => db.exec(sql)).toThrow('canonical history');
      }
      db.exec("INSERT INTO auth_profile_store VALUES ('test-credential')");
      expect(db.prepare(`SELECT value FROM ${table}`).get()?.value).toBe('old-history');
      expect(db.prepare('SELECT value FROM auth_profile_store').get()?.value).toBe('test-credential');
      expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger'").get()?.n).toBe(0);
    } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('permits incognito in-memory execution and does not modify unmanaged runtimes', async () => {
    const { installClawXStorageFence } = await import(pathToFileURL(resolve('node_modules/openclaw/dist/clawx-managed-storage.js')).href);
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('CREATE TABLE sessions(value TEXT)');
      installClawXStorageFence(db, 'agent', { CLAWX_MANAGED_RUNTIME: '1' });
      db.exec("INSERT INTO sessions VALUES ('current-run-only')");
      expect(db.prepare('SELECT count(*) AS n FROM sessions').get()?.n).toBe(1);
    } finally { db.close(); }
  });

  it('keeps transport receipts and approvals in constrained TEMP tables without reading or changing old payloads', async () => {
    const { installClawXStorageFence } = await import(pathToFileURL(resolve('node_modules/openclaw/dist/clawx-managed-storage.js')).href);
    const root = mkdtempSync(join(tmpdir(), 'clawx-transport-fence-'));
    const db = new DatabaseSync(join(root, 'native.sqlite'));
    try {
      db.exec("CREATE TABLE channel_ingress_events(id TEXT PRIMARY KEY, body TEXT NOT NULL CHECK(length(body)>0)); INSERT INTO channel_ingress_events VALUES ('old', 'old native body')");
      installClawXStorageFence(db, 'state', { CLAWX_MANAGED_RUNTIME: '1' });
      installClawXStorageFence(db, 'state', { CLAWX_MANAGED_RUNTIME: '1' });
      expect(db.prepare('SELECT * FROM channel_ingress_events').all()).toEqual([]);
      db.exec("INSERT INTO channel_ingress_events VALUES ('live', 'transient body')");
      expect(() => db.exec("INSERT INTO channel_ingress_events VALUES ('live', 'duplicate')")).toThrow('UNIQUE');
      expect(() => db.exec("INSERT INTO channel_ingress_events VALUES ('empty', '')")).toThrow('CHECK');
      expect(() => db.exec("INSERT INTO main.channel_ingress_events VALUES ('bypass', 'body')")).toThrow('canonical history');
      expect(db.prepare('SELECT * FROM main.channel_ingress_events').all()).toEqual([{ id: 'old', body: 'old native body' }]);
      expect(db.prepare('PRAGMA temp_store').get()?.temp_store).toBe(2);
    } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
