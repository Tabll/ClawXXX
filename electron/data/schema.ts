export const CLAWX_DATA_SCHEMA_VERSION = 13;

export const INITIAL_SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL,
  checksum TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT,
  parent_conversation_id TEXT REFERENCES conversations(id) ON DELETE RESTRICT,
  branched_from_turn_id TEXT REFERENCES turns(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  pinned_at TEXT,
  deleted_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  CHECK ((parent_conversation_id IS NULL) = (branched_from_turn_id IS NULL))
);

CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  parent_turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
  position INTEGER NOT NULL CHECK (position >= 0),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (conversation_id, position)
);

CREATE TABLE IF NOT EXISTS blob_objects (
  hash TEXT PRIMARY KEY,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  mime_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  verified_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS content_blocks (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  type TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('portable', 'kernel', 'private', 'secret')),
  kernel_id TEXT,
  mime_type TEXT,
  text_content TEXT,
  json_content TEXT,
  blob_hash TEXT REFERENCES blob_objects(hash) ON DELETE RESTRICT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (turn_id, position),
  CHECK (visibility != 'kernel' OR kernel_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  kernel_id TEXT NOT NULL,
  kernel_version TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  agent_id TEXT NOT NULL,
  agent_snapshot_json TEXT,
  workspace_uri TEXT,
  provider_id TEXT,
  model_id TEXT,
  context_compiler_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('admitted', 'running', 'cancelling', 'completed', 'cancelled', 'failed', 'interrupted')),
  outcome_error TEXT,
  last_event_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_event_seq >= 0),
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS one_active_run_per_conversation
  ON runs(conversation_id)
  WHERE status IN ('admitted', 'running', 'cancelling');

CREATE TABLE IF NOT EXISTS run_events (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  event_seq INTEGER NOT NULL CHECK (event_seq > 0),
  native_event_id TEXT,
  event_kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  emitted_at TEXT NOT NULL,
  PRIMARY KEY (run_id, event_seq)
);

CREATE UNIQUE INDEX IF NOT EXISTS run_native_event_identity
  ON run_events(run_id, native_event_id)
  WHERE native_event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  native_call_id TEXT,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  input_json TEXT,
  output_json TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (run_id, native_call_id)
);

CREATE TABLE IF NOT EXISTS permissions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  native_request_id TEXT,
  kind TEXT NOT NULL,
  request_json TEXT NOT NULL,
  decision TEXT,
  requested_at TEXT NOT NULL,
  resolved_at TEXT,
  UNIQUE (run_id, native_request_id)
);

CREATE TABLE IF NOT EXISTS usage_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
  kernel_id TEXT NOT NULL,
  provider_id TEXT,
  model_id TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cache_read_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
  cache_write_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0),
  cost_usd REAL NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  recorded_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_entries (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  event_key TEXT NOT NULL,
  kernel_id TEXT NOT NULL,
  provider_id TEXT,
  model_id TEXT,
  request_id TEXT,
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cache_read_tokens INTEGER CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0),
  cache_write_tokens INTEGER CHECK (cache_write_tokens IS NULL OR cache_write_tokens >= 0),
  total_tokens INTEGER CHECK (total_tokens IS NULL OR total_tokens >= 0),
  cost_amount REAL CHECK (cost_amount IS NULL OR cost_amount >= 0),
  currency TEXT,
  cost_usd REAL CHECK (cost_usd IS NULL OR cost_usd >= 0),
  source TEXT NOT NULL DEFAULT 'runtime-event' CHECK (source IN ('runtime-event', 'provider-response')),
  recorded_at TEXT NOT NULL,
  UNIQUE (run_id, event_key)
);

CREATE TABLE IF NOT EXISTS runtime_contexts (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  kernel_id TEXT NOT NULL,
  compiler_version TEXT NOT NULL,
  context_hash TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runtime_checkpoints (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kernel_id TEXT NOT NULL,
  codec TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  checkpoint_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, kernel_id, codec, schema_version)
);

CREATE TABLE IF NOT EXISTS blob_refs (
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  blob_hash TEXT NOT NULL REFERENCES blob_objects(hash) ON DELETE RESTRICT,
  access_policy_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_type, owner_id, position)
);

CREATE TABLE IF NOT EXISTS attachment_access_grants (
  id TEXT PRIMARY KEY,
  blob_hash TEXT NOT NULL REFERENCES blob_objects(hash) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kernel_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_accounts (
  id TEXT PRIMARY KEY,
  channel_type TEXT NOT NULL,
  native_account_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  credential_ref TEXT,
  config_json TEXT NOT NULL,
  canonical_json TEXT NOT NULL,
  status TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE (channel_type, native_account_id)
);

CREATE TABLE IF NOT EXISTS channel_bindings (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL,
  kernel_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  conversation_policy TEXT NOT NULL,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (account_id, target_id)
);

CREATE TABLE IF NOT EXISTS channel_owner_leases (
  account_id TEXT PRIMARY KEY REFERENCES channel_accounts(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  kernel_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  lease_expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_messages (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
  external_conversation_id TEXT NOT NULL,
  external_message_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (account_id, external_conversation_id, external_message_id, direction)
);

CREATE TABLE IF NOT EXISTS delivery_attempts (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES channel_messages(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  status TEXT NOT NULL,
  error TEXT,
  next_retry_at TEXT,
  attempted_at TEXT NOT NULL,
  UNIQUE (message_id, attempt)
);

CREATE TABLE IF NOT EXISTS cron_jobs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL DEFAULT '',
  schedule_json TEXT NOT NULL,
  timezone TEXT NOT NULL,
  kernel_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  conversation_policy TEXT NOT NULL,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  delivery_json TEXT NOT NULL,
  misfire_policy TEXT NOT NULL DEFAULT 'run-once',
  overlap_policy TEXT NOT NULL DEFAULT 'skip',
  timeout_ms INTEGER NOT NULL DEFAULT 1800000 CHECK (timeout_ms >= 1000),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  next_run_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cron_admissions (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES cron_jobs(id) ON DELETE CASCADE,
  scheduled_for TEXT NOT NULL,
  trigger_kind TEXT NOT NULL DEFAULT 'scheduled',
  snapshot_json TEXT NOT NULL DEFAULT '{}',
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  admitted_at TEXT NOT NULL,
  UNIQUE (job_id, scheduled_for)
);

CREATE TABLE IF NOT EXISTS cron_runs (
  id TEXT PRIMARY KEY,
  admission_id TEXT NOT NULL UNIQUE REFERENCES cron_admissions(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  error TEXT,
  diagnostic_json TEXT,
  delivery_message_id TEXT REFERENCES channel_messages(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS scheduler_leases (
  name TEXT PRIMARY KEY CHECK (name = 'clawx-scheduler'),
  owner_id TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  canonical_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_defaults (
  kernel_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  credential_ref TEXT,
  canonical_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_defaults (
  kernel_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  model_id TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  source TEXT NOT NULL,
  canonical_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS kernel_installations (
  kernel_id TEXT PRIMARY KEY,
  desired_version TEXT,
  active_version TEXT,
  last_known_good_version TEXT,
  state TEXT NOT NULL,
  manifest_json TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kernel_catalog_state (
  channel TEXT PRIMARY KEY CHECK (channel IN ('staging', 'production')),
  highest_sequence INTEGER NOT NULL CHECK (highest_sequence >= 0),
  highest_catalog_sha256 TEXT,
  cached_catalog_json TEXT,
  cached_catalog_sha256 TEXT,
  etag TEXT,
  source_url TEXT,
  fetched_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kernel_runtime_versions (
  kernel_id TEXT NOT NULL,
  artifact_version TEXT NOT NULL,
  platform TEXT NOT NULL,
  arch TEXT NOT NULL,
  archive_sha256 TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('verified', 'quarantined', 'trash')),
  manifest_json TEXT NOT NULL,
  installed_at TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  last_scan_at TEXT,
  quarantine_reason TEXT,
  PRIMARY KEY (kernel_id, artifact_version)
);

CREATE TABLE IF NOT EXISTS kernel_activation_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kernel_id TEXT NOT NULL,
  from_version TEXT,
  to_version TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('install', 'update', 'rollback', 'repair', 'recovery')),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS kernel_activation_history_kernel
  ON kernel_activation_history(kernel_id, id DESC);

CREATE TABLE IF NOT EXISTS kernel_projections (
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  kernel_id TEXT NOT NULL,
  desired_version INTEGER NOT NULL,
  applied_version INTEGER,
  status TEXT NOT NULL,
  native_id TEXT,
  error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (entity_type, entity_id, kernel_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS kernel_agent_native_identity
  ON kernel_projections(kernel_id, native_id)
  WHERE entity_type = 'agent' AND native_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS kernel_skill_native_identity
  ON kernel_projections(kernel_id, native_id)
  WHERE entity_type = 'skill' AND native_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  desired_state_json TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS operation_target_identity
  ON operations(kind, target_type, target_id, id);

CREATE INDEX IF NOT EXISTS conversations_updated_keyset
  ON conversations(updated_at DESC, id DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS conversations_parent_branch
  ON conversations(parent_conversation_id, branched_from_turn_id);

CREATE INDEX IF NOT EXISTS runs_conversation_created
  ON runs(conversation_id, created_at, id);

CREATE INDEX IF NOT EXISTS usage_entries_recorded
  ON usage_entries(recorded_at, kernel_id, provider_id, model_id);

CREATE INDEX IF NOT EXISTS blob_refs_hash
  ON blob_refs(blob_hash);

CREATE INDEX IF NOT EXISTS channel_messages_conversation
  ON channel_messages(conversation_id, created_at, id);

CREATE INDEX IF NOT EXISTS channel_messages_external_conversation
  ON channel_messages(account_id, external_conversation_id, created_at, id);

CREATE INDEX IF NOT EXISTS channel_delivery_pending
  ON channel_messages(status, updated_at, id)
  WHERE direction = 'outbound';

CREATE VIRTUAL TABLE IF NOT EXISTS conversation_fts USING fts5(
  conversation_id UNINDEXED,
  turn_id UNINDEXED,
  title,
  content,
  tokenize = 'unicode61'
);
`;

export const MIGRATION_2_SQL = `
CREATE TABLE IF NOT EXISTS usage_entries (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  event_key TEXT NOT NULL,
  kernel_id TEXT NOT NULL,
  provider_id TEXT,
  model_id TEXT,
  request_id TEXT,
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cache_read_tokens INTEGER CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0),
  cache_write_tokens INTEGER CHECK (cache_write_tokens IS NULL OR cache_write_tokens >= 0),
  cost_usd REAL CHECK (cost_usd IS NULL OR cost_usd >= 0),
  recorded_at TEXT NOT NULL,
  UNIQUE (run_id, event_key)
);
CREATE TABLE IF NOT EXISTS attachment_access_grants (
  id TEXT PRIMARY KEY,
  blob_hash TEXT NOT NULL REFERENCES blob_objects(hash) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kernel_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS channel_owner_leases (
  account_id TEXT PRIMARY KEY REFERENCES channel_accounts(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  kernel_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  lease_expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS conversations_updated_keyset
  ON conversations(updated_at DESC, id DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS runs_conversation_created
  ON runs(conversation_id, created_at, id);
CREATE INDEX IF NOT EXISTS usage_entries_recorded
  ON usage_entries(recorded_at, kernel_id, provider_id, model_id);
CREATE INDEX IF NOT EXISTS blob_refs_hash ON blob_refs(blob_hash);
`;

export const MIGRATION_3_SQL = `
ALTER TABLE kernel_installations ADD COLUMN last_error TEXT;
CREATE TABLE IF NOT EXISTS kernel_catalog_state (
  channel TEXT PRIMARY KEY CHECK (channel IN ('staging', 'production')),
  highest_sequence INTEGER NOT NULL CHECK (highest_sequence >= 0),
  highest_catalog_sha256 TEXT,
  cached_catalog_json TEXT,
  cached_catalog_sha256 TEXT,
  etag TEXT,
  source_url TEXT,
  fetched_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kernel_runtime_versions (
  kernel_id TEXT NOT NULL,
  artifact_version TEXT NOT NULL,
  platform TEXT NOT NULL,
  arch TEXT NOT NULL,
  archive_sha256 TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('verified', 'quarantined', 'trash')),
  manifest_json TEXT NOT NULL,
  installed_at TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  last_scan_at TEXT,
  quarantine_reason TEXT,
  PRIMARY KEY (kernel_id, artifact_version)
);
CREATE TABLE IF NOT EXISTS kernel_activation_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kernel_id TEXT NOT NULL,
  from_version TEXT,
  to_version TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('install', 'update', 'rollback', 'repair', 'recovery')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS kernel_activation_history_kernel
  ON kernel_activation_history(kernel_id, id DESC);
`;

/**
 * Canonical Cron became the only scheduler authority in schema v4.  These
 * columns deliberately hold ClawX domain values rather than an OpenClaw or
 * DeepSeek native job document so another kernel can use the same rows.
 */
export const MIGRATION_4_SQL = `
ALTER TABLE cron_jobs ADD COLUMN prompt TEXT NOT NULL DEFAULT '';
ALTER TABLE cron_jobs ADD COLUMN conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL;
ALTER TABLE cron_jobs ADD COLUMN misfire_policy TEXT NOT NULL DEFAULT 'run-once';
ALTER TABLE cron_jobs ADD COLUMN overlap_policy TEXT NOT NULL DEFAULT 'skip';
ALTER TABLE cron_jobs ADD COLUMN next_run_at TEXT;
CREATE INDEX IF NOT EXISTS cron_jobs_due
  ON cron_jobs(enabled, next_run_at, id);
CREATE INDEX IF NOT EXISTS cron_admissions_job_time
  ON cron_admissions(job_id, scheduled_for DESC);
CREATE INDEX IF NOT EXISTS cron_runs_status
  ON cron_runs(status, started_at, id);
`;

export const MIGRATION_5_SQL = `
ALTER TABLE runs ADD COLUMN workspace_uri TEXT;
`;

export const MIGRATION_6_SQL = `
ALTER TABLE conversations ADD COLUMN parent_conversation_id TEXT REFERENCES conversations(id) ON DELETE RESTRICT;
ALTER TABLE conversations ADD COLUMN branched_from_turn_id TEXT REFERENCES turns(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS conversations_parent_branch
  ON conversations(parent_conversation_id, branched_from_turn_id);
`;

/** Provider metadata and defaults became canonical, kernel-scoped state in v7. */
export const MIGRATION_7_SQL = `
ALTER TABLE providers ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0);
CREATE TABLE IF NOT EXISTS provider_defaults (
  kernel_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  model_id TEXT,
  updated_at TEXT NOT NULL
);
`;

/** Agent metadata, defaults and immutable run composition became canonical in v8. */
export const MIGRATION_8_SQL = `
ALTER TABLE agents ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0);
ALTER TABLE agents ADD COLUMN deleted_at TEXT;
ALTER TABLE runs ADD COLUMN agent_snapshot_json TEXT;
CREATE TABLE IF NOT EXISTS agent_defaults (
  kernel_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS kernel_agent_native_identity
  ON kernel_projections(kernel_id, native_id)
  WHERE entity_type = 'agent' AND native_id IS NOT NULL;
`;

/** Skill packages, desired kernel installs and compatibility became canonical in v9. */
export const MIGRATION_9_SQL = `
ALTER TABLE skills ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0);
ALTER TABLE skills ADD COLUMN deleted_at TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS kernel_skill_native_identity
  ON kernel_projections(kernel_id, native_id)
  WHERE entity_type = 'skill' AND native_id IS NOT NULL;
`;

/** Canonical Channel ownership, bindings, identity and delivery became authoritative in v10. */
export const MIGRATION_10_SQL = `
ALTER TABLE channel_accounts ADD COLUMN native_account_id TEXT;
ALTER TABLE channel_accounts ADD COLUMN canonical_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE channel_accounts ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1));
ALTER TABLE channel_accounts ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0);
ALTER TABLE channel_accounts ADD COLUMN deleted_at TEXT;
UPDATE channel_accounts SET native_account_id = id WHERE native_account_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS channel_account_native_identity
  ON channel_accounts(channel_type, native_account_id);
ALTER TABLE channel_bindings ADD COLUMN conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL;
ALTER TABLE channel_bindings ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0);
ALTER TABLE channel_messages ADD COLUMN external_conversation_id TEXT NOT NULL DEFAULT '';
ALTER TABLE channel_messages ADD COLUMN status TEXT NOT NULL DEFAULT 'admitted';
ALTER TABLE channel_messages ADD COLUMN updated_at TEXT;
UPDATE channel_messages SET updated_at = created_at WHERE updated_at IS NULL;
ALTER TABLE channel_messages ADD COLUMN run_id TEXT REFERENCES runs(id) ON DELETE SET NULL;
ALTER TABLE delivery_attempts ADD COLUMN next_retry_at TEXT;
CREATE INDEX IF NOT EXISTS channel_messages_conversation
  ON channel_messages(conversation_id, created_at, id);
CREATE INDEX IF NOT EXISTS channel_messages_external_conversation
  ON channel_messages(account_id, external_conversation_id, created_at, id);
CREATE INDEX IF NOT EXISTS channel_delivery_pending
  ON channel_messages(status, updated_at, id)
  WHERE direction = 'outbound';
`;

/**
 * v10 added external_conversation_id to an existing table, but SQLite cannot
 * remove its older, overly broad UNIQUE(account, message, direction)
 * constraint with ALTER TABLE. Rebuild both related tables while preserving
 * admitted messages and delivery attempts.
 */
export const MIGRATION_11_SQL = `
CREATE TABLE channel_messages_v11 (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
  external_conversation_id TEXT NOT NULL,
  external_message_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (account_id, external_conversation_id, external_message_id, direction)
);
INSERT INTO channel_messages_v11(
  id, account_id, external_conversation_id, external_message_id,
  conversation_id, turn_id, run_id, direction, payload_json,
  status, created_at, updated_at
)
SELECT
  id, account_id, external_conversation_id, external_message_id,
  conversation_id, turn_id, run_id, direction, payload_json,
  status, created_at, COALESCE(updated_at, created_at)
FROM channel_messages;

CREATE TABLE delivery_attempts_v11 (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES channel_messages_v11(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  status TEXT NOT NULL,
  error TEXT,
  next_retry_at TEXT,
  attempted_at TEXT NOT NULL,
  UNIQUE (message_id, attempt)
);
INSERT INTO delivery_attempts_v11(
  id, message_id, attempt, status, error, next_retry_at, attempted_at
)
SELECT id, message_id, attempt, status, error, next_retry_at, attempted_at
FROM delivery_attempts;

DROP TABLE delivery_attempts;
DROP TABLE channel_messages;
ALTER TABLE channel_messages_v11 RENAME TO channel_messages;
ALTER TABLE delivery_attempts_v11 RENAME TO delivery_attempts;

CREATE INDEX channel_messages_conversation
  ON channel_messages(conversation_id, created_at, id);
CREATE INDEX channel_messages_external_conversation
  ON channel_messages(account_id, external_conversation_id, created_at, id);
CREATE INDEX channel_delivery_pending
  ON channel_messages(status, updated_at, id)
  WHERE direction = 'outbound';
`;

/** Main-owned scheduling, immutable admission snapshots and leader lease. */
export const MIGRATION_12_SQL = `
ALTER TABLE cron_jobs ADD COLUMN timeout_ms INTEGER NOT NULL DEFAULT 1800000 CHECK (timeout_ms >= 1000);
ALTER TABLE cron_jobs ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0);
ALTER TABLE cron_admissions ADD COLUMN trigger_kind TEXT NOT NULL DEFAULT 'scheduled';
ALTER TABLE cron_admissions ADD COLUMN snapshot_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE cron_runs ADD COLUMN diagnostic_json TEXT;
ALTER TABLE cron_runs ADD COLUMN delivery_message_id TEXT REFERENCES channel_messages(id) ON DELETE SET NULL;
CREATE TABLE IF NOT EXISTS scheduler_leases (
  name TEXT PRIMARY KEY CHECK (name = 'clawx-scheduler'),
  owner_id TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS cron_runs_delivery_message
  ON cron_runs(delivery_message_id)
  WHERE delivery_message_id IS NOT NULL;
`;

/**
 * Live per-call Usage keeps unknown values nullable and records provenance.
 *
 * Columns are deliberately separate from the data migration. SQLite does not
 * support `ADD COLUMN IF NOT EXISTS`, and development/preview databases can
 * legitimately contain a subset of the v13 columns before their user_version
 * is advanced. The store probes `PRAGMA table_info` and applies only missing
 * definitions before running MIGRATION_13_SQL.
 */
export const MIGRATION_13_COLUMNS = {
  total_tokens: 'INTEGER CHECK (total_tokens IS NULL OR total_tokens >= 0)',
  cost_amount: 'REAL CHECK (cost_amount IS NULL OR cost_amount >= 0)',
  currency: 'TEXT',
  source: "TEXT NOT NULL DEFAULT 'runtime-event' CHECK (source IN ('runtime-event', 'provider-response'))",
} as const;

export const MIGRATION_13_SQL = `
UPDATE usage_entries
SET cost_amount = cost_usd, currency = 'USD'
WHERE cost_usd IS NOT NULL AND cost_amount IS NULL;
`;
