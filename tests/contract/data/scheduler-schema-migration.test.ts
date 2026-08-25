// @vitest-environment node

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { ClawXDataStore } from '@electron/data/clawx-data-store';
import { CLAWX_DATA_SCHEMA_VERSION, INITIAL_SCHEMA_SQL } from '@electron/data/schema';

function version11Schema(): string {
  return INITIAL_SCHEMA_SQL
    .replace(/^ {2}timeout_ms .*\n/m, '')
    .replace(
      '  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),\n  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),\n  next_run_at TEXT,',
      '  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),\n  next_run_at TEXT,',
    )
    .replace(/^ {2}trigger_kind .*\n/m, '')
    .replace(/^ {2}snapshot_json .*\n/m, '')
    .replace(
      '  error TEXT,\n  diagnostic_json TEXT,\n  delivery_message_id TEXT REFERENCES channel_messages(id) ON DELETE SET NULL\n',
      '  error TEXT\n',
    )
    .replace(/CREATE TABLE IF NOT EXISTS scheduler_leases \([\s\S]*?\);\n\n/, '');
}

describe('Scheduler schema v12 migration', () => {
  it('adds immutable snapshots, diagnostics and leader leases without importing native history', () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-scheduler-v12-'));
    const databasePath = join(root, 'clawx.sqlite');
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(version11Schema());
    legacy.exec('PRAGMA user_version = 11');
    const now = '2026-08-24T00:00:00.000Z';
    legacy.prepare(`
      INSERT INTO cron_jobs(
        id, name, prompt, schedule_json, timezone, kernel_id, agent_id,
        conversation_policy, delivery_json, misfire_policy, overlap_policy,
        enabled, next_run_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'legacy-job',
      'Legacy canonical job',
      'canonical only',
      JSON.stringify({ kind: 'cron', expression: '0 * * * *', timezone: 'UTC' }),
      'UTC',
      'openclaw',
      'main',
      'reuse',
      'null',
      'run-once',
      'skip',
      1,
      '2026-08-24T01:00:00.000Z',
      now,
      now,
    );
    legacy.close();

    const store = new ClawXDataStore(databasePath);
    try {
      expect(store.getCronJob('legacy-job')).toMatchObject({
        timeoutMs: 1_800_000,
        revision: 1,
      });
      const lease = store.acquireSchedulerLease({
        name: 'clawx-scheduler',
        ownerId: 'migration-test',
        now,
        leaseExpiresAt: '2026-08-24T00:00:30.000Z',
        updatedAt: now,
      });
      expect(lease.acquired).toBe(true);
      const verification = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect((verification.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
          .toBe(CLAWX_DATA_SCHEMA_VERSION);
        expect(verification.prepare("SELECT name FROM sqlite_master WHERE name = 'scheduler_leases'").get())
          .toBeTruthy();
      } finally {
        verification.close();
      }
    } finally {
      store.close();
    }
  });
});
