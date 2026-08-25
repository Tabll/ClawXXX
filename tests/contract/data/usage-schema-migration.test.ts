// @vitest-environment node

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { ClawXDataStore } from '@electron/data/clawx-data-store';
import { CLAWX_DATA_SCHEMA_VERSION, INITIAL_SCHEMA_SQL } from '@electron/data/schema';

function version12Schema(): string {
  return INITIAL_SCHEMA_SQL
    .replace(/^ {2}total_tokens .*\n/m, '')
    .replace(/^ {2}cost_amount .*\n/m, '')
    .replace(/^ {2}currency .*\n/m, '')
    .replace(/^ {2}source TEXT NOT NULL DEFAULT 'runtime-event'.*\n/m, '');
}

describe('Usage schema v13 migration', () => {
  it('preserves legacy USD rows while adding nullable metrics and provenance', () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-usage-v13-'));
    const databasePath = join(root, 'clawx.sqlite');
    const legacy = new DatabaseSync(databasePath);
    const now = '2026-08-24T00:00:00.000Z';
    legacy.exec(version12Schema());
    legacy.exec('PRAGMA user_version = 12');
    legacy.prepare('INSERT INTO conversations(id, created_at, updated_at) VALUES (?, ?, ?)')
      .run('conversation', now, now);
    legacy.prepare(`
      INSERT INTO turns(id, conversation_id, role, position, created_at, completed_at)
      VALUES ('turn', 'conversation', 'user', 0, ?, ?)
    `).run(now, now);
    legacy.prepare(`
      INSERT INTO runs(
        id, conversation_id, turn_id, kernel_id, kernel_version, generation,
        agent_id, context_compiler_version, status, created_at, completed_at
      ) VALUES ('run', 'conversation', 'turn', 'openclaw', 'legacy', 1,
        'main', 'v1', 'completed', ?, ?)
    `).run(now, now);
    legacy.prepare(`
      INSERT INTO usage_entries(
        id, run_id, event_key, kernel_id, input_tokens, output_tokens, cost_usd, recorded_at
      ) VALUES ('usage', 'run', 'legacy-request', 'openclaw', 3, 2, 0.01, ?)
    `).run(now);
    legacy.close();

    const store = new ClawXDataStore(databasePath);
    try {
      expect(store.listUsage({ from: '1970-01-01T00:00:00.000Z', to: '9999-01-01T00:00:00.000Z' }))
        .toEqual([expect.objectContaining({
          id: 'usage',
          cost: 0.01,
          currency: 'USD',
          source: 'runtime-event',
          totalTokens: null,
        })]);
      const verification = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect((verification.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
          .toBe(CLAWX_DATA_SCHEMA_VERSION);
      } finally {
        verification.close();
      }
    } finally {
      store.close();
    }
  });
});
