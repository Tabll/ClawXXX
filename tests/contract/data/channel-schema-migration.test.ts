// @vitest-environment node

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { ClawXDataStore } from '@electron/data/clawx-data-store';
import { INITIAL_SCHEMA_SQL } from '@electron/data/schema';
import { asConversationId } from '@shared/conversations/contracts';
import { asChannelAccountId } from '@shared/domains/identity';

describe('Channel schema v11 migration', () => {
  it('preserves delivery state and scopes external message identity by conversation', () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-channel-v11-'));
    const databasePath = join(root, 'clawx.sqlite');
    const legacy = new DatabaseSync(databasePath);
    const version10Schema = INITIAL_SCHEMA_SQL
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
      .replace(/CREATE TABLE IF NOT EXISTS scheduler_leases \([\s\S]*?\);\n\n/, '')
      .replace(
      'UNIQUE (account_id, external_conversation_id, external_message_id, direction)',
      'UNIQUE (account_id, external_message_id, direction)',
      );
    legacy.exec(version10Schema);
    legacy.exec('PRAGMA user_version = 10');
    const now = '2026-08-24T00:00:00.000Z';
    legacy.prepare(`
      INSERT INTO channel_accounts(
        id, channel_type, native_account_id, display_name, config_json,
        canonical_json, status, enabled, revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)
    `).run('telegram:default', 'telegram', 'default', 'Telegram', '{}', '{}', 'connected', now, now);
    legacy.prepare(`
      INSERT INTO conversations(id, title, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `).run('conversation-a', 'A', now, now);
    legacy.prepare(`
      INSERT INTO channel_messages(
        id, account_id, external_conversation_id, external_message_id,
        conversation_id, direction, payload_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'message-a',
      'telegram:default',
      'thread-a',
      'provider-message-1',
      'conversation-a',
      'outbound',
      JSON.stringify({ targetId: 'thread-a', text: 'hello', attachments: [], payload: {} }),
      'retrying',
      now,
      now,
    );
    legacy.prepare(`
      INSERT INTO delivery_attempts(id, message_id, attempt, status, error, next_retry_at, attempted_at)
      VALUES (?, ?, 1, 'retry', 'network', ?, ?)
    `).run('attempt-a', 'message-a', '2026-08-24T00:01:00.000Z', now);
    legacy.close();

    const store = new ClawXDataStore(databasePath);
    try {
      expect(store.getChannelMessage('message-a')).toEqual(expect.objectContaining({
        externalConversationId: 'thread-a',
        status: 'retrying',
      }));
      expect(store.listChannelDeliveryAttempts('message-a')).toEqual([
        expect.objectContaining({ id: 'attempt-a', status: 'retry' }),
      ]);
      const second = store.admitChannelMessage({
        messageId: 'message-b',
        accountId: asChannelAccountId('telegram:default'),
        externalConversationId: 'thread-b',
        externalMessageId: 'provider-message-1',
        direction: 'outbound',
        targetId: 'thread-b',
        text: 'world',
        payload: {},
        status: 'pending-delivery',
        conversationPolicy: 'per-message',
        proposedConversationId: asConversationId('conversation-b'),
        createdAt: '2026-08-24T00:02:00.000Z',
      });
      expect(second.inserted).toBe(true);
      expect(second.message.externalConversationId).toBe('thread-b');
    } finally {
      store.close();
    }
  });
});
