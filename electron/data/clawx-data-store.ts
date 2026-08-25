import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { backup, DatabaseSync } from 'node:sqlite';
import type {
  AdmitRunInput,
  BranchConversationInput,
  CanonicalContentBlock,
  CommitTerminalRunInput,
  ConversationExport,
  ConversationId,
  ConversationPage,
  ConversationQueryFilters,
  ConversationSummary,
  KernelContextBlock,
  KernelContextSnapshotV1,
  RunId,
} from '@shared/conversations/contracts';
import { asConversationId, asRunId, asTurnId } from '@shared/conversations/contracts';
export type { ConversationExport, ConversationPage, ConversationSummary } from '@shared/conversations/contracts';
import type { KernelEventEnvelopeV1, KernelId } from '@shared/kernels/contracts';
import type {
  CanonicalCronAdmission,
  CanonicalCronJob,
  CanonicalCronRun,
  SchedulerLeaderLease,
  SchedulerLeaderLeaseAcquireResult,
} from '@shared/domains/cron';
import type {
  CanonicalProviderAccount,
  KernelProviderDefault,
} from '@shared/domains/providers';
import type {
  AgentRunSnapshot,
  CanonicalAgent,
  KernelAgentDefault,
} from '@shared/domains/agents';
import type { CanonicalSkill } from '@shared/domains/skills';
import type {
  CanonicalChannelAccount,
  CanonicalChannelBinding,
  CanonicalChannelDeliveryAttempt,
  CanonicalChannelMessage,
  ChannelMessageAdmissionInput,
  ChannelMessageAdmissionResult,
  ChannelMessageStatus,
  ChannelOwnerLease,
  ChannelOwnerLeaseAcquireResult,
} from '@shared/domains/channels';
import { asCredentialReference } from '@shared/domains/providers';
import {
  asAgentId,
  asChannelAccountId,
  asChannelBindingId,
  asProviderAccountId,
  asSkillId,
} from '@shared/domains/identity';
import type {
  KernelActivationHistoryRecord,
  KernelCatalogStateRecord,
  KernelInstallationRecord,
  KernelRuntimeVersionRecord,
} from '@shared/kernels/package-manager';
import {
  CLAWX_DATA_SCHEMA_VERSION,
  INITIAL_SCHEMA_SQL,
  MIGRATION_2_SQL,
  MIGRATION_3_SQL,
  MIGRATION_4_SQL,
  MIGRATION_5_SQL,
  MIGRATION_6_SQL,
  MIGRATION_7_SQL,
  MIGRATION_8_SQL,
  MIGRATION_9_SQL,
  MIGRATION_10_SQL,
  MIGRATION_11_SQL,
  MIGRATION_12_SQL,
  MIGRATION_13_COLUMNS,
  MIGRATION_13_SQL,
} from './schema';

type SqlValue = string | number | bigint | null | Uint8Array;

export type DataStoreFaultInjector = {
  beforeWrite?(operation: string): void;
};

export type CreateConversationInput = {
  id: ConversationId;
  title?: string;
  createdAt: string;
};

type RunIdentityRow = {
  id: string;
  conversation_id: string;
  turn_id: string;
  kernel_id: string;
  generation: number;
  status: string;
  last_event_seq: number;
};

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parseJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : null;
}

function checksum(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertPositiveGeneration(generation: number): void {
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    throw new Error(`Kernel generation must be a positive safe integer: ${generation}`);
  }
}

function assertBlock(block: CanonicalContentBlock): void {
  if (!block.id.trim() || !block.type || !block.visibility) {
    throw new Error('Content block identity, type, and visibility are required');
  }
  if (block.visibility === 'kernel' && !block.kernelId) {
    throw new Error(`Kernel-visible block ${block.id} must declare kernelId`);
  }
  if (block.blobHash && (block.text !== undefined || block.json !== undefined)) {
    throw new Error(`Blob-backed block ${block.id} cannot also inline content`);
  }
  if (block.visibility === 'secret') {
    const secret = block.json as Record<string, unknown> | undefined;
    const safeReference = secret
      && Object.keys(secret).length === 1
      && typeof secret.credentialRef === 'string'
      && /^(keychain|credential):\/\//.test(secret.credentialRef);
    if (block.text !== undefined || block.blobHash !== undefined || !safeReference) {
      throw new Error(`Secret block ${block.id} may persist only an opaque keychain credentialRef`);
    }
  }
}

const SENSITIVE_PROVIDER_METADATA_KEY = /(?:^|[-_])(api[-_]?key|secret|password|access[-_]?token|refresh[-_]?token|authorization|cookie)(?:$|[-_])/i;
const SENSITIVE_PROVIDER_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)$/i;

function assertCanonicalProviderAccount(account: CanonicalProviderAccount): void {
  if (!account.id.trim() || !account.providerId.trim() || !account.displayName.trim()) {
    throw new Error('Provider account id, provider id and display name are required');
  }
  if (!Number.isSafeInteger(account.version) || account.version < 1) {
    throw new Error('Provider account version must be a positive safe integer');
  }
  if (account.credentialRef !== undefined) asCredentialReference(account.credentialRef);
  for (const key of Object.keys(account.metadata)) {
    if (SENSITIVE_PROVIDER_METADATA_KEY.test(key)) {
      throw new Error(`Provider metadata cannot persist secret-bearing field: ${key}`);
    }
  }
  for (const key of Object.keys(account.headers ?? {})) {
    if (SENSITIVE_PROVIDER_HEADER.test(key)) {
      throw new Error(`Provider header ${key} must be stored through CredentialBroker, not SQLite`);
    }
  }
  const seenModels = new Set<string>();
  for (const model of account.models) {
    if (!model.modelId.trim() || !model.providerId.trim() || seenModels.has(model.modelId)) {
      throw new Error('Provider model ids must be non-empty and unique within an account');
    }
    seenModels.add(model.modelId);
  }
}

function assertCanonicalAgent(agent: CanonicalAgent): void {
  if (!agent.id.trim() || !agent.displayName.trim() || !agent.workspaceUri.trim()) {
    throw new Error('Agent id, display name and workspace URI are required');
  }
  if (!Number.isSafeInteger(agent.version) || agent.version < 1) {
    throw new Error('Agent version must be a positive safe integer');
  }
  try {
    const workspace = new URL(agent.workspaceUri);
    if (!workspace.protocol) throw new Error('missing protocol');
  } catch {
    throw new Error('Agent workspaceUri must be an absolute URI');
  }
  const kernels = new Set<string>();
  for (const kernelId of agent.supportedKernels) {
    if (!kernelId.trim() || kernels.has(kernelId)) {
      throw new Error('Agent supported kernels must be non-empty and unique');
    }
    kernels.add(kernelId);
  }
  if (kernels.size === 0) throw new Error('Agent must support at least one kernel');
  for (const kernelId of agent.defaultForKernels) {
    if (!kernels.has(kernelId)) throw new Error(`Agent cannot be default for unsupported kernel: ${kernelId}`);
  }
}

function assertCanonicalSkill(skill: CanonicalSkill): void {
  if (!skill.id.trim() || !skill.slug.trim() || !skill.displayName.trim() || !skill.source.locator.trim()) {
    throw new Error('Skill id, slug, display name and canonical source locator are required');
  }
  if (!Number.isSafeInteger(skill.revision) || skill.revision < 1) {
    throw new Error('Skill revision must be a positive safe integer');
  }
  if (skill.source.digestSha256 && !/^[a-f0-9]{64}$/i.test(skill.source.digestSha256)) {
    throw new Error('Skill source digest must be a SHA-256 hex string');
  }
  const installed = new Set<string>();
  for (const kernelId of skill.installedForKernels) {
    if (!kernelId.trim() || installed.has(kernelId)) throw new Error('Skill installed kernels must be non-empty and unique');
    installed.add(kernelId);
  }
  for (const kernelId of skill.enabledForKernels) {
    if (!installed.has(kernelId)) throw new Error(`Skill cannot be enabled for an uninstalled kernel: ${kernelId}`);
  }
  const compatible = new Set<string>();
  for (const entry of skill.compatibility) {
    if (!entry.kernelId.trim() || compatible.has(entry.kernelId)) {
      throw new Error('Skill compatibility kernels must be non-empty and unique');
    }
    compatible.add(entry.kernelId);
    if (!entry.compatible && !entry.reason?.trim()) {
      throw new Error(`Incompatible Skill projection requires a reason: ${entry.kernelId}`);
    }
  }
}

function isSensitiveChannelKey(key: string): boolean {
  const parts = key
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (parts.some(part => ['secret', 'password', 'authorization', 'cookie'].includes(part))) return true;
  if (parts.at(-1) === 'token') return true;
  return parts.some((part, index) => part === 'api' && parts[index + 1] === 'key');
}

function assertNoChannelSecrets(value: unknown, path = 'channel.config'): void {
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') return;
  if (typeof value === 'string') return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoChannelSecrets(entry, `${path}[${index}]`));
    return;
  }
  if (typeof value !== 'object' || value instanceof Uint8Array) {
    throw new Error(`${path} contains an unsupported value`);
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveChannelKey(key)) {
      throw new Error(`Channel secrets cannot be persisted in SQLite: ${path}.${key}`);
    }
    assertNoChannelSecrets(entry, `${path}.${key}`);
  }
}

function assertCanonicalChannelAccount(account: CanonicalChannelAccount): void {
  if (!account.id.trim() || !account.channelType.trim() || !account.nativeAccountId.trim() || !account.displayName.trim()) {
    throw new Error('Channel account canonical, channel, native and display identities are required');
  }
  if (!Number.isSafeInteger(account.revision) || account.revision < 1) {
    throw new Error('Channel account revision must be a positive safe integer');
  }
  if (account.credentialRef !== undefined && !/^channel-credential:\/\/[A-Za-z0-9%._~!$&'()*+,;=:@-]+$/.test(account.credentialRef)) {
    throw new Error('Channel credentialRef must be an opaque channel-credential reference');
  }
  assertNoChannelSecrets(account.config);
  const kernels = new Set<string>();
  for (const kernelId of account.supportedKernels) {
    if (!kernelId.trim() || kernels.has(kernelId)) throw new Error('Channel supported kernels must be unique');
    kernels.add(kernelId);
  }
  if (kernels.size === 0) throw new Error('Channel account must support at least one kernel');
}

function assertCanonicalChannelBinding(binding: CanonicalChannelBinding): void {
  if (!binding.id.trim() || !binding.accountId.trim() || !binding.targetId.trim()
    || !binding.kernelId.trim() || !binding.agentId.trim()) {
    throw new Error('Channel binding identity, account, target, kernel and agent are required');
  }
  if (!Number.isSafeInteger(binding.revision) || binding.revision < 1) {
    throw new Error('Channel binding revision must be a positive safe integer');
  }
}

function assertAgentRunSnapshot(input: AdmitRunInput['routing']): void {
  const snapshot = input.agentSnapshot;
  if (!snapshot || snapshot.agentId !== input.agentId || snapshot.kernelId !== input.kernelId) {
    throw new Error('Run Agent snapshot identity does not match routing');
  }
  if (snapshot.workspaceUri !== input.workspaceUri) {
    throw new Error('Run Agent snapshot workspace does not match routing');
  }
  if (!Number.isSafeInteger(snapshot.canonicalVersion) || snapshot.canonicalVersion < 1) {
    throw new Error('Run Agent snapshot version must be a positive safe integer');
  }
  if (snapshot.model) {
    const providerId = snapshot.model.providerAccountId ?? snapshot.model.providerId;
    if (input.providerId !== providerId || input.modelId !== snapshot.model.modelId) {
      throw new Error('Run Agent snapshot model does not match routing');
    }
  }
}

export class ClawXDataStore {
  private readonly db: DatabaseSync;

  constructor(
    readonly databasePath: string,
    private readonly faults: DataStoreFaultInjector = {},
  ) {
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    try { chmodSync(dirname(databasePath), 0o700); } catch { /* Windows ACLs are handled by the owner process. */ }
    this.db = new DatabaseSync(databasePath);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;');
    try {
      this.migrate();
      this.enforceOwnerFileMode();
      this.recoverInterruptedRuns();
      this.recoverInterruptedCronRuns();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private migrate(): void {
    const current = Number((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    if (current > CLAWX_DATA_SCHEMA_VERSION) {
      throw new Error(`ClawX database schema ${current} is newer than supported ${CLAWX_DATA_SCHEMA_VERSION}`);
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(INITIAL_SCHEMA_SQL);
      if (current > 0 && current < 2) this.db.exec(MIGRATION_2_SQL);
      if (current > 0 && current < 3) this.db.exec(MIGRATION_3_SQL);
      if (current > 0 && current < 4) this.db.exec(MIGRATION_4_SQL);
      if (current > 0 && current < 5) this.db.exec(MIGRATION_5_SQL);
      if (current > 0 && current < 6) this.db.exec(MIGRATION_6_SQL);
      if (current > 0 && current < 7) this.db.exec(MIGRATION_7_SQL);
      if (current > 0 && current < 8) this.db.exec(MIGRATION_8_SQL);
      if (current > 0 && current < 9) this.db.exec(MIGRATION_9_SQL);
      if (current > 0 && current < 10) this.db.exec(MIGRATION_10_SQL);
      if (current > 0 && current < 11) this.db.exec(MIGRATION_11_SQL);
      if (current > 0 && current < 12) this.db.exec(MIGRATION_12_SQL);
      if (current > 0 && current < 13) this.migrateUsageSchemaV13();
      this.db.prepare(`
        INSERT INTO schema_migrations(version, applied_at, checksum)
        VALUES (?, ?, ?)
        ON CONFLICT(version) DO UPDATE SET checksum = excluded.checksum
      `).run(CLAWX_DATA_SCHEMA_VERSION, new Date().toISOString(), checksum(INITIAL_SCHEMA_SQL));
      this.db.exec(`PRAGMA user_version = ${CLAWX_DATA_SCHEMA_VERSION}`);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private migrateUsageSchemaV13(): void {
    const existingColumns = new Set(
      (this.db.prepare('PRAGMA table_info(usage_entries)').all() as Array<{ name: string }>)
        .map(column => column.name),
    );
    for (const [name, definition] of Object.entries(MIGRATION_13_COLUMNS)) {
      if (!existingColumns.has(name)) {
        this.db.exec(`ALTER TABLE usage_entries ADD COLUMN ${name} ${definition}`);
      }
    }
    this.db.exec(MIGRATION_13_SQL);
  }

  private enforceOwnerFileMode(): void {
    for (const path of [this.databasePath, `${this.databasePath}-wal`, `${this.databasePath}-shm`]) {
      if (!existsSync(path)) continue;
      try { chmodSync(path, 0o600); } catch { /* Best effort on Windows; ACL validation is platform-specific. */ }
    }
  }

  private write<T>(operation: string, callback: () => T): T {
    this.faults.beforeWrite?.(operation);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private recoverInterruptedRuns(): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE runs
      SET status = 'interrupted', completed_at = ?, outcome_error = 'DataService restarted before terminal commit'
      WHERE status IN ('admitted', 'running', 'cancelling')
    `).run(now);
  }

  private recoverInterruptedCronRuns(): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE cron_runs
      SET status = 'failed', completed_at = ?,
        error = 'ClawXScheduler restarted before terminal commit',
        diagnostic_json = ?
      WHERE status IN ('admitted', 'running')
    `).run(now, json({
      code: 'SCHEDULER_RESTARTED',
      message: 'ClawXScheduler restarted before terminal commit',
      retryable: true,
    }));
  }

  createConversation(input: CreateConversationInput): void {
    this.write('conversation.create', () => {
      this.db.prepare(`
        INSERT INTO conversations(id, title, created_at, updated_at)
        VALUES (?, ?, ?, ?)
      `).run(input.id, input.title?.trim() || null, input.createdAt, input.createdAt);
      this.refreshConversationSearch(input.id);
    });
  }

  branchConversation(input: BranchConversationInput): ConversationSummary {
    if (input.sourceConversationId === input.branchConversationId) {
      throw new Error('A Conversation branch must have a distinct identity');
    }
    const source = this.exportConversation(input.sourceConversationId);
    const branchTurn = source.turns.find(turn => turn.id === input.sourceTurnId);
    if (!branchTurn) {
      throw new Error(`Branch source turn is not in Conversation history: ${input.sourceTurnId}`);
    }
    if (branchTurn.role !== 'assistant') {
      throw new Error('A Conversation may branch only from a completed assistant turn');
    }
    this.write('conversation.branch', () => {
      this.db.prepare(`
        INSERT INTO conversations(
          id, title, parent_conversation_id, branched_from_turn_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        input.branchConversationId,
        input.title?.trim() || source.conversation.title || null,
        input.sourceConversationId,
        input.sourceTurnId,
        input.createdAt,
        input.createdAt,
      );
      this.refreshConversationSearch(input.branchConversationId);
    });
    return this.getConversation(input.branchConversationId)!;
  }

  getConversation(id: ConversationId): ConversationSummary | undefined {
    const row = this.db.prepare(`
      SELECT c.id, c.title, c.created_at, c.updated_at, c.pinned_at,
        c.parent_conversation_id, c.branched_from_turn_id,
        (SELECT r.workspace_uri FROM runs r WHERE r.conversation_id = c.id ORDER BY r.created_at DESC, r.id DESC LIMIT 1) AS workspace_uri,
        (SELECT r.kernel_id FROM runs r WHERE r.conversation_id = c.id ORDER BY r.created_at DESC, r.id DESC LIMIT 1) AS last_kernel_id,
        (SELECT GROUP_CONCAT(DISTINCT r.kernel_id) FROM runs r WHERE r.conversation_id = c.id) AS kernel_ids,
        (SELECT r.agent_id FROM runs r WHERE r.conversation_id = c.id ORDER BY r.created_at DESC, r.id DESC LIMIT 1) AS last_agent_id,
        (SELECT ca.channel_type FROM channel_messages cm JOIN channel_accounts ca ON ca.id = cm.account_id
          WHERE cm.conversation_id = c.id ORDER BY cm.created_at DESC, cm.id DESC LIMIT 1) AS source_channel,
        EXISTS(SELECT 1 FROM runs r WHERE r.conversation_id = c.id AND r.status IN ('admitted', 'running', 'cancelling')) AS has_active_run
      FROM conversations c
      WHERE c.id = ? AND c.deleted_at IS NULL
    `).get(id) as {
      id: string; title: string | null; created_at: string; updated_at: string; pinned_at: string | null;
      workspace_uri: string | null; last_kernel_id: string | null; kernel_ids: string | null;
      last_agent_id: string | null; source_channel: string | null; has_active_run: number;
      parent_conversation_id: string | null; branched_from_turn_id: string | null;
    } | undefined;
    if (!row) return undefined;
    return {
      id: row.id as ConversationId,
      ...(row.title ? { title: row.title } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.pinned_at ? { pinnedAt: row.pinned_at } : {}),
      ...(row.workspace_uri ? { workspaceUri: row.workspace_uri } : {}),
      ...(row.last_kernel_id ? { lastKernelId: row.last_kernel_id } : {}),
      ...(row.kernel_ids ? { kernelIds: row.kernel_ids.split(',') } : {}),
      ...(row.last_agent_id ? { lastAgentId: row.last_agent_id } : {}),
      ...(row.source_channel ? { sourceChannel: row.source_channel } : {}),
      ...(row.has_active_run ? { hasActiveRun: true } : {}),
      ...(row.parent_conversation_id ? {
        parentConversationId: row.parent_conversation_id as ConversationId,
      } : {}),
      ...(row.branched_from_turn_id ? {
        branchedFromTurnId: row.branched_from_turn_id as ConversationSummary['branchedFromTurnId'],
      } : {}),
    };
  }

  listConversations(
    input: ConversationQueryFilters & { limit?: number; cursor?: string } = {},
  ): ConversationPage {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    let cursor: {
      pinnedRank: 0 | 1;
      pinnedAt: string;
      updatedAt: string;
      id: string;
    } | undefined;
    if (input.cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
        if ((decoded.pinnedRank !== 0 && decoded.pinnedRank !== 1)
          || typeof decoded.pinnedAt !== 'string'
          || typeof decoded.updatedAt !== 'string'
          || typeof decoded.id !== 'string'
          || !decoded.updatedAt
          || !decoded.id
          || (decoded.pinnedRank === 1) !== Boolean(decoded.pinnedAt)) {
          throw new Error('Malformed cursor');
        }
        cursor = decoded as typeof cursor;
      } catch {
        throw new Error('Invalid conversation page cursor');
      }
    }
    const rows = this.db.prepare(`
      SELECT c.id, c.title, c.created_at, c.updated_at, c.pinned_at,
        c.parent_conversation_id, c.branched_from_turn_id,
        (SELECT r.workspace_uri FROM runs r WHERE r.conversation_id = c.id ORDER BY r.created_at DESC, r.id DESC LIMIT 1) AS workspace_uri,
        (SELECT r.kernel_id FROM runs r WHERE r.conversation_id = c.id ORDER BY r.created_at DESC, r.id DESC LIMIT 1) AS last_kernel_id,
        (SELECT GROUP_CONCAT(DISTINCT r.kernel_id) FROM runs r WHERE r.conversation_id = c.id) AS kernel_ids,
        (SELECT r.agent_id FROM runs r WHERE r.conversation_id = c.id ORDER BY r.created_at DESC, r.id DESC LIMIT 1) AS last_agent_id,
        (SELECT ca.channel_type FROM channel_messages cm JOIN channel_accounts ca ON ca.id = cm.account_id
          WHERE cm.conversation_id = c.id ORDER BY cm.created_at DESC, cm.id DESC LIMIT 1) AS source_channel,
        EXISTS(SELECT 1 FROM runs r WHERE r.conversation_id = c.id AND r.status IN ('admitted', 'running', 'cancelling')) AS has_active_run
      FROM conversations c
      WHERE c.deleted_at IS NULL
        AND (? IS NULL OR (SELECT r.kernel_id FROM runs r WHERE r.conversation_id = c.id ORDER BY r.created_at DESC, r.id DESC LIMIT 1) = ?)
        AND (? IS NULL OR EXISTS(SELECT 1 FROM runs r WHERE r.conversation_id = c.id AND r.kernel_id = ?))
        AND (? IS NULL OR EXISTS(SELECT 1 FROM runs r WHERE r.conversation_id = c.id AND r.agent_id = ?))
        AND (? IS NULL OR EXISTS(
          SELECT 1 FROM channel_messages cm JOIN channel_accounts ca ON ca.id = cm.account_id
          WHERE cm.conversation_id = c.id AND ca.channel_type = ?
        ))
        AND (? IS NULL OR EXISTS(SELECT 1 FROM runs r WHERE r.conversation_id = c.id AND r.workspace_uri = ?))
        AND (? IS NULL OR (CASE WHEN c.pinned_at IS NULL THEN 0 ELSE 1 END) = ?)
        AND (
          ? IS NULL
          OR (CASE WHEN c.pinned_at IS NULL THEN 0 ELSE 1 END) < ?
          OR (
            (CASE WHEN c.pinned_at IS NULL THEN 0 ELSE 1 END) = ?
            AND (
              COALESCE(c.pinned_at, '') < ?
              OR (
                COALESCE(c.pinned_at, '') = ?
                AND (c.updated_at < ? OR (c.updated_at = ? AND c.id < ?))
              )
            )
          )
        )
      ORDER BY
        CASE WHEN c.pinned_at IS NULL THEN 0 ELSE 1 END DESC,
        COALESCE(c.pinned_at, '') DESC,
        c.updated_at DESC,
        c.id DESC
      LIMIT ?
    `).all(
      input.lastKernelId ?? null,
      input.lastKernelId ?? null,
      input.participatedKernelId ?? null,
      input.participatedKernelId ?? null,
      input.agentId ?? null,
      input.agentId ?? null,
      input.sourceChannel ?? null,
      input.sourceChannel ?? null,
      input.workspaceUri ?? null,
      input.workspaceUri ?? null,
      input.pinned === undefined ? null : Number(input.pinned),
      input.pinned === undefined ? null : Number(input.pinned),
      cursor?.pinnedRank ?? null,
      cursor?.pinnedRank ?? null,
      cursor?.pinnedRank ?? null,
      cursor?.pinnedAt ?? null,
      cursor?.pinnedAt ?? null,
      cursor?.updatedAt ?? null,
      cursor?.updatedAt ?? null,
      cursor?.id ?? null,
      limit + 1,
    ) as Array<{
      id: string;
      title: string | null;
      created_at: string;
      updated_at: string;
      pinned_at: string | null;
      workspace_uri: string | null;
      last_kernel_id: string | null;
      kernel_ids: string | null;
      last_agent_id: string | null;
      source_channel: string | null;
      has_active_run: number;
      parent_conversation_id: string | null;
      branched_from_turn_id: string | null;
    }>;
    const page = rows.slice(0, limit);
    const items = page.map(row => ({
      id: row.id as ConversationId,
      ...(row.title ? { title: row.title } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.pinned_at ? { pinnedAt: row.pinned_at } : {}),
      ...(row.workspace_uri ? { workspaceUri: row.workspace_uri } : {}),
      ...(row.last_kernel_id ? { lastKernelId: row.last_kernel_id } : {}),
      ...(row.kernel_ids ? { kernelIds: row.kernel_ids.split(',') } : {}),
      ...(row.last_agent_id ? { lastAgentId: row.last_agent_id } : {}),
      ...(row.source_channel ? { sourceChannel: row.source_channel } : {}),
      ...(row.has_active_run ? { hasActiveRun: true } : {}),
      ...(row.parent_conversation_id ? {
        parentConversationId: row.parent_conversation_id as ConversationId,
      } : {}),
      ...(row.branched_from_turn_id ? {
        branchedFromTurnId: row.branched_from_turn_id as ConversationSummary['branchedFromTurnId'],
      } : {}),
    }));
    const last = page.at(-1);
    return {
      items,
      ...(rows.length > limit && last
        ? {
          nextCursor: Buffer.from(JSON.stringify({
            pinnedRank: last.pinned_at ? 1 : 0,
            pinnedAt: last.pinned_at ?? '',
            updatedAt: last.updated_at,
            id: last.id,
          })).toString('base64url'),
        }
        : {}),
    };
  }

  searchConversations(
    query: string,
    limit = 50,
    filters: ConversationQueryFilters = {},
  ): ConversationSummary[] {
    const normalized = query.trim();
    if (!normalized) return [];
    const ftsQuery = `"${normalized.replaceAll('"', '""')}"`;
    const rows = this.db.prepare(`
      SELECT DISTINCT c.id, c.title, c.created_at, c.updated_at, c.pinned_at,
        c.parent_conversation_id, c.branched_from_turn_id,
        (SELECT r.workspace_uri FROM runs r WHERE r.conversation_id = c.id ORDER BY r.created_at DESC, r.id DESC LIMIT 1) AS workspace_uri,
        (SELECT r.kernel_id FROM runs r WHERE r.conversation_id = c.id ORDER BY r.created_at DESC, r.id DESC LIMIT 1) AS last_kernel_id,
        (SELECT GROUP_CONCAT(DISTINCT r.kernel_id) FROM runs r WHERE r.conversation_id = c.id) AS kernel_ids,
        (SELECT r.agent_id FROM runs r WHERE r.conversation_id = c.id ORDER BY r.created_at DESC, r.id DESC LIMIT 1) AS last_agent_id,
        (SELECT ca.channel_type FROM channel_messages cm JOIN channel_accounts ca ON ca.id = cm.account_id
          WHERE cm.conversation_id = c.id ORDER BY cm.created_at DESC, cm.id DESC LIMIT 1) AS source_channel,
        EXISTS(SELECT 1 FROM runs r WHERE r.conversation_id = c.id AND r.status IN ('admitted', 'running', 'cancelling')) AS has_active_run
      FROM conversation_fts f
      JOIN conversations c ON c.id = f.conversation_id
      WHERE conversation_fts MATCH ? AND c.deleted_at IS NULL
        AND (? IS NULL OR (SELECT r.kernel_id FROM runs r WHERE r.conversation_id = c.id ORDER BY r.created_at DESC, r.id DESC LIMIT 1) = ?)
        AND (? IS NULL OR EXISTS(SELECT 1 FROM runs r WHERE r.conversation_id = c.id AND r.kernel_id = ?))
        AND (? IS NULL OR EXISTS(SELECT 1 FROM runs r WHERE r.conversation_id = c.id AND r.agent_id = ?))
        AND (? IS NULL OR EXISTS(
          SELECT 1 FROM channel_messages cm JOIN channel_accounts ca ON ca.id = cm.account_id
          WHERE cm.conversation_id = c.id AND ca.channel_type = ?
        ))
        AND (? IS NULL OR EXISTS(SELECT 1 FROM runs r WHERE r.conversation_id = c.id AND r.workspace_uri = ?))
        AND (? IS NULL OR (CASE WHEN c.pinned_at IS NULL THEN 0 ELSE 1 END) = ?)
      ORDER BY c.updated_at DESC, c.id DESC
      LIMIT ?
    `).all(
      ftsQuery,
      filters.lastKernelId ?? null,
      filters.lastKernelId ?? null,
      filters.participatedKernelId ?? null,
      filters.participatedKernelId ?? null,
      filters.agentId ?? null,
      filters.agentId ?? null,
      filters.sourceChannel ?? null,
      filters.sourceChannel ?? null,
      filters.workspaceUri ?? null,
      filters.workspaceUri ?? null,
      filters.pinned === undefined ? null : Number(filters.pinned),
      filters.pinned === undefined ? null : Number(filters.pinned),
      Math.min(Math.max(limit, 1), 200),
    ) as Array<{
      id: string;
      title: string | null;
      created_at: string;
      updated_at: string;
      pinned_at: string | null;
      workspace_uri: string | null;
      last_kernel_id: string | null;
      kernel_ids: string | null;
      last_agent_id: string | null;
      source_channel: string | null;
      has_active_run: number;
      parent_conversation_id: string | null;
      branched_from_turn_id: string | null;
    }>;
    return rows.map(row => ({
      id: row.id as ConversationId,
      ...(row.title ? { title: row.title } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.pinned_at ? { pinnedAt: row.pinned_at } : {}),
      ...(row.workspace_uri ? { workspaceUri: row.workspace_uri } : {}),
      ...(row.last_kernel_id ? { lastKernelId: row.last_kernel_id } : {}),
      ...(row.kernel_ids ? { kernelIds: row.kernel_ids.split(',') } : {}),
      ...(row.last_agent_id ? { lastAgentId: row.last_agent_id } : {}),
      ...(row.source_channel ? { sourceChannel: row.source_channel } : {}),
      ...(row.has_active_run ? { hasActiveRun: true } : {}),
      ...(row.parent_conversation_id ? {
        parentConversationId: row.parent_conversation_id as ConversationId,
      } : {}),
      ...(row.branched_from_turn_id ? {
        branchedFromTurnId: row.branched_from_turn_id as ConversationSummary['branchedFromTurnId'],
      } : {}),
    }));
  }

  renameConversation(id: ConversationId, title: string, updatedAt: string): void {
    this.write('conversation.rename', () => {
      const result = this.db.prepare(`
        UPDATE conversations SET title = ?, updated_at = ?, version = version + 1
        WHERE id = ? AND deleted_at IS NULL
      `).run(title.trim() || null, updatedAt, id);
      if (result.changes !== 1) throw new Error(`Conversation not found: ${id}`);
      this.refreshConversationSearch(id);
    });
  }

  pinConversation(id: ConversationId, pinnedAt: string | undefined, updatedAt: string): void {
    this.write('conversation.pin', () => {
      const result = this.db.prepare(`
        UPDATE conversations SET pinned_at = ?, updated_at = ?, version = version + 1
        WHERE id = ? AND deleted_at IS NULL
      `).run(pinnedAt ?? null, updatedAt, id);
      if (result.changes !== 1) throw new Error(`Conversation not found: ${id}`);
    });
  }

  deleteConversation(id: ConversationId, deletedAt: string, hard = false): void {
    this.write('conversation.delete', () => {
      if (hard) {
        const child = this.db.prepare(`
          SELECT id FROM conversations WHERE parent_conversation_id = ? LIMIT 1
        `).get(id) as { id: string } | undefined;
        if (child) {
          throw new Error(`Conversation has branches and cannot be hard deleted: ${id}`);
        }
        this.db.prepare('DELETE FROM conversation_fts WHERE conversation_id = ?').run(id);
        this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
        return;
      }
      const result = this.db.prepare(`
        UPDATE conversations SET deleted_at = ?, updated_at = ?, version = version + 1
        WHERE id = ? AND deleted_at IS NULL
      `).run(deletedAt, deletedAt, id);
      if (result.changes !== 1) throw new Error(`Conversation not found: ${id}`);
      this.db.prepare('DELETE FROM conversation_fts WHERE conversation_id = ?').run(id);
    });
  }

  exportConversation(id: ConversationId, visited = new Set<ConversationId>()): ConversationExport {
    if (visited.has(id)) throw new Error(`Conversation branch lineage contains a cycle: ${id}`);
    visited.add(id);
    const own = this.exportOwnConversation(id);
    const parentId = own.conversation.parentConversationId;
    const sourceTurnId = own.conversation.branchedFromTurnId;
    if (!parentId || !sourceTurnId) return own;

    const parent = this.exportConversation(parentId, visited);
    const sourceIndex = parent.turns.findIndex(turn => turn.id === sourceTurnId);
    if (sourceIndex < 0) {
      throw new Error(`Conversation branch source is unavailable: ${sourceTurnId}`);
    }
    const inheritedTurns = parent.turns.slice(0, sourceIndex + 1);
    const inheritedTurnIds = new Set(inheritedTurns.map(turn => turn.id));
    const inheritedRuns = parent.runs.filter(run => (
      inheritedTurnIds.has(run.turnId)
      && (!run.assistantTurnId || inheritedTurnIds.has(run.assistantTurnId))
    ));
    const inheritedRunIds = new Set(inheritedRuns.map(run => run.id));
    const inheritedUsage = parent.usage.filter(entry => (
      typeof entry.runId === 'string' && inheritedRunIds.has(entry.runId as RunId)
    ));
    const turns = [
      ...inheritedTurns.map((turn, position) => ({ ...turn, position })),
      ...own.turns.map((turn, index) => ({ ...turn, position: inheritedTurns.length + index })),
    ];
    return {
      ...own,
      turns,
      runs: [...inheritedRuns, ...own.runs],
      usage: [...inheritedUsage, ...own.usage],
    };
  }

  private exportOwnConversation(id: ConversationId): ConversationExport {
    const conversation = this.getConversation(id);
    if (!conversation) throw new Error(`Conversation not found: ${id}`);
    const turnRows = this.db.prepare(`
      SELECT id, role, position, created_at FROM turns
      WHERE conversation_id = ? ORDER BY position
    `).all(id) as Array<{ id: string; role: string; position: number; created_at: string }>;
    const blockStatement = this.db.prepare(`
      SELECT id, type, visibility, kernel_id, mime_type, text_content, json_content, blob_hash, revoked_at
      FROM content_blocks WHERE turn_id = ? AND visibility != 'secret' ORDER BY position
    `);
    const turns = turnRows.map(turn => {
      const blocks = (blockStatement.all(turn.id) as Array<Record<string, SqlValue>>).map(row => ({
        id: String(row.id),
        type: String(row.type) as CanonicalContentBlock['type'],
        visibility: String(row.visibility) as CanonicalContentBlock['visibility'],
        ...(row.kernel_id ? { kernelId: String(row.kernel_id) } : {}),
        ...(row.mime_type ? { mimeType: String(row.mime_type) } : {}),
        ...(row.text_content !== null ? { text: String(row.text_content) } : {}),
        ...(row.json_content !== null ? { json: parseJson(row.json_content) } : {}),
        ...(row.blob_hash ? { blobHash: String(row.blob_hash) } : {}),
        ...(row.revoked_at ? { revoked: true } : {}),
      }));
      return { id: turn.id, role: turn.role, position: turn.position, createdAt: turn.created_at, blocks };
    });
    const runRows = this.db.prepare(`
      SELECT r.id, r.turn_id AS turnId,
        (
          SELECT a.id FROM turns u
          JOIN turns a ON a.conversation_id = u.conversation_id
            AND a.position = u.position + 1 AND a.role = 'assistant'
          WHERE u.id = r.turn_id
          LIMIT 1
        ) AS assistantTurnId,
        r.kernel_id AS kernelId, r.kernel_version AS kernelVersion,
        r.generation, r.agent_id AS agentId, r.agent_snapshot_json AS agentSnapshotJson,
        EXISTS(
          SELECT 1 FROM agents canonical_agent
          WHERE canonical_agent.id = r.agent_id AND canonical_agent.deleted_at IS NOT NULL
        ) AS agentDeleted,
        r.workspace_uri AS workspaceUri,
        r.provider_id AS providerId, r.model_id AS modelId,
        r.status, r.created_at AS createdAt, r.started_at AS startedAt, r.completed_at AS completedAt
      FROM runs r WHERE r.conversation_id = ? ORDER BY r.created_at, r.id
    `).all(id) as Array<Record<string, unknown>>;
    const eventStatement = this.db.prepare(`
      SELECT event_seq AS eventSeq, native_event_id AS nativeEventId,
        event_kind AS kind, payload_json AS payloadJson, emitted_at AS emittedAt
      FROM run_events WHERE run_id = ? ORDER BY event_seq
    `);
    const runs = runRows.map((row) => ({
      id: String(row.id) as ConversationExport['runs'][number]['id'],
      turnId: String(row.turnId) as ConversationExport['runs'][number]['turnId'],
      ...(row.assistantTurnId ? {
        assistantTurnId: String(row.assistantTurnId) as ConversationExport['runs'][number]['turnId'],
      } : {}),
      kernelId: String(row.kernelId),
      kernelVersion: String(row.kernelVersion),
      generation: Number(row.generation),
      agentId: String(row.agentId),
      agentSnapshot: row.agentSnapshotJson
        ? {
            ...parseJson(row.agentSnapshotJson) as AgentRunSnapshot,
            ...(Number(row.agentDeleted) === 1 ? { deletedReference: true } : {}),
          }
        : {
            agentId: asAgentId(String(row.agentId)),
            displayName: String(row.agentId),
            kernelId: String(row.kernelId),
            workspaceUri: String(row.workspaceUri ?? ''),
            canonicalVersion: 1,
            deletedReference: true,
          },
      ...(row.workspaceUri ? { workspaceUri: String(row.workspaceUri) } : {}),
      ...(row.providerId ? { providerId: String(row.providerId) } : {}),
      ...(row.modelId ? { modelId: String(row.modelId) } : {}),
      status: String(row.status),
      createdAt: String(row.createdAt),
      ...(row.startedAt ? { startedAt: String(row.startedAt) } : {}),
      ...(row.completedAt ? { completedAt: String(row.completedAt) } : {}),
      events: (eventStatement.all(String(row.id)) as Array<Record<string, SqlValue>>).map(event => ({
        eventSeq: Number(event.eventSeq),
        kind: String(event.kind),
        payload: parseJson(event.payloadJson),
        emittedAt: String(event.emittedAt),
        ...(event.nativeEventId ? { nativeEventId: String(event.nativeEventId) } : {}),
      })),
    }));
    const usage = this.db.prepare(`
      SELECT u.id, u.event_key AS eventKey, u.run_id AS runId, u.kernel_id AS kernelId, u.provider_id AS providerId,
        u.model_id AS modelId, u.input_tokens AS inputTokens, u.output_tokens AS outputTokens,
        u.cache_read_tokens AS cacheReadTokens, u.cache_write_tokens AS cacheWriteTokens,
        u.total_tokens AS totalTokens, COALESCE(u.cost_amount, u.cost_usd) AS cost,
        COALESCE(u.currency, CASE WHEN u.cost_usd IS NOT NULL THEN 'USD' END) AS currency,
        u.source, u.request_id AS requestId, u.recorded_at AS recordedAt
      FROM usage_entries u JOIN runs r ON r.id = u.run_id
      WHERE r.conversation_id = ? ORDER BY u.recorded_at, u.id
    `).all(id) as Array<Record<string, unknown>>;
    return { schema: 'clawx.conversation-export/v1', conversation, turns, runs, usage };
  }

  admitRun(input: AdmitRunInput): void {
    assertPositiveGeneration(input.routing.generation);
    assertAgentRunSnapshot(input.routing);
    if (input.userBlocks.length === 0) throw new Error('Run admission requires at least one user content block');
    for (const block of input.userBlocks) assertBlock(block);

    this.write('run.admit', () => {
      const conversation = this.db.prepare('SELECT id FROM conversations WHERE id = ? AND deleted_at IS NULL').get(input.conversationId);
      if (!conversation) throw new Error(`Conversation not found: ${input.conversationId}`);
      const nextPosition = Number((this.db.prepare(`
        SELECT COALESCE(MAX(position), -1) + 1 AS position FROM turns WHERE conversation_id = ?
      `).get(input.conversationId) as { position: number }).position);
      this.db.prepare(`
        INSERT INTO turns(id, conversation_id, parent_turn_id, role, position, created_at, completed_at)
        VALUES (?, ?, ?, 'user', ?, ?, ?)
      `).run(
        input.turnId,
        input.conversationId,
        input.parentTurnId ?? null,
        nextPosition,
        input.createdAt,
        input.createdAt,
      );
      this.insertBlocks(input.turnId, input.userBlocks, input.createdAt);
      this.db.prepare(`
        INSERT INTO runs(
          id, conversation_id, turn_id, kernel_id, kernel_version, generation,
          agent_id, agent_snapshot_json, workspace_uri, provider_id, model_id,
          context_compiler_version, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'admitted', ?)
      `).run(
        input.runId,
        input.conversationId,
        input.turnId,
        input.routing.kernelId,
        input.routing.kernelVersion,
        input.routing.generation,
        input.routing.agentId,
        json(input.routing.agentSnapshot),
        input.routing.workspaceUri ?? null,
        input.routing.providerId ?? null,
        input.routing.modelId ?? null,
        input.routing.contextCompilerVersion,
        input.createdAt,
      );
      const blockById = new Map(input.userBlocks.map(block => [block.id, block]));
      for (const grant of input.attachmentGrants ?? []) {
        const block = blockById.get(grant.blockId);
        if (!block || block.blobHash !== grant.blobHash) {
          throw new Error(`Attachment grant does not match admitted block: ${grant.blockId}`);
        }
        this.db.prepare(`
          INSERT INTO attachment_access_grants(
            id, blob_hash, run_id, kernel_id, generation, expires_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          grant.id,
          grant.blobHash,
          input.runId,
          input.routing.kernelId,
          input.routing.generation,
          grant.expiresAt,
          input.createdAt,
        );
      }
      this.db.prepare('UPDATE conversations SET updated_at = ?, version = version + 1 WHERE id = ?')
        .run(input.createdAt, input.conversationId);
      this.refreshConversationSearch(input.conversationId);
    });
  }

  markRunStarted(runId: RunId, kernelId: KernelId, generation: number, startedAt: string): void {
    this.write('run.start', () => {
      const result = this.db.prepare(`
        UPDATE runs SET status = 'running', started_at = ?
        WHERE id = ? AND kernel_id = ? AND generation = ? AND status = 'admitted'
      `).run(startedAt, runId, kernelId, generation);
      if (result.changes !== 1) throw new Error(`Run cannot start or identity does not match: ${runId}`);
    });
  }

  appendEvents(envelopes: KernelEventEnvelopeV1[]): { inserted: number; duplicates: number } {
    if (envelopes.length === 0) return { inserted: 0, duplicates: 0 };
    return this.write('event.appendBatch', () => {
      let inserted = 0;
      let duplicates = 0;
      const rows = new Map<string, RunIdentityRow>();
      for (const envelope of envelopes) {
        assertPositiveGeneration(envelope.generation);
        if (!Number.isSafeInteger(envelope.eventSeq) || envelope.eventSeq <= 0) {
          throw new Error(`Invalid event sequence: ${envelope.eventSeq}`);
        }
        let run = rows.get(envelope.runId);
        if (!run) {
          run = this.db.prepare(`
            SELECT id, conversation_id, turn_id, kernel_id, generation, status, last_event_seq
            FROM runs WHERE id = ?
          `).get(envelope.runId) as RunIdentityRow | undefined;
          if (!run) throw new Error(`Run not found: ${envelope.runId}`);
          rows.set(envelope.runId, run);
        }
        if (
          run.conversation_id !== envelope.conversationId
          || run.turn_id !== envelope.turnId
          || run.kernel_id !== envelope.kernelId
          || run.generation !== envelope.generation
        ) {
          throw new Error(`Event identity does not match admitted run: ${envelope.runId}`);
        }
        if (!['admitted', 'running', 'cancelling'].includes(run.status)) {
          throw new Error(`Cannot append event to terminal run: ${envelope.runId}`);
        }
        const existing = this.db.prepare(`
          SELECT event_kind, payload_json, native_event_id FROM run_events
          WHERE run_id = ? AND event_seq = ?
        `).get(envelope.runId, envelope.eventSeq) as {
          event_kind: string;
          payload_json: string;
          native_event_id: string | null;
        } | undefined;
        if (existing) {
          if (
            existing.event_kind !== envelope.event.kind
            || existing.payload_json !== json(envelope.event.payload)
            || existing.native_event_id !== (envelope.nativeEventId ?? null)
          ) {
            throw new Error(`Conflicting replay for ${envelope.runId}:${envelope.eventSeq}`);
          }
          duplicates += 1;
          continue;
        }
        if (envelope.eventSeq !== run.last_event_seq + 1) {
          throw new Error(`Event sequence gap for ${envelope.runId}: expected ${run.last_event_seq + 1}, got ${envelope.eventSeq}`);
        }
        this.db.prepare(`
          INSERT INTO run_events(run_id, event_seq, native_event_id, event_kind, payload_json, emitted_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          envelope.runId,
          envelope.eventSeq,
          envelope.nativeEventId ?? null,
          envelope.event.kind,
          json(envelope.event.payload),
          envelope.emittedAt,
        );
        run.last_event_seq = envelope.eventSeq;
        this.db.prepare('UPDATE runs SET last_event_seq = ? WHERE id = ?').run(run.last_event_seq, envelope.runId);
        this.projectImmediateEvent(envelope);
        inserted += 1;
      }
      return { inserted, duplicates };
    });
  }

  private projectImmediateEvent(envelope: KernelEventEnvelopeV1): void {
    const payload = envelope.event.payload as Record<string, unknown> | undefined;
    if (!payload) return;
    if (envelope.event.kind === 'tool.start') {
      const nativeId = String(payload.toolCallId ?? payload.id ?? '');
      const name = String(payload.name ?? 'unknown');
      if (!nativeId) throw new Error('tool.start requires toolCallId');
      this.db.prepare(`
        INSERT INTO tool_calls(id, run_id, native_call_id, name, status, input_json, started_at)
        VALUES (?, ?, ?, ?, 'running', ?, ?)
        ON CONFLICT(run_id, native_call_id) DO UPDATE SET
          name = excluded.name, status = 'running', input_json = excluded.input_json
      `).run(
        `tool:${envelope.runId}:${nativeId}`,
        envelope.runId,
        nativeId,
        name,
        payload.input === undefined ? null : json(payload.input),
        envelope.emittedAt,
      );
      return;
    }
    if (envelope.event.kind === 'tool.result') {
      const nativeId = String(payload.toolCallId ?? payload.id ?? '');
      if (!nativeId) throw new Error('tool.result requires toolCallId');
      const result = this.db.prepare(`
        UPDATE tool_calls SET status = ?, output_json = ?, completed_at = ?
        WHERE run_id = ? AND native_call_id = ?
      `).run(
        String(payload.status ?? 'completed'),
        payload.output === undefined ? null : json(payload.output),
        envelope.emittedAt,
        envelope.runId,
        nativeId,
      );
      if (result.changes !== 1) throw new Error(`tool.result has no matching tool.start: ${nativeId}`);
      return;
    }
    if (envelope.event.kind === 'permission.request') {
      const nativeId = String(payload.requestId ?? payload.id ?? '');
      if (!nativeId) throw new Error('permission.request requires requestId');
      this.db.prepare(`
        INSERT INTO permissions(id, run_id, native_request_id, kind, request_json, requested_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, native_request_id) DO UPDATE SET request_json = excluded.request_json
      `).run(
        `permission:${envelope.runId}:${nativeId}`,
        envelope.runId,
        nativeId,
        String(payload.kind ?? 'tool'),
        json(payload.request ?? payload),
        envelope.emittedAt,
      );
      return;
    }
    if (envelope.event.kind === 'permission.resolved') {
      const nativeId = String(payload.requestId ?? payload.id ?? '');
      if (!nativeId) throw new Error('permission.resolved requires requestId');
      const result = this.db.prepare(`
        UPDATE permissions SET decision = ?, resolved_at = ?
        WHERE run_id = ? AND native_request_id = ?
      `).run(String(payload.decision ?? 'rejected'), envelope.emittedAt, envelope.runId, nativeId);
      if (result.changes !== 1) throw new Error(`permission.resolved has no matching request: ${nativeId}`);
      return;
    }
    if (envelope.event.kind === 'usage') {
      const cost = typeof payload.cost === 'number'
        ? payload.cost
        : typeof payload.costUsd === 'number' ? payload.costUsd : null;
      const currency = typeof payload.currency === 'string'
        ? payload.currency
        : typeof payload.costUsd === 'number' ? 'USD' : null;
      this.db.prepare(`
        INSERT INTO usage_entries(
          id, run_id, event_key, kernel_id, provider_id, model_id, request_id,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens,
          cost_amount, currency, cost_usd, source, recorded_at
        ) SELECT ?, id, ?, kernel_id, COALESCE(?, provider_id), COALESCE(?, model_id), ?,
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          FROM runs WHERE id = ?
        ON CONFLICT(run_id, event_key) DO NOTHING
      `).run(
        `usage:${envelope.runId}:${String(payload.eventKey ?? envelope.eventSeq)}`,
        String(payload.eventKey ?? envelope.eventSeq),
        typeof payload.providerId === 'string' ? payload.providerId : null,
        typeof payload.modelId === 'string' ? payload.modelId : null,
        payload.requestId === undefined ? null : String(payload.requestId),
        typeof payload.inputTokens === 'number' ? payload.inputTokens : null,
        typeof payload.outputTokens === 'number' ? payload.outputTokens : null,
        typeof payload.cacheReadTokens === 'number' ? payload.cacheReadTokens : null,
        typeof payload.cacheWriteTokens === 'number' ? payload.cacheWriteTokens : null,
        typeof payload.totalTokens === 'number' ? payload.totalTokens : null,
        cost,
        currency,
        currency === 'USD' ? cost : null,
        payload.source === 'provider-response' ? 'provider-response' : 'runtime-event',
        envelope.emittedAt,
        envelope.runId,
      );
    }
  }

  commitTerminalRun(input: CommitTerminalRunInput): void {
    assertPositiveGeneration(input.generation);
    for (const block of input.assistantBlocks) assertBlock(block);
    this.write('run.commitTerminal', () => {
      const run = this.db.prepare(`
        SELECT id, conversation_id, turn_id, kernel_id, generation, status, last_event_seq
        FROM runs WHERE id = ?
      `).get(input.runId) as RunIdentityRow | undefined;
      if (!run) throw new Error(`Run not found: ${input.runId}`);
      if (
        run.conversation_id !== input.conversationId
        || run.turn_id !== input.userTurnId
        || run.kernel_id !== input.kernelId
        || run.generation !== input.generation
      ) {
        throw new Error(`Terminal identity does not match admitted run: ${input.runId}`);
      }
      if (!['admitted', 'running', 'cancelling'].includes(run.status)) {
        throw new Error(`Run is already terminal: ${input.runId}`);
      }
      const nextPosition = Number((this.db.prepare(`
        SELECT COALESCE(MAX(position), -1) + 1 AS position FROM turns WHERE conversation_id = ?
      `).get(input.conversationId) as { position: number }).position);
      this.db.prepare(`
        INSERT INTO turns(id, conversation_id, parent_turn_id, role, position, created_at, completed_at)
        VALUES (?, ?, ?, 'assistant', ?, ?, ?)
      `).run(
        input.assistantTurnId,
        input.conversationId,
        input.userTurnId,
        nextPosition,
        input.completedAt,
        input.completedAt,
      );
      this.insertBlocks(input.assistantTurnId, input.assistantBlocks, input.completedAt);
      if (input.usage) {
        const eventKey = input.usage.eventKey ?? 'terminal';
        const cost = input.usage.cost ?? input.usage.costUsd;
        const currency = input.usage.currency ?? (input.usage.costUsd !== undefined ? 'USD' : undefined);
        this.db.prepare(`
          INSERT INTO usage_entries(
            id, run_id, event_key, kernel_id, provider_id, model_id, request_id,
            input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
            total_tokens, cost_amount, currency, cost_usd, source, recorded_at
          ) SELECT ?, id, ?, kernel_id, provider_id, model_id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            FROM runs
            WHERE id = ? AND NOT EXISTS (SELECT 1 FROM usage_entries WHERE run_id = ?)
          ON CONFLICT(run_id, event_key) DO NOTHING
        `).run(
          `usage:${input.runId}:${eventKey}`,
          eventKey,
          input.usage.requestId ?? null,
          input.usage.inputTokens ?? null,
          input.usage.outputTokens ?? null,
          input.usage.cacheReadTokens ?? null,
          input.usage.cacheWriteTokens ?? null,
          input.usage.totalTokens ?? null,
          cost ?? null,
          currency ?? null,
          currency === 'USD' ? cost ?? null : null,
          input.usage.source === 'provider-response' ? 'provider-response' : 'runtime-event',
          input.completedAt,
          input.runId,
          input.runId,
        );
      }
      this.db.prepare(`
        UPDATE runs SET status = ?, completed_at = ? WHERE id = ?
      `).run(input.outcome, input.completedAt, input.runId);
      this.db.prepare('UPDATE conversations SET updated_at = ?, version = version + 1 WHERE id = ?')
        .run(input.completedAt, input.conversationId);
      this.refreshConversationSearch(input.conversationId);
    });
  }

  private contextRowsForConversation(
    conversationId: ConversationId,
    visited = new Set<ConversationId>(),
  ): Array<Record<string, SqlValue>> {
    if (visited.has(conversationId)) {
      throw new Error(`Conversation branch lineage contains a cycle: ${conversationId}`);
    }
    visited.add(conversationId);
    const ownRows = this.db.prepare(`
      SELECT
        b.id, b.type, b.visibility, b.kernel_id, b.mime_type, b.text_content,
        b.json_content, b.blob_hash, b.revoked_at, b.position AS block_position,
        t.id AS turn_id, t.role, t.position AS turn_position
      FROM turns t
      JOIN content_blocks b ON b.turn_id = t.id
      WHERE t.conversation_id = ?
      ORDER BY t.position ASC, b.position ASC
    `).all(conversationId) as Array<Record<string, SqlValue>>;
    const lineage = this.db.prepare(`
      SELECT parent_conversation_id, branched_from_turn_id
      FROM conversations WHERE id = ? AND deleted_at IS NULL
    `).get(conversationId) as {
      parent_conversation_id: string | null;
      branched_from_turn_id: string | null;
    } | undefined;
    if (!lineage) throw new Error(`Conversation not found: ${conversationId}`);
    if (!lineage.parent_conversation_id || !lineage.branched_from_turn_id) return ownRows;

    const parentId = lineage.parent_conversation_id as ConversationId;
    const parentRows = this.contextRowsForConversation(parentId, visited);
    const parentExport = this.exportConversation(parentId);
    const sourcePosition = parentExport.turns.findIndex(turn => turn.id === lineage.branched_from_turn_id);
    if (sourcePosition < 0) {
      throw new Error(`Conversation branch source is unavailable: ${lineage.branched_from_turn_id}`);
    }
    const inherited = parentRows.filter(row => Number(row.turn_position) <= sourcePosition);
    return [
      ...inherited,
      ...ownRows.map(row => ({
        ...row,
        turn_position: sourcePosition + 1 + Number(row.turn_position),
      })),
    ];
  }

  compileContext(input: {
    conversationId: ConversationId;
    runId: RunId;
    kernelId: KernelId;
    maxBlocks?: number;
    maxTextCharacters?: number;
  }): KernelContextSnapshotV1 {
    const run = this.db.prepare('SELECT context_compiler_version FROM runs WHERE id = ? AND conversation_id = ? AND kernel_id = ?')
      .get(input.runId, input.conversationId, input.kernelId) as { context_compiler_version: string } | undefined;
    if (!run) throw new Error(`Context request does not match an admitted run: ${input.runId}`);
    const rows = this.contextRowsForConversation(input.conversationId);
    const omitted = {
      privateBlocks: 0,
      secretBlocks: 0,
      otherKernelBlocks: 0,
      revokedBlocks: 0,
      budgetBlocks: 0,
    };
    const portable: KernelContextBlock[] = [];
    for (const row of rows) {
      if (row.revoked_at) {
        omitted.revokedBlocks += 1;
        continue;
      }
      if (row.visibility === 'private') {
        omitted.privateBlocks += 1;
        continue;
      }
      if (row.visibility === 'secret') {
        omitted.secretBlocks += 1;
        continue;
      }
      if (row.visibility === 'kernel' && row.kernel_id !== input.kernelId) {
        omitted.otherKernelBlocks += 1;
        continue;
      }
      portable.push({
        id: String(row.id),
        turnId: String(row.turn_id) as KernelContextBlock['turnId'],
        role: String(row.role) as KernelContextBlock['role'],
        position: Number(row.turn_position) * 1_000_000 + Number(row.block_position),
        type: String(row.type) as KernelContextBlock['type'],
        visibility: String(row.visibility) as KernelContextBlock['visibility'],
        ...(row.kernel_id ? { kernelId: String(row.kernel_id) } : {}),
        ...(row.mime_type ? { mimeType: String(row.mime_type) } : {}),
        ...(row.text_content !== null ? { text: String(row.text_content) } : {}),
        ...(row.json_content !== null ? { json: parseJson(row.json_content) } : {}),
        ...(row.blob_hash ? { blobHash: String(row.blob_hash) } : {}),
      });
    }
    const maxBlocks = input.maxBlocks ?? 2_000;
    let blocks = portable.length > maxBlocks ? portable.slice(portable.length - maxBlocks) : portable;
    omitted.budgetBlocks = portable.length - blocks.length;
    if (input.maxTextCharacters !== undefined) {
      let remaining = Math.max(0, input.maxTextCharacters);
      const selected: KernelContextBlock[] = [];
      for (const block of [...blocks].reverse()) {
        const length = block.text?.length ?? 0;
        if (length <= remaining) {
          selected.push(block);
          remaining -= length;
          continue;
        }
        if (length > 0 && remaining > 0) {
          selected.push({ ...block, text: block.text!.slice(length - remaining) });
          remaining = 0;
        } else {
          omitted.budgetBlocks += 1;
        }
      }
      blocks = selected.reverse();
    }
    const conversation = this.db.prepare('SELECT version FROM conversations WHERE id = ?')
      .get(input.conversationId) as { version: number } | undefined;
    const contextHash = createHash('sha256').update(json(blocks)).digest('hex');
    const provenance = {
      sourceConversationVersion: conversation?.version ?? 0,
      redactionPolicyVersion: 'clawx.visibility/v1',
      maxBlocks,
      ...(input.maxTextCharacters === undefined ? {} : { maxTextCharacters: input.maxTextCharacters }),
      contextHash,
    };
    this.write('context.record', () => {
      this.db.prepare(`
        INSERT INTO runtime_contexts(run_id, kernel_id, compiler_version, context_hash, provenance_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          kernel_id = excluded.kernel_id,
          compiler_version = excluded.compiler_version,
          context_hash = excluded.context_hash,
          provenance_json = excluded.provenance_json,
          created_at = excluded.created_at
      `).run(
        input.runId,
        input.kernelId,
        run.context_compiler_version,
        contextHash,
        json(provenance),
        new Date().toISOString(),
      );
    });
    return {
      protocol: 'clawx.conversation-store/v1',
      conversationId: input.conversationId,
      runId: input.runId,
      kernelId: input.kernelId,
      compilerVersion: run.context_compiler_version,
      blocks,
      omitted,
      provenance,
    };
  }

  putCheckpoint(input: {
    runId: RunId;
    kernelId: KernelId;
    codec: string;
    schemaVersion: number;
    checkpoint: unknown;
    createdAt: string;
  }): void {
    this.write('checkpoint.put', () => {
      const run = this.db.prepare('SELECT kernel_id FROM runs WHERE id = ?').get(input.runId) as { kernel_id: string } | undefined;
      if (!run || run.kernel_id !== input.kernelId) throw new Error('Checkpoint kernel does not match run');
      this.db.prepare(`
        INSERT INTO runtime_checkpoints(run_id, kernel_id, codec, schema_version, checkpoint_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, kernel_id, codec, schema_version)
        DO UPDATE SET checkpoint_json = excluded.checkpoint_json, created_at = excluded.created_at
      `).run(input.runId, input.kernelId, input.codec, input.schemaVersion, json(input.checkpoint), input.createdAt);
    });
  }

  getCheckpoint(input: { runId: RunId; kernelId: KernelId; codec: string; schemaVersion: number }): unknown | undefined {
    const row = this.db.prepare(`
      SELECT checkpoint_json FROM runtime_checkpoints
      WHERE run_id = ? AND kernel_id = ? AND codec = ? AND schema_version = ?
    `).get(input.runId, input.kernelId, input.codec, input.schemaVersion) as { checkpoint_json: string } | undefined;
    return row ? JSON.parse(row.checkpoint_json) : undefined;
  }

  getLatestConversationCheckpoint(input: {
    conversationId: ConversationId;
    kernelId: KernelId;
    codec: string;
    schemaVersion: number;
    beforeRunId?: RunId;
  }): { runId: RunId; checkpoint: unknown; createdAt: string } | undefined {
    const row = this.db.prepare(`
      SELECT c.run_id, c.checkpoint_json, c.created_at
      FROM runtime_checkpoints c
      JOIN runs r ON r.id = c.run_id
      WHERE r.conversation_id = ?
        AND c.kernel_id = ?
        AND c.codec = ?
        AND c.schema_version = ?
        AND (? IS NULL OR c.run_id != ?)
      ORDER BY c.created_at DESC, r.created_at DESC
      LIMIT 1
    `).get(
      input.conversationId,
      input.kernelId,
      input.codec,
      input.schemaVersion,
      input.beforeRunId ?? null,
      input.beforeRunId ?? null,
    ) as { run_id: string; checkpoint_json: string; created_at: string } | undefined;
    return row
      ? {
          runId: row.run_id as RunId,
          checkpoint: JSON.parse(row.checkpoint_json),
          createdAt: row.created_at,
        }
      : undefined;
  }

  listRunEvents(runId: RunId): Array<{ eventSeq: number; kind: string; payload: unknown }> {
    const rows = this.db.prepare(`
      SELECT event_seq, event_kind, payload_json FROM run_events WHERE run_id = ? ORDER BY event_seq
    `).all(runId) as Array<{ event_seq: number; event_kind: string; payload_json: string }>;
    return rows.map((row) => ({
      eventSeq: row.event_seq,
      kind: row.event_kind,
      payload: JSON.parse(row.payload_json),
    }));
  }

  getRunArtifacts(runId: RunId): {
    tools: Array<Record<string, unknown>>;
    permissions: Array<Record<string, unknown>>;
    usage: Array<Record<string, unknown>>;
  } {
    const tools = this.db.prepare(`
      SELECT id, native_call_id AS nativeCallId, name, status, input_json AS inputJson,
        output_json AS outputJson, started_at AS startedAt, completed_at AS completedAt
      FROM tool_calls WHERE run_id = ? ORDER BY started_at, id
    `).all(runId) as Array<Record<string, unknown>>;
    const permissions = this.db.prepare(`
      SELECT id, native_request_id AS nativeRequestId, kind, request_json AS requestJson,
        decision, requested_at AS requestedAt, resolved_at AS resolvedAt
      FROM permissions WHERE run_id = ? ORDER BY requested_at, id
    `).all(runId) as Array<Record<string, unknown>>;
    const usage = this.db.prepare(`
      SELECT id, event_key AS eventKey, request_id AS requestId, input_tokens AS inputTokens,
        output_tokens AS outputTokens, cache_read_tokens AS cacheReadTokens,
        cache_write_tokens AS cacheWriteTokens, total_tokens AS totalTokens,
        COALESCE(cost_amount, cost_usd) AS cost,
        COALESCE(currency, CASE WHEN cost_usd IS NOT NULL THEN 'USD' END) AS currency,
        source, recorded_at AS recordedAt
      FROM usage_entries WHERE run_id = ? ORDER BY recorded_at, id
    `).all(runId) as Array<Record<string, unknown>>;
    return { tools, permissions, usage };
  }

  appendUsage(input: {
    id: string;
    runId: RunId;
    eventKey: string;
    kernelId: KernelId;
    providerId?: string;
    modelId?: string;
    requestId?: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    totalTokens?: number;
    cost?: number;
    currency?: string;
    source?: 'runtime-event' | 'provider-response';
    /** @deprecated USD compatibility input. */
    costUsd?: number;
    recordedAt: string;
  }): { inserted: boolean } {
    return this.write('usage.append', () => {
      const run = this.db.prepare('SELECT kernel_id FROM runs WHERE id = ?').get(input.runId) as { kernel_id: string } | undefined;
      if (!run || run.kernel_id !== input.kernelId) throw new Error('Usage identity does not match its run');
      const result = this.db.prepare(`
        INSERT INTO usage_entries(
          id, run_id, event_key, kernel_id, provider_id, model_id, request_id,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens,
          cost_amount, currency, cost_usd, source, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, event_key) DO NOTHING
      `).run(
        input.id,
        input.runId,
        input.eventKey,
        input.kernelId,
        input.providerId ?? null,
        input.modelId ?? null,
        input.requestId ?? null,
        input.inputTokens ?? null,
        input.outputTokens ?? null,
        input.cacheReadTokens ?? null,
        input.cacheWriteTokens ?? null,
        input.totalTokens ?? null,
        input.cost ?? input.costUsd ?? null,
        input.currency ?? (input.costUsd !== undefined ? 'USD' : null),
        (input.currency ?? (input.costUsd !== undefined ? 'USD' : undefined)) === 'USD'
          ? input.cost ?? input.costUsd ?? null
          : null,
        input.source ?? 'runtime-event',
        input.recordedAt,
      );
      return { inserted: result.changes === 1 };
    });
  }

  listUsage(input: {
    from: string;
    to: string;
    kernelIds?: KernelId[];
    agentIds?: string[];
    providerIds?: string[];
    modelIds?: string[];
  }): Array<Record<string, unknown>> {
    const filters: Array<[string, string[]]> = [
      ['u.kernel_id', input.kernelIds ?? []],
      ['r.agent_id', input.agentIds ?? []],
      ['u.provider_id', input.providerIds ?? []],
      ['u.model_id', input.modelIds ?? []],
    ];
    const clauses: string[] = [];
    const values: string[] = [];
    for (const [column, selected] of filters) {
      if (selected.length === 0) continue;
      clauses.push(`${column} IN (${selected.map(() => '?').join(', ')})`);
      values.push(...selected);
    }
    const rows = this.db.prepare(`
      SELECT u.id, u.event_key AS eventKey, u.run_id AS runId, u.kernel_id AS kernelId,
        u.provider_id AS providerId, u.model_id AS modelId,
        u.request_id AS requestId, u.input_tokens AS inputTokens,
        u.output_tokens AS outputTokens, u.cache_read_tokens AS cacheReadTokens,
        u.cache_write_tokens AS cacheWriteTokens, u.total_tokens AS totalTokens,
        COALESCE(u.cost_amount, u.cost_usd) AS cost,
        COALESCE(u.currency, CASE WHEN u.cost_usd IS NOT NULL THEN 'USD' END) AS currency,
        u.source,
        u.recorded_at AS recordedAt, r.agent_id AS agentId,
        r.conversation_id AS conversationId
      FROM usage_entries u
      JOIN runs r ON r.id = u.run_id
      WHERE u.recorded_at >= ? AND u.recorded_at < ?
        ${clauses.length > 0 ? `AND ${clauses.join(' AND ')}` : ''}
      ORDER BY u.recorded_at, u.id
    `).all(input.from, input.to, ...values) as Array<Record<string, unknown>>;
    return rows;
  }

  putCronJob(input: CanonicalCronJob & { nextRunAt?: string }): void {
    if (!Number.isSafeInteger(input.revision) || input.revision < 1) {
      throw new Error('Cron job revision must be a positive safe integer');
    }
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1_000) {
      throw new Error('Cron job timeout must be at least 1000ms');
    }
    this.write('cron.job.put', () => {
      const timezone = input.schedule.kind === 'cron' ? input.schedule.timezone : 'UTC';
      const existing = this.db.prepare('SELECT revision FROM cron_jobs WHERE id = ?')
        .get(input.id) as { revision: number } | undefined;
      if (existing && input.revision < existing.revision) {
        throw new Error(`Cron job revision rollback refused: ${input.revision} < ${existing.revision}`);
      }
      this.db.prepare(`
        INSERT INTO cron_jobs(
          id, name, prompt, schedule_json, timezone, kernel_id, agent_id,
          conversation_policy, conversation_id, delivery_json, misfire_policy,
          overlap_policy, timeout_ms, enabled, revision, next_run_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          prompt = excluded.prompt,
          schedule_json = excluded.schedule_json,
          timezone = excluded.timezone,
          kernel_id = excluded.kernel_id,
          agent_id = excluded.agent_id,
          conversation_policy = excluded.conversation_policy,
          conversation_id = excluded.conversation_id,
          delivery_json = excluded.delivery_json,
          misfire_policy = excluded.misfire_policy,
          overlap_policy = excluded.overlap_policy,
          timeout_ms = excluded.timeout_ms,
          enabled = excluded.enabled,
          revision = excluded.revision,
          next_run_at = excluded.next_run_at,
          updated_at = excluded.updated_at
      `).run(
        input.id,
        input.name,
        input.prompt,
        json(input.schedule),
        timezone,
        input.kernelId,
        input.agentId,
        input.conversationPolicy,
        input.conversationId ?? null,
        json(input.delivery ?? null),
        input.misfirePolicy,
        input.overlapPolicy,
        input.timeoutMs,
        input.enabled ? 1 : 0,
        input.revision,
        input.nextRunAt ?? null,
        input.createdAt,
        input.updatedAt,
      );
    });
  }

  getCronJob(id: string): (CanonicalCronJob & { nextRunAt?: string }) | undefined {
    const row = this.db.prepare(`
      SELECT id, name, prompt, schedule_json, kernel_id, agent_id,
        conversation_policy, conversation_id, delivery_json, misfire_policy,
        overlap_policy, timeout_ms, enabled, revision, next_run_at, created_at, updated_at
      FROM cron_jobs WHERE id = ?
    `).get(id) as Record<string, SqlValue> | undefined;
    return row ? this.mapCronJob(row) : undefined;
  }

  listCronJobs(): Array<CanonicalCronJob & { nextRunAt?: string }> {
    const rows = this.db.prepare(`
      SELECT id, name, prompt, schedule_json, kernel_id, agent_id,
        conversation_policy, conversation_id, delivery_json, misfire_policy,
        overlap_policy, timeout_ms, enabled, revision, next_run_at, created_at, updated_at
      FROM cron_jobs ORDER BY created_at DESC, id DESC
    `).all() as Array<Record<string, SqlValue>>;
    return rows.map(row => this.mapCronJob(row));
  }

  deleteCronJob(id: string): boolean {
    return this.write('cron.job.delete', () => this.db.prepare('DELETE FROM cron_jobs WHERE id = ?').run(id).changes === 1);
  }

  admitCron(input: CanonicalCronAdmission): { inserted: boolean; admission: CanonicalCronAdmission } {
    return this.write('cron.admit', () => {
      const result = this.db.prepare(`
        INSERT INTO cron_admissions(
          id, job_id, scheduled_for, trigger_kind, snapshot_json, run_id, admitted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(job_id, scheduled_for) DO NOTHING
      `).run(
        input.id,
        input.jobId,
        input.scheduledFor,
        input.triggerKind,
        json(input.snapshot),
        input.runId ?? null,
        input.admittedAt,
      );
      if (result.changes === 1) return { inserted: true, admission: input };
      const existing = this.db.prepare(`
        SELECT id, job_id, scheduled_for, trigger_kind, snapshot_json, run_id, admitted_at
        FROM cron_admissions WHERE job_id = ? AND scheduled_for = ?
      `).get(input.jobId, input.scheduledFor) as Record<string, SqlValue>;
      return { inserted: false, admission: this.cronAdmissionFromRow(existing) };
    });
  }

  admitCronExecution(input: {
    admission: CanonicalCronAdmission;
    run: CanonicalCronRun;
  }): { inserted: boolean; admission: CanonicalCronAdmission; run?: CanonicalCronRun } {
    if (input.run.admissionId !== input.admission.id) {
      throw new Error('Cron run admission identity does not match its admission');
    }
    return this.write('cron.execution.admit', () => {
      const inserted = this.db.prepare(`
        INSERT INTO cron_admissions(
          id, job_id, scheduled_for, trigger_kind, snapshot_json, run_id, admitted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(job_id, scheduled_for) DO NOTHING
      `).run(
        input.admission.id,
        input.admission.jobId,
        input.admission.scheduledFor,
        input.admission.triggerKind,
        json(input.admission.snapshot),
        input.admission.runId ?? null,
        input.admission.admittedAt,
      ).changes === 1;
      if (inserted) {
        this.putCronRunStatement(input.run);
        return { inserted: true, admission: input.admission, run: input.run };
      }
      const admissionRow = this.db.prepare(`
        SELECT id, job_id, scheduled_for, trigger_kind, snapshot_json, run_id, admitted_at
        FROM cron_admissions WHERE job_id = ? AND scheduled_for = ?
      `).get(input.admission.jobId, input.admission.scheduledFor) as Record<string, SqlValue>;
      const runRow = this.db.prepare(`
        SELECT id, admission_id, run_id, status, started_at, completed_at, error,
          diagnostic_json, delivery_message_id
        FROM cron_runs WHERE admission_id = ?
      `).get(String(admissionRow.id)) as Record<string, SqlValue> | undefined;
      return {
        inserted: false,
        admission: this.cronAdmissionFromRow(admissionRow),
        ...(runRow ? { run: this.cronRunFromRow(runRow) } : {}),
      };
    });
  }

  putCronRun(input: CanonicalCronRun): void {
    this.write('cron.run.put', () => this.putCronRunStatement(input));
  }

  listCronRuns(jobId: string, limit = 200): Array<CanonicalCronRun & { scheduledFor: string }> {
    const rows = this.db.prepare(`
      SELECT r.id, r.admission_id, r.run_id, r.status, r.started_at,
        r.completed_at, r.error, r.diagnostic_json, r.delivery_message_id,
        a.scheduled_for
      FROM cron_runs r
      JOIN cron_admissions a ON a.id = r.admission_id
      WHERE a.job_id = ?
      ORDER BY a.scheduled_for DESC, r.id DESC
      LIMIT ?
    `).all(jobId, Math.min(Math.max(limit, 1), 1000)) as Array<Record<string, SqlValue>>;
    return rows.map(row => ({ ...this.cronRunFromRow(row), scheduledFor: String(row.scheduled_for) }));
  }

  getCronRun(id: string): CanonicalCronRun | undefined {
    const row = this.db.prepare(`
      SELECT id, admission_id, run_id, status, started_at, completed_at, error,
        diagnostic_json, delivery_message_id
      FROM cron_runs WHERE id = ?
    `).get(id) as Record<string, SqlValue> | undefined;
    return row ? this.cronRunFromRow(row) : undefined;
  }

  private mapCronJob(row: Record<string, SqlValue>): CanonicalCronJob & { nextRunAt?: string } {
    const delivery = parseJson(row.delivery_json);
    return {
      id: String(row.id) as CanonicalCronJob['id'],
      name: String(row.name),
      prompt: String(row.prompt),
      schedule: parseJson(row.schedule_json) as CanonicalCronJob['schedule'],
      kernelId: String(row.kernel_id),
      agentId: String(row.agent_id) as CanonicalCronJob['agentId'],
      conversationPolicy: String(row.conversation_policy) as CanonicalCronJob['conversationPolicy'],
      ...(row.conversation_id ? { conversationId: String(row.conversation_id) as CanonicalCronJob['conversationId'] } : {}),
      ...(delivery && typeof delivery === 'object' ? { delivery: delivery as CanonicalCronJob['delivery'] } : {}),
      misfirePolicy: String(row.misfire_policy) as CanonicalCronJob['misfirePolicy'],
      overlapPolicy: String(row.overlap_policy) as CanonicalCronJob['overlapPolicy'],
      timeoutMs: Number(row.timeout_ms),
      enabled: Number(row.enabled) === 1,
      revision: Number(row.revision),
      ...(row.next_run_at ? { nextRunAt: String(row.next_run_at) } : {}),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private cronAdmissionFromRow(row: Record<string, SqlValue>): CanonicalCronAdmission {
    return {
      id: String(row.id),
      jobId: String(row.job_id) as CanonicalCronAdmission['jobId'],
      scheduledFor: String(row.scheduled_for),
      triggerKind: String(row.trigger_kind) as CanonicalCronAdmission['triggerKind'],
      snapshot: parseJson(row.snapshot_json) as CanonicalCronAdmission['snapshot'],
      admittedAt: String(row.admitted_at),
      ...(row.run_id ? { runId: String(row.run_id) as CanonicalCronAdmission['runId'] } : {}),
    };
  }

  private cronRunFromRow(row: Record<string, SqlValue>): CanonicalCronRun {
    const diagnostic = parseJson(row.diagnostic_json);
    return {
      id: String(row.id),
      admissionId: String(row.admission_id),
      ...(row.run_id ? { runId: String(row.run_id) as CanonicalCronRun['runId'] } : {}),
      status: String(row.status) as CanonicalCronRun['status'],
      ...(row.started_at ? { startedAt: String(row.started_at) } : {}),
      ...(row.completed_at ? { completedAt: String(row.completed_at) } : {}),
      ...(row.error ? { error: String(row.error) } : {}),
      ...(diagnostic && typeof diagnostic === 'object'
        ? { diagnostic: diagnostic as CanonicalCronRun['diagnostic'] }
        : {}),
      ...(row.delivery_message_id ? { deliveryMessageId: String(row.delivery_message_id) } : {}),
    };
  }

  private putCronRunStatement(input: CanonicalCronRun): void {
    this.db.prepare(`
      INSERT INTO cron_runs(
        id, admission_id, run_id, status, started_at, completed_at, error,
        diagnostic_json, delivery_message_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(admission_id) DO UPDATE SET
        run_id = excluded.run_id,
        status = excluded.status,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        error = excluded.error,
        diagnostic_json = excluded.diagnostic_json,
        delivery_message_id = excluded.delivery_message_id
    `).run(
      input.id,
      input.admissionId,
      input.runId ?? null,
      input.status,
      input.startedAt ?? null,
      input.completedAt ?? null,
      input.error ?? null,
      json(input.diagnostic ?? null),
      input.deliveryMessageId ?? null,
    );
  }

  acquireSchedulerLease(
    input: SchedulerLeaderLease & { now: string },
  ): SchedulerLeaderLeaseAcquireResult {
    if (!input.ownerId.trim()) throw new Error('Scheduler lease owner is required');
    if (input.leaseExpiresAt <= input.now) throw new Error('Scheduler lease must expire in the future');
    return this.write('scheduler.lease.acquire', () => {
      const existing = this.db.prepare(`
        SELECT name, owner_id, lease_expires_at, updated_at
        FROM scheduler_leases WHERE name = ?
      `).get(input.name) as Record<string, SqlValue> | undefined;
      if (existing && String(existing.lease_expires_at) > input.now
        && String(existing.owner_id) !== input.ownerId) {
        return { acquired: false, lease: this.schedulerLeaseFromRow(existing) };
      }
      this.db.prepare(`
        INSERT INTO scheduler_leases(name, owner_id, lease_expires_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
          owner_id = excluded.owner_id,
          lease_expires_at = excluded.lease_expires_at,
          updated_at = excluded.updated_at
      `).run(input.name, input.ownerId, input.leaseExpiresAt, input.updatedAt);
      return { acquired: true, lease: {
        name: input.name,
        ownerId: input.ownerId,
        leaseExpiresAt: input.leaseExpiresAt,
        updatedAt: input.updatedAt,
      } };
    });
  }

  renewSchedulerLease(input: SchedulerLeaderLease & { now: string }): boolean {
    if (input.leaseExpiresAt <= input.now) throw new Error('Scheduler lease must expire in the future');
    return this.write('scheduler.lease.renew', () => this.db.prepare(`
      UPDATE scheduler_leases SET lease_expires_at = ?, updated_at = ?
      WHERE name = ? AND owner_id = ? AND lease_expires_at > ?
    `).run(
      input.leaseExpiresAt,
      input.updatedAt,
      input.name,
      input.ownerId,
      input.now,
    ).changes === 1);
  }

  releaseSchedulerLease(input: { name: SchedulerLeaderLease['name']; ownerId: string }): boolean {
    return this.write('scheduler.lease.release', () => this.db.prepare(`
      DELETE FROM scheduler_leases WHERE name = ? AND owner_id = ?
    `).run(input.name, input.ownerId).changes === 1);
  }

  getSchedulerLease(name: SchedulerLeaderLease['name'], now: string): SchedulerLeaderLease | undefined {
    const row = this.db.prepare(`
      SELECT name, owner_id, lease_expires_at, updated_at
      FROM scheduler_leases WHERE name = ? AND lease_expires_at > ?
    `).get(name, now) as Record<string, SqlValue> | undefined;
    return row ? this.schedulerLeaseFromRow(row) : undefined;
  }

  private schedulerLeaseFromRow(row: Record<string, SqlValue>): SchedulerLeaderLease {
    return {
      name: String(row.name) as SchedulerLeaderLease['name'],
      ownerId: String(row.owner_id),
      leaseExpiresAt: String(row.lease_expires_at),
      updatedAt: String(row.updated_at),
    };
  }

  registerBlob(input: { hash: string; byteLength: number; mimeType: string; createdAt: string }): void {
    this.write('blob.register', () => {
      const existing = this.db.prepare('SELECT byte_length, mime_type FROM blob_objects WHERE hash = ?')
        .get(input.hash) as { byte_length: number; mime_type: string } | undefined;
      if (existing && (existing.byte_length !== input.byteLength || existing.mime_type !== input.mimeType)) {
        throw new Error(`Blob metadata collision for ${input.hash}`);
      }
      this.db.prepare(`
        INSERT INTO blob_objects(hash, byte_length, mime_type, created_at, verified_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(hash) DO UPDATE SET verified_at = excluded.verified_at
      `).run(input.hash, input.byteLength, input.mimeType, input.createdAt, input.createdAt);
    });
  }

  addBlobRef(input: {
    ownerType: string;
    ownerId: string;
    position?: number;
    blobHash: string;
    accessPolicy: unknown;
    createdAt: string;
  }): void {
    this.write('blob.addRef', () => {
      this.db.prepare(`
        INSERT INTO blob_refs(owner_type, owner_id, position, blob_hash, access_policy_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(owner_type, owner_id, position) DO UPDATE SET
          blob_hash = excluded.blob_hash,
          access_policy_json = excluded.access_policy_json
      `).run(
        input.ownerType,
        input.ownerId,
        input.position ?? 0,
        input.blobHash,
        json(input.accessPolicy),
        input.createdAt,
      );
    });
  }

  removeBlobRefs(ownerType: string, ownerId: string): void {
    this.write('blob.removeRefs', () => {
      this.db.prepare('DELETE FROM blob_refs WHERE owner_type = ? AND owner_id = ?').run(ownerType, ownerId);
    });
  }

  listUnreferencedBlobHashes(): string[] {
    return (this.db.prepare(`
      SELECT b.hash FROM blob_objects b
      LEFT JOIN blob_refs r ON r.blob_hash = b.hash
      LEFT JOIN content_blocks c ON c.blob_hash = b.hash
      WHERE r.blob_hash IS NULL AND c.blob_hash IS NULL
      ORDER BY b.hash
    `).all() as Array<{ hash: string }>).map(row => row.hash);
  }

  deleteBlobMetadata(hash: string): void {
    this.write('blob.deleteMetadata', () => {
      const result = this.db.prepare(`
        DELETE FROM blob_objects
        WHERE hash = ? AND NOT EXISTS (SELECT 1 FROM blob_refs WHERE blob_hash = ?)
      `).run(hash, hash);
      if (result.changes !== 1) throw new Error(`Blob ${hash} is still referenced or missing`);
    });
  }

  createAttachmentGrant(input: {
    id: string;
    blobHash: string;
    runId: RunId;
    kernelId: KernelId;
    generation: number;
    expiresAt: string;
    createdAt: string;
  }): void {
    assertPositiveGeneration(input.generation);
    this.write('blob.grant', () => {
      const run = this.db.prepare('SELECT kernel_id, generation FROM runs WHERE id = ?').get(input.runId) as {
        kernel_id: string;
        generation: number;
      } | undefined;
      if (!run || run.kernel_id !== input.kernelId || run.generation !== input.generation) {
        throw new Error('Attachment grant identity does not match its run');
      }
      this.db.prepare(`
        INSERT INTO attachment_access_grants(
          id, blob_hash, run_id, kernel_id, generation, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id,
        input.blobHash,
        input.runId,
        input.kernelId,
        input.generation,
        input.expiresAt,
        input.createdAt,
      );
    });
  }

  validateAttachmentGrant(input: {
    id: string;
    blobHash: string;
    runId: RunId;
    kernelId: KernelId;
    generation: number;
    now: string;
  }): boolean {
    const row = this.db.prepare(`
      SELECT id FROM attachment_access_grants
      WHERE id = ? AND blob_hash = ? AND run_id = ? AND kernel_id = ? AND generation = ?
        AND revoked_at IS NULL AND expires_at > ?
    `).get(input.id, input.blobHash, input.runId, input.kernelId, input.generation, input.now);
    return Boolean(row);
  }

  getConversationBlobMetadata(
    conversationId: ConversationId,
    blobHash: string,
  ): { mimeType: string; size: number } | undefined {
    const row = this.db.prepare(`
      SELECT b.mime_type AS mimeType, b.byte_length AS size
      FROM blob_objects b
      WHERE b.hash = ? AND EXISTS (
        SELECT 1 FROM content_blocks c
        JOIN turns t ON t.id = c.turn_id
        JOIN conversations conversation ON conversation.id = t.conversation_id
        WHERE c.blob_hash = b.hash
          AND t.conversation_id = ?
          AND c.revoked_at IS NULL
          AND conversation.deleted_at IS NULL
      )
    `).get(blobHash, conversationId) as { mimeType: string; size: number } | undefined;
    return row ? { mimeType: row.mimeType, size: Number(row.size) } : undefined;
  }

  putChannelAccount(account: CanonicalChannelAccount): void {
    assertCanonicalChannelAccount(account);
    const canonical = { ...account, connectionOwner: undefined, projections: [] };
    this.write('channel.account.put', () => {
      const existing = this.db.prepare(`
        SELECT revision FROM channel_accounts WHERE id = ?
      `).get(account.id) as { revision: number } | undefined;
      if (existing && account.revision < existing.revision) {
        throw new Error(`Channel account revision rollback refused: ${account.revision} < ${existing.revision}`);
      }
      this.db.prepare(`
        INSERT INTO channel_accounts(
          id, channel_type, native_account_id, display_name, credential_ref,
          config_json, canonical_json, status, enabled, revision,
          created_at, updated_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          channel_type = excluded.channel_type,
          native_account_id = excluded.native_account_id,
          display_name = excluded.display_name,
          credential_ref = excluded.credential_ref,
          config_json = excluded.config_json,
          canonical_json = excluded.canonical_json,
          status = excluded.status,
          enabled = excluded.enabled,
          revision = excluded.revision,
          updated_at = excluded.updated_at,
          deleted_at = excluded.deleted_at
      `).run(
        account.id,
        account.channelType,
        account.nativeAccountId,
        account.displayName,
        account.credentialRef ?? null,
        json(account.config),
        json(canonical),
        account.status,
        account.enabled ? 1 : 0,
        account.revision,
        account.createdAt,
        account.updatedAt,
        account.deletedAt ?? null,
      );
    });
  }

  getChannelAccount(
    id: string,
    input: { includeDeleted?: boolean; now?: string } = {},
  ): CanonicalChannelAccount | undefined {
    const row = this.db.prepare(`
      SELECT id, channel_type, native_account_id, display_name, credential_ref,
        config_json, canonical_json, status, enabled, revision,
        created_at, updated_at, deleted_at
      FROM channel_accounts
      WHERE id = ? ${input.includeDeleted ? '' : 'AND deleted_at IS NULL'}
    `).get(id) as Record<string, SqlValue> | undefined;
    return row ? this.channelAccountFromRow(row, input.now ?? new Date().toISOString()) : undefined;
  }

  listChannelAccounts(
    input: { includeDeleted?: boolean; now?: string } = {},
  ): CanonicalChannelAccount[] {
    const rows = this.db.prepare(`
      SELECT id, channel_type, native_account_id, display_name, credential_ref,
        config_json, canonical_json, status, enabled, revision,
        created_at, updated_at, deleted_at
      FROM channel_accounts
      ${input.includeDeleted ? '' : 'WHERE deleted_at IS NULL'}
      ORDER BY channel_type, display_name COLLATE NOCASE, id
    `).all() as Array<Record<string, SqlValue>>;
    const now = input.now ?? new Date().toISOString();
    return rows.map(row => this.channelAccountFromRow(row, now));
  }

  deleteChannelAccount(id: string, deletedAt: string): boolean {
    const existing = this.getChannelAccount(id);
    if (!existing) return false;
    const deleted: CanonicalChannelAccount = {
      ...existing,
      connectionOwner: undefined,
      projections: [],
      status: 'disconnected',
      enabled: false,
      revision: existing.revision + 1,
      updatedAt: deletedAt,
      deletedAt,
    };
    return this.write('channel.account.delete', () => {
      this.db.prepare('DELETE FROM channel_owner_leases WHERE account_id = ?').run(id);
      this.db.prepare('DELETE FROM channel_bindings WHERE account_id = ?').run(id);
      this.db.prepare(`DELETE FROM kernel_projections WHERE entity_type = 'channel' AND entity_id = ?`).run(id);
      return this.db.prepare(`
        UPDATE channel_accounts SET canonical_json = ?, status = 'disconnected', enabled = 0,
          revision = ?, updated_at = ?, deleted_at = ?
        WHERE id = ? AND deleted_at IS NULL
      `).run(json(deleted), deleted.revision, deletedAt, deletedAt, id).changes === 1;
    });
  }

  putChannelBinding(binding: CanonicalChannelBinding): void {
    assertCanonicalChannelBinding(binding);
    this.write('channel.binding.put', () => {
      const accountRow = this.db.prepare(`
        SELECT canonical_json FROM channel_accounts WHERE id = ? AND deleted_at IS NULL
      `).get(binding.accountId) as { canonical_json: string } | undefined;
      if (!accountRow) throw new Error(`Channel account not found: ${binding.accountId}`);
      const account = JSON.parse(accountRow.canonical_json) as CanonicalChannelAccount;
      if (!account.supportedKernels.includes(binding.kernelId)) {
        throw new Error(`Channel account ${binding.accountId} does not support ${binding.kernelId}`);
      }
      const agentRow = this.db.prepare(`
        SELECT canonical_json FROM agents WHERE id = ? AND deleted_at IS NULL
      `).get(binding.agentId) as { canonical_json: string } | undefined;
      if (!agentRow) throw new Error(`Agent not found: ${binding.agentId}`);
      const agent = JSON.parse(agentRow.canonical_json) as CanonicalAgent;
      if (!agent.supportedKernels.includes(binding.kernelId)) {
        throw new Error(`Agent ${binding.agentId} does not support ${binding.kernelId}`);
      }
      const sibling = this.db.prepare(`
        SELECT kernel_id FROM channel_bindings
        WHERE account_id = ? AND target_id != ? LIMIT 1
      `).get(binding.accountId, binding.targetId) as { kernel_id: string } | undefined;
      if (sibling && sibling.kernel_id !== binding.kernelId) {
        throw new Error('All target bindings for one external Channel account must share one connection owner kernel');
      }
      const existing = this.db.prepare(`
        SELECT revision FROM channel_bindings WHERE account_id = ? AND target_id = ?
      `).get(binding.accountId, binding.targetId) as { revision: number } | undefined;
      if (existing && binding.revision < existing.revision) {
        throw new Error(`Channel binding revision rollback refused: ${binding.revision} < ${existing.revision}`);
      }
      this.db.prepare(`
        INSERT INTO channel_bindings(
          id, account_id, target_id, kernel_id, agent_id, conversation_policy,
          conversation_id, revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, target_id) DO UPDATE SET
          id = excluded.id,
          kernel_id = excluded.kernel_id,
          agent_id = excluded.agent_id,
          conversation_policy = excluded.conversation_policy,
          conversation_id = excluded.conversation_id,
          revision = excluded.revision,
          updated_at = excluded.updated_at
      `).run(
        binding.id,
        binding.accountId,
        binding.targetId,
        binding.kernelId,
        binding.agentId,
        binding.conversationPolicy,
        binding.conversationId ?? null,
        binding.revision,
        binding.createdAt,
        binding.updatedAt,
      );
    });
  }

  getChannelBinding(accountId: string, targetId = '*'): CanonicalChannelBinding | undefined {
    const row = this.db.prepare(`
      SELECT id, account_id, target_id, kernel_id, agent_id, conversation_policy,
        conversation_id, revision, created_at, updated_at
      FROM channel_bindings WHERE account_id = ? AND target_id = ?
    `).get(accountId, targetId) as Record<string, SqlValue> | undefined;
    return row ? this.channelBindingFromRow(row) : undefined;
  }

  resolveChannelBinding(accountId: string, targetId: string): CanonicalChannelBinding | undefined {
    return this.getChannelBinding(accountId, targetId) ?? this.getChannelBinding(accountId, '*');
  }

  listChannelBindings(accountId?: string): CanonicalChannelBinding[] {
    const rows = this.db.prepare(`
      SELECT id, account_id, target_id, kernel_id, agent_id, conversation_policy,
        conversation_id, revision, created_at, updated_at
      FROM channel_bindings
      WHERE (? IS NULL OR account_id = ?)
      ORDER BY account_id, target_id
    `).all(accountId ?? null, accountId ?? null) as Array<Record<string, SqlValue>>;
    return rows.map(row => this.channelBindingFromRow(row));
  }

  deleteChannelBinding(accountId: string, targetId = '*'): boolean {
    return this.write('channel.binding.delete', () => (
      this.db.prepare('DELETE FROM channel_bindings WHERE account_id = ? AND target_id = ?')
        .run(accountId, targetId).changes === 1
    ));
  }

  acquireChannelOwnerLease(input: ChannelOwnerLease & { now: string }): ChannelOwnerLeaseAcquireResult {
    if (!input.accountId || !input.ownerId || !input.kernelId) throw new Error('Channel owner lease identity is required');
    assertPositiveGeneration(input.generation);
    if (input.leaseExpiresAt <= input.now) throw new Error('Channel owner lease must expire in the future');
    return this.write('channel.owner.acquire', () => {
      const account = this.db.prepare(`
        SELECT id FROM channel_accounts WHERE id = ? AND deleted_at IS NULL AND enabled = 1
      `).get(input.accountId);
      if (!account) throw new Error(`Enabled Channel account not found: ${input.accountId}`);
      const existing = this.db.prepare(`
        SELECT account_id, owner_id, kernel_id, generation, lease_expires_at, updated_at
        FROM channel_owner_leases WHERE account_id = ?
      `).get(input.accountId) as Record<string, SqlValue> | undefined;
      if (existing && String(existing.lease_expires_at) > input.now
        && (existing.owner_id !== input.ownerId
          || existing.kernel_id !== input.kernelId
          || Number(existing.generation) !== input.generation)) {
        return { acquired: false, lease: this.channelOwnerLeaseFromRow(existing) };
      }
      this.db.prepare(`
        INSERT INTO channel_owner_leases(
          account_id, owner_id, kernel_id, generation, lease_expires_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id) DO UPDATE SET
          owner_id = excluded.owner_id,
          kernel_id = excluded.kernel_id,
          generation = excluded.generation,
          lease_expires_at = excluded.lease_expires_at,
          updated_at = excluded.updated_at
      `).run(
        input.accountId,
        input.ownerId,
        input.kernelId,
        input.generation,
        input.leaseExpiresAt,
        input.updatedAt,
      );
      return { acquired: true, lease: { ...input } };
    });
  }

  renewChannelOwnerLease(input: ChannelOwnerLease & { now: string }): boolean {
    assertPositiveGeneration(input.generation);
    if (input.leaseExpiresAt <= input.now) throw new Error('Channel owner lease must expire in the future');
    return this.write('channel.owner.renew', () => this.db.prepare(`
      UPDATE channel_owner_leases SET lease_expires_at = ?, updated_at = ?
      WHERE account_id = ? AND owner_id = ? AND kernel_id = ? AND generation = ?
        AND lease_expires_at > ?
    `).run(
      input.leaseExpiresAt,
      input.updatedAt,
      input.accountId,
      input.ownerId,
      input.kernelId,
      input.generation,
      input.now,
    ).changes === 1);
  }

  releaseChannelOwnerLease(input: {
    accountId: string;
    ownerId: string;
    kernelId: KernelId;
    generation: number;
  }): boolean {
    assertPositiveGeneration(input.generation);
    return this.write('channel.owner.release', () => this.db.prepare(`
      DELETE FROM channel_owner_leases
      WHERE account_id = ? AND owner_id = ? AND kernel_id = ? AND generation = ?
    `).run(input.accountId, input.ownerId, input.kernelId, input.generation).changes === 1);
  }

  getChannelOwnerLease(accountId: string, now: string): ChannelOwnerLease | undefined {
    const row = this.db.prepare(`
      SELECT account_id, owner_id, kernel_id, generation, lease_expires_at, updated_at
      FROM channel_owner_leases WHERE account_id = ? AND lease_expires_at > ?
    `).get(accountId, now) as Record<string, SqlValue> | undefined;
    return row ? this.channelOwnerLeaseFromRow(row) : undefined;
  }

  admitChannelMessage(input: ChannelMessageAdmissionInput): ChannelMessageAdmissionResult {
    if (!input.messageId.trim() || !input.externalConversationId.trim() || !input.externalMessageId.trim()
      || !input.targetId.trim()) {
      throw new Error('Channel message canonical and external identities are required');
    }
    assertNoChannelSecrets(input.payload ?? {}, 'channel.message.payload');
    return this.write('channel.message.admit', () => {
      const duplicate = this.db.prepare(`
        SELECT id, account_id, external_conversation_id, external_message_id,
          conversation_id, turn_id, run_id, direction, payload_json, status,
          created_at, updated_at
        FROM channel_messages
        WHERE account_id = ? AND external_conversation_id = ?
          AND external_message_id = ? AND direction = ?
      `).get(
        input.accountId,
        input.externalConversationId,
        input.externalMessageId,
        input.direction,
      ) as Record<string, SqlValue> | undefined;
      if (duplicate) return { inserted: false, message: this.channelMessageFromRow(duplicate) };
      const account = this.db.prepare(`
        SELECT id FROM channel_accounts WHERE id = ? AND deleted_at IS NULL AND enabled = 1
      `).get(input.accountId);
      if (!account) throw new Error(`Enabled Channel account not found: ${input.accountId}`);

      let conversationId = input.bindingConversationId;
      if (conversationId) {
        const bound = this.db.prepare(`
          SELECT id FROM conversations WHERE id = ? AND deleted_at IS NULL
        `).get(conversationId);
        if (!bound) conversationId = undefined;
      }
      if (!conversationId && input.conversationPolicy !== 'per-message') {
        const previous = this.db.prepare(`
          SELECT conversation_id FROM channel_messages
          WHERE account_id = ? AND external_conversation_id = ?
          ORDER BY created_at DESC, id DESC LIMIT 1
        `).get(input.accountId, input.externalConversationId) as { conversation_id: string } | undefined;
        if (previous) conversationId = asConversationId(previous.conversation_id);
      }
      conversationId ??= input.proposedConversationId;
      const existingConversation = this.db.prepare('SELECT id FROM conversations WHERE id = ?').get(conversationId);
      if (!existingConversation) {
        this.db.prepare(`
          INSERT INTO conversations(id, title, created_at, updated_at)
          VALUES (?, ?, ?, ?)
        `).run(
          conversationId,
          input.conversationTitle?.trim() || input.text?.trim().slice(0, 120) || null,
          input.createdAt,
          input.createdAt,
        );
        this.refreshConversationSearch(conversationId);
      }
      const messagePayload = {
        targetId: input.targetId,
        ...(input.text !== undefined ? { text: input.text } : {}),
        attachments: input.attachments ?? [],
        payload: input.payload ?? {},
      };
      const status = input.status ?? (input.direction === 'inbound' ? 'admitted' : 'pending-delivery');
      this.db.prepare(`
        INSERT INTO channel_messages(
          id, account_id, external_conversation_id, external_message_id,
          conversation_id, direction, payload_json, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.messageId,
        input.accountId,
        input.externalConversationId,
        input.externalMessageId,
        conversationId,
        input.direction,
        json(messagePayload),
        status,
        input.createdAt,
        input.createdAt,
      );
      for (const [position, attachment] of (input.attachments ?? []).entries()) {
        const blob = this.db.prepare('SELECT hash FROM blob_objects WHERE hash = ?').get(attachment.blobHash);
        if (!blob) throw new Error(`Channel attachment blob is missing: ${attachment.blobHash}`);
        this.db.prepare(`
          INSERT INTO blob_refs(owner_type, owner_id, position, blob_hash, access_policy_json, created_at)
          VALUES ('channel-message', ?, ?, ?, ?, ?)
        `).run(
          input.messageId,
          position,
          attachment.blobHash,
          json({ accountId: input.accountId, direction: input.direction }),
          input.createdAt,
        );
      }
      const inserted = this.db.prepare(`
        SELECT id, account_id, external_conversation_id, external_message_id,
          conversation_id, turn_id, run_id, direction, payload_json, status,
          created_at, updated_at
        FROM channel_messages WHERE id = ?
      `).get(input.messageId) as Record<string, SqlValue>;
      return { inserted: true, message: this.channelMessageFromRow(inserted) };
    });
  }

  updateChannelMessage(input: {
    id: string;
    status: ChannelMessageStatus;
    updatedAt: string;
    turnId?: string;
    runId?: string;
  }): boolean {
    return this.write('channel.message.update', () => this.db.prepare(`
      UPDATE channel_messages SET status = ?, updated_at = ?,
        turn_id = COALESCE(?, turn_id), run_id = COALESCE(?, run_id)
      WHERE id = ?
    `).run(input.status, input.updatedAt, input.turnId ?? null, input.runId ?? null, input.id).changes === 1);
  }

  getChannelMessage(id: string): CanonicalChannelMessage | undefined {
    const row = this.db.prepare(`
      SELECT id, account_id, external_conversation_id, external_message_id,
        conversation_id, turn_id, run_id, direction, payload_json, status,
        created_at, updated_at
      FROM channel_messages WHERE id = ?
    `).get(id) as Record<string, SqlValue> | undefined;
    return row ? this.channelMessageFromRow(row) : undefined;
  }

  listChannelMessages(input: {
    accountId?: string;
    conversationId?: string;
    direction?: CanonicalChannelMessage['direction'];
    status?: ChannelMessageStatus;
    limit?: number;
  } = {}): CanonicalChannelMessage[] {
    const rows = this.db.prepare(`
      SELECT id, account_id, external_conversation_id, external_message_id,
        conversation_id, turn_id, run_id, direction, payload_json, status,
        created_at, updated_at
      FROM channel_messages
      WHERE (? IS NULL OR account_id = ?)
        AND (? IS NULL OR conversation_id = ?)
        AND (? IS NULL OR direction = ?)
        AND (? IS NULL OR status = ?)
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(
      input.accountId ?? null,
      input.accountId ?? null,
      input.conversationId ?? null,
      input.conversationId ?? null,
      input.direction ?? null,
      input.direction ?? null,
      input.status ?? null,
      input.status ?? null,
      Math.min(Math.max(input.limit ?? 200, 1), 1_000),
    ) as Array<Record<string, SqlValue>>;
    return rows.map(row => this.channelMessageFromRow(row));
  }

  listPendingChannelDeliveries(limit = 100): CanonicalChannelMessage[] {
    const rows = this.db.prepare(`
      SELECT id, account_id, external_conversation_id, external_message_id,
        conversation_id, turn_id, run_id, direction, payload_json, status,
        created_at, updated_at
      FROM channel_messages
      WHERE direction = 'outbound' AND status IN ('pending-delivery', 'retrying')
      ORDER BY updated_at, id LIMIT ?
    `).all(Math.min(Math.max(limit, 1), 500)) as Array<Record<string, SqlValue>>;
    return rows.map(row => this.channelMessageFromRow(row));
  }

  recordChannelDeliveryAttempt(input: CanonicalChannelDeliveryAttempt): void {
    if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
      throw new Error('Channel delivery attempt must be a positive safe integer');
    }
    this.write('channel.delivery.attempt', () => {
      const message = this.db.prepare(`
        SELECT direction FROM channel_messages WHERE id = ?
      `).get(input.messageId) as { direction: string } | undefined;
      if (!message || message.direction !== 'outbound') {
        throw new Error(`Outbound Channel message not found: ${input.messageId}`);
      }
      this.db.prepare(`
        INSERT INTO delivery_attempts(
          id, message_id, attempt, status, error, next_retry_at, attempted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(message_id, attempt) DO UPDATE SET
          status = excluded.status,
          error = excluded.error,
          next_retry_at = excluded.next_retry_at,
          attempted_at = excluded.attempted_at
      `).run(
        input.id,
        input.messageId,
        input.attempt,
        input.status,
        input.error ?? null,
        input.nextRetryAt ?? null,
        input.attemptedAt,
      );
      const messageStatus: ChannelMessageStatus = input.status === 'sent'
        ? 'delivered'
        : input.status === 'dead-letter'
          ? 'dead-letter'
          : input.status === 'retry'
            ? 'retrying'
            : 'pending-delivery';
      this.db.prepare(`
        UPDATE channel_messages SET status = ?, updated_at = ? WHERE id = ?
      `).run(messageStatus, input.attemptedAt, input.messageId);
    });
  }

  listChannelDeliveryAttempts(messageId: string): CanonicalChannelDeliveryAttempt[] {
    const rows = this.db.prepare(`
      SELECT id, message_id, attempt, status, error, next_retry_at, attempted_at
      FROM delivery_attempts WHERE message_id = ? ORDER BY attempt
    `).all(messageId) as Array<Record<string, SqlValue>>;
    return rows.map(row => ({
      id: String(row.id),
      messageId: String(row.message_id),
      attempt: Number(row.attempt),
      status: String(row.status) as CanonicalChannelDeliveryAttempt['status'],
      ...(row.error ? { error: String(row.error) } : {}),
      ...(row.next_retry_at ? { nextRetryAt: String(row.next_retry_at) } : {}),
      attemptedAt: String(row.attempted_at),
    }));
  }

  private channelAccountFromRow(row: Record<string, SqlValue>, now: string): CanonicalChannelAccount {
    const parsed = parseJson(row.canonical_json) as Partial<CanonicalChannelAccount> | null;
    const projections = this.listProjections('channel', String(row.id)).map(projection => ({
      kernelId: String(projection.kernelId) as KernelId,
      ...(projection.nativeId ? { nativeId: String(projection.nativeId) } : {}),
      state: String(projection.status) as CanonicalChannelAccount['projections'][number]['state'],
      desiredVersion: Number(projection.desiredVersion),
      ...(projection.appliedVersion === null || projection.appliedVersion === undefined
        ? {}
        : { appliedVersion: Number(projection.appliedVersion) }),
      ...(projection.error ? {
        error: { code: 'PROJECTION_ERROR', message: String(projection.error), retryable: true },
      } : {}),
      updatedAt: String(projection.updatedAt),
    }));
    return {
      id: asChannelAccountId(String(row.id)),
      channelType: String(row.channel_type),
      nativeAccountId: String(row.native_account_id ?? row.id),
      displayName: String(row.display_name),
      ...(row.credential_ref ? { credentialRef: String(row.credential_ref) } : {}),
      ...(this.getChannelOwnerLease(String(row.id), now)
        ? { connectionOwner: this.getChannelOwnerLease(String(row.id), now)! }
        : {}),
      status: String(row.status) as CanonicalChannelAccount['status'],
      ...(parsed?.statusDetail ? { statusDetail: parsed.statusDetail } : {}),
      config: (parseJson(row.config_json) as Record<string, unknown>) ?? {},
      form: parsed?.form ?? [],
      targets: parsed?.targets ?? [],
      enabled: Number(row.enabled) === 1,
      isDefault: parsed?.isDefault ?? String(row.native_account_id ?? row.id) === 'default',
      supportedKernels: parsed?.supportedKernels ?? ['openclaw', 'deepseek-harness'],
      projections,
      revision: Number(row.revision),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      ...(row.deleted_at ? { deletedAt: String(row.deleted_at) } : {}),
    };
  }

  private channelBindingFromRow(row: Record<string, SqlValue>): CanonicalChannelBinding {
    return {
      id: asChannelBindingId(String(row.id)),
      accountId: asChannelAccountId(String(row.account_id)),
      targetId: String(row.target_id),
      kernelId: String(row.kernel_id) as KernelId,
      agentId: asAgentId(String(row.agent_id)),
      conversationPolicy: String(row.conversation_policy) as CanonicalChannelBinding['conversationPolicy'],
      ...(row.conversation_id ? { conversationId: asConversationId(String(row.conversation_id)) } : {}),
      revision: Number(row.revision),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private channelOwnerLeaseFromRow(row: Record<string, SqlValue>): ChannelOwnerLease {
    return {
      accountId: asChannelAccountId(String(row.account_id)),
      ownerId: String(row.owner_id),
      kernelId: String(row.kernel_id) as KernelId,
      generation: Number(row.generation),
      leaseExpiresAt: String(row.lease_expires_at),
      updatedAt: String(row.updated_at),
    };
  }

  private channelMessageFromRow(row: Record<string, SqlValue>): CanonicalChannelMessage {
    const stored = (parseJson(row.payload_json) ?? {}) as {
      targetId?: string;
      text?: string;
      attachments?: CanonicalChannelMessage['attachments'];
      payload?: Record<string, unknown>;
    };
    return {
      id: String(row.id),
      accountId: asChannelAccountId(String(row.account_id)),
      externalConversationId: String(row.external_conversation_id),
      externalMessageId: String(row.external_message_id),
      direction: String(row.direction) as CanonicalChannelMessage['direction'],
      conversationId: asConversationId(String(row.conversation_id)),
      ...(row.turn_id ? { turnId: asTurnId(String(row.turn_id)) } : {}),
      ...(row.run_id ? { runId: asRunId(String(row.run_id)) } : {}),
      targetId: stored.targetId ?? '*',
      ...(stored.text !== undefined ? { text: stored.text } : {}),
      attachments: stored.attachments ?? [],
      payload: stored.payload ?? {},
      status: String(row.status) as ChannelMessageStatus,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at ?? row.created_at),
    };
  }

  putSkill(skill: CanonicalSkill): void {
    assertCanonicalSkill(skill);
    const canonical = { ...skill, projections: [] };
    this.write('skill.put', () => {
      this.db.prepare(`
        INSERT INTO skills(
          id, display_name, source, canonical_json, revision, created_at, updated_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          display_name = excluded.display_name,
          source = excluded.source,
          canonical_json = excluded.canonical_json,
          revision = excluded.revision,
          updated_at = excluded.updated_at,
          deleted_at = excluded.deleted_at
      `).run(
        skill.id,
        skill.displayName,
        skill.source.kind,
        json(canonical),
        skill.revision,
        skill.createdAt,
        skill.updatedAt,
        skill.deletedAt ?? null,
      );
    });
  }

  getSkill(id: string, includeDeleted = false): CanonicalSkill | undefined {
    const row = this.db.prepare(`
      SELECT id, display_name, source, canonical_json, revision, created_at, updated_at, deleted_at
      FROM skills WHERE id = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
    `).get(id) as Record<string, SqlValue> | undefined;
    return row ? this.skillFromRow(row) : undefined;
  }

  listSkills(includeDeleted = false): CanonicalSkill[] {
    const rows = this.db.prepare(`
      SELECT id, display_name, source, canonical_json, revision, created_at, updated_at, deleted_at
      FROM skills ${includeDeleted ? '' : 'WHERE deleted_at IS NULL'}
      ORDER BY display_name COLLATE NOCASE, id
    `).all() as Array<Record<string, SqlValue>>;
    return rows.map(row => this.skillFromRow(row));
  }

  deleteSkill(id: string, deletedAt: string): boolean {
    const existing = this.getSkill(id);
    if (!existing) return false;
    const deleted: CanonicalSkill = {
      ...existing,
      installedForKernels: [],
      enabledForKernels: [],
      projections: [],
      revision: existing.revision + 1,
      updatedAt: deletedAt,
      deletedAt,
    };
    return this.write('skill.delete', () => this.db.prepare(`
      UPDATE skills
      SET canonical_json = ?, revision = ?, updated_at = ?, deleted_at = ?
      WHERE id = ? AND deleted_at IS NULL
    `).run(json(deleted), deleted.revision, deletedAt, deletedAt, id).changes === 1);
  }

  private skillFromRow(row: Record<string, SqlValue>): CanonicalSkill {
    const parsed = parseJson(row.canonical_json) as CanonicalSkill;
    const projections = this.listProjections('skill', String(row.id)).map(projection => ({
      kernelId: String(projection.kernelId) as KernelId,
      ...(projection.nativeId ? { nativeId: String(projection.nativeId) } : {}),
      state: String(projection.status) as CanonicalSkill['projections'][number]['state'],
      desiredVersion: Number(projection.desiredVersion),
      ...(projection.appliedVersion === null || projection.appliedVersion === undefined
        ? {}
        : { appliedVersion: Number(projection.appliedVersion) }),
      ...(projection.error ? {
        error: { code: 'PROJECTION_ERROR', message: String(projection.error), retryable: true },
      } : {}),
      updatedAt: String(projection.updatedAt),
    }));
    return {
      ...parsed,
      id: asSkillId(String(row.id)),
      displayName: String(row.display_name),
      revision: Number(row.revision),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      ...(row.deleted_at ? { deletedAt: String(row.deleted_at) } : {}),
      projections,
    };
  }

  putAgent(agent: CanonicalAgent): void {
    assertCanonicalAgent(agent);
    const canonical = { ...agent, projections: [], defaultForKernels: [] };
    this.write('agent.put', () => {
      this.db.prepare(`
        INSERT INTO agents(
          id, display_name, canonical_json, version, created_at, updated_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          display_name = excluded.display_name,
          canonical_json = excluded.canonical_json,
          version = excluded.version,
          updated_at = excluded.updated_at,
          deleted_at = excluded.deleted_at
      `).run(
        agent.id,
        agent.displayName,
        json(canonical),
        agent.version,
        agent.createdAt,
        agent.updatedAt,
        agent.deletedAt ?? null,
      );
    });
  }

  getAgent(id: string, includeDeleted = false): CanonicalAgent | undefined {
    const row = this.db.prepare(`
      SELECT id, display_name, canonical_json, version, created_at, updated_at, deleted_at
      FROM agents WHERE id = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
    `).get(id) as Record<string, SqlValue> | undefined;
    return row ? this.agentFromRow(row) : undefined;
  }

  listAgents(includeDeleted = false): CanonicalAgent[] {
    const rows = this.db.prepare(`
      SELECT id, display_name, canonical_json, version, created_at, updated_at, deleted_at
      FROM agents ${includeDeleted ? '' : 'WHERE deleted_at IS NULL'}
      ORDER BY updated_at DESC, id ASC
    `).all() as Array<Record<string, SqlValue>>;
    return rows.map(row => this.agentFromRow(row));
  }

  deleteAgent(id: string, deletedAt: string): boolean {
    const existing = this.getAgent(id);
    if (!existing) return false;
    const deleted: CanonicalAgent = {
      ...existing,
      projections: [],
      defaultForKernels: [],
      enabled: false,
      version: existing.version + 1,
      updatedAt: deletedAt,
      deletedAt,
    };
    return this.write('agent.delete', () => {
      this.db.prepare('DELETE FROM agent_defaults WHERE agent_id = ?').run(id);
      return this.db.prepare(`
        UPDATE agents
        SET canonical_json = ?, version = ?, updated_at = ?, deleted_at = ?
        WHERE id = ? AND deleted_at IS NULL
      `).run(json(deleted), deleted.version, deletedAt, deletedAt, id).changes === 1;
    });
  }

  setAgentDefault(input: KernelAgentDefault): void {
    if (!input.kernelId || !input.agentId) throw new Error('Kernel Agent default identity is required');
    const agent = this.getAgent(input.agentId);
    if (!agent) throw new Error(`Agent not found: ${input.agentId}`);
    if (!agent.supportedKernels.includes(input.kernelId)) {
      throw new Error(`Agent ${input.agentId} does not support kernel ${input.kernelId}`);
    }
    this.write('agent.default.set', () => {
      this.db.prepare(`
        INSERT INTO agent_defaults(kernel_id, agent_id, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(kernel_id) DO UPDATE SET
          agent_id = excluded.agent_id,
          updated_at = excluded.updated_at
      `).run(input.kernelId, input.agentId, input.updatedAt);
    });
  }

  clearAgentDefault(kernelId: KernelId): boolean {
    return this.write('agent.default.clear', () => (
      this.db.prepare('DELETE FROM agent_defaults WHERE kernel_id = ?').run(kernelId).changes === 1
    ));
  }

  getAgentDefault(kernelId: KernelId): KernelAgentDefault | undefined {
    const row = this.db.prepare(`
      SELECT kernel_id, agent_id, updated_at FROM agent_defaults WHERE kernel_id = ?
    `).get(kernelId) as Record<string, SqlValue> | undefined;
    return row ? this.agentDefaultFromRow(row) : undefined;
  }

  listAgentDefaults(): KernelAgentDefault[] {
    const rows = this.db.prepare(`
      SELECT kernel_id, agent_id, updated_at FROM agent_defaults ORDER BY kernel_id
    `).all() as Array<Record<string, SqlValue>>;
    return rows.map(row => this.agentDefaultFromRow(row));
  }

  private agentFromRow(row: Record<string, SqlValue>): CanonicalAgent {
    const parsed = parseJson(row.canonical_json) as CanonicalAgent;
    const projections = this.listProjections('agent', String(row.id)).map(projection => ({
      kernelId: String(projection.kernelId) as KernelId,
      ...(projection.nativeId ? { nativeId: String(projection.nativeId) } : {}),
      state: String(projection.status) as CanonicalAgent['projections'][number]['state'],
      desiredVersion: Number(projection.desiredVersion),
      ...(projection.appliedVersion === null || projection.appliedVersion === undefined
        ? {}
        : { appliedVersion: Number(projection.appliedVersion) }),
      ...(projection.error ? {
        error: { code: 'PROJECTION_ERROR', message: String(projection.error), retryable: true },
      } : {}),
      updatedAt: String(projection.updatedAt),
    }));
    const defaults = this.db.prepare(`
      SELECT kernel_id FROM agent_defaults WHERE agent_id = ? ORDER BY kernel_id
    `).all(String(row.id)) as Array<{ kernel_id: string }>;
    return {
      ...parsed,
      id: asAgentId(String(row.id)),
      displayName: String(row.display_name),
      version: Number(row.version),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      ...(row.deleted_at ? { deletedAt: String(row.deleted_at) } : {}),
      defaultForKernels: defaults.map(value => value.kernel_id as KernelId),
      projections,
    };
  }

  private agentDefaultFromRow(row: Record<string, SqlValue>): KernelAgentDefault {
    return {
      kernelId: String(row.kernel_id) as KernelId,
      agentId: asAgentId(String(row.agent_id)),
      updatedAt: String(row.updated_at),
    };
  }

  putProvider(account: CanonicalProviderAccount): void {
    assertCanonicalProviderAccount(account);
    const canonical = { ...account, projections: [] };
    this.write('provider.put', () => {
      this.db.prepare(`
        INSERT INTO providers(
          id, display_name, credential_ref, canonical_json, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          display_name = excluded.display_name,
          credential_ref = excluded.credential_ref,
          canonical_json = excluded.canonical_json,
          version = excluded.version,
          updated_at = excluded.updated_at
      `).run(
        account.id,
        account.displayName,
        account.credentialRef ?? null,
        json(canonical),
        account.version,
        account.createdAt,
        account.updatedAt,
      );
    });
  }

  getProvider(id: string): CanonicalProviderAccount | undefined {
    const row = this.db.prepare(`
      SELECT id, display_name, credential_ref, canonical_json, version, created_at, updated_at
      FROM providers WHERE id = ?
    `).get(id) as Record<string, SqlValue> | undefined;
    return row ? this.providerFromRow(row) : undefined;
  }

  listProviders(): CanonicalProviderAccount[] {
    const rows = this.db.prepare(`
      SELECT id, display_name, credential_ref, canonical_json, version, created_at, updated_at
      FROM providers ORDER BY updated_at DESC, id ASC
    `).all() as Array<Record<string, SqlValue>>;
    return rows.map(row => this.providerFromRow(row));
  }

  deleteProvider(id: string): boolean {
    return this.write('provider.delete', () => {
      this.db.prepare(`DELETE FROM kernel_projections WHERE entity_type = 'provider' AND entity_id = ?`).run(id);
      return this.db.prepare('DELETE FROM providers WHERE id = ?').run(id).changes === 1;
    });
  }

  setProviderDefault(input: KernelProviderDefault): void {
    if (!input.kernelId || !input.accountId) throw new Error('Kernel provider default identity is required');
    this.write('provider.default.set', () => {
      const account = this.db.prepare('SELECT id FROM providers WHERE id = ?').get(input.accountId);
      if (!account) throw new Error(`Provider account not found: ${input.accountId}`);
      this.db.prepare(`
        INSERT INTO provider_defaults(kernel_id, account_id, model_id, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(kernel_id) DO UPDATE SET
          account_id = excluded.account_id,
          model_id = excluded.model_id,
          updated_at = excluded.updated_at
      `).run(input.kernelId, input.accountId, input.modelId ?? null, input.updatedAt);
    });
  }

  clearProviderDefault(kernelId: KernelId): boolean {
    return this.write('provider.default.clear', () => (
      this.db.prepare('DELETE FROM provider_defaults WHERE kernel_id = ?').run(kernelId).changes === 1
    ));
  }

  getProviderDefault(kernelId: KernelId): KernelProviderDefault | undefined {
    const row = this.db.prepare(`
      SELECT kernel_id, account_id, model_id, updated_at
      FROM provider_defaults WHERE kernel_id = ?
    `).get(kernelId) as Record<string, SqlValue> | undefined;
    return row ? this.providerDefaultFromRow(row) : undefined;
  }

  listProviderDefaults(): KernelProviderDefault[] {
    const rows = this.db.prepare(`
      SELECT kernel_id, account_id, model_id, updated_at
      FROM provider_defaults ORDER BY kernel_id
    `).all() as Array<Record<string, SqlValue>>;
    return rows.map(row => this.providerDefaultFromRow(row));
  }

  private providerFromRow(row: Record<string, SqlValue>): CanonicalProviderAccount {
    const parsed = parseJson(row.canonical_json) as CanonicalProviderAccount;
    const projections = this.listProjections('provider', String(row.id)).map(projection => ({
      kernelId: String(projection.kernelId) as KernelId,
      ...(projection.nativeId ? { nativeId: String(projection.nativeId) } : {}),
      state: String(projection.status) as CanonicalProviderAccount['projections'][number]['state'],
      desiredVersion: Number(projection.desiredVersion),
      ...(projection.appliedVersion === null || projection.appliedVersion === undefined
        ? {}
        : { appliedVersion: Number(projection.appliedVersion) }),
      ...(projection.error ? {
        error: { code: 'PROJECTION_ERROR', message: String(projection.error), retryable: true },
      } : {}),
      updatedAt: String(projection.updatedAt),
    }));
    return {
      ...parsed,
      id: asProviderAccountId(String(row.id)),
      displayName: String(row.display_name),
      ...(row.credential_ref ? { credentialRef: asCredentialReference(String(row.credential_ref)) } : {}),
      version: Number(row.version),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      projections,
    };
  }

  private providerDefaultFromRow(row: Record<string, SqlValue>): KernelProviderDefault {
    return {
      kernelId: String(row.kernel_id) as KernelId,
      accountId: asProviderAccountId(String(row.account_id)),
      ...(row.model_id ? { modelId: String(row.model_id) } : {}),
      updatedAt: String(row.updated_at),
    };
  }

  putOperation(input: {
    id: string;
    kind: string;
    targetType: string;
    targetId: string;
    desiredState: unknown;
    createdAt: string;
  }): void {
    this.write('operation.put', () => {
      this.db.prepare(`
        INSERT INTO operations(
          id, kind, target_type, target_id, desired_state_json, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          desired_state_json = excluded.desired_state_json,
          updated_at = excluded.updated_at
      `).run(
        input.id,
        input.kind,
        input.targetType,
        input.targetId,
        json(input.desiredState),
        input.createdAt,
        input.createdAt,
      );
    });
  }

  completeOperation(input: { id: string; ok: boolean; error?: string; updatedAt: string }): void {
    this.write('operation.complete', () => {
      const result = this.db.prepare(`
        UPDATE operations SET status = ?, error = ?, attempt = attempt + 1, updated_at = ?
        WHERE id = ?
      `).run(input.ok ? 'completed' : 'failed', input.error ?? null, input.updatedAt, input.id);
      if (result.changes !== 1) throw new Error(`Operation not found: ${input.id}`);
    });
  }

  upsertProjection(input: {
    entityType: string;
    entityId: string;
    kernelId: KernelId;
    desiredVersion: number;
    appliedVersion?: number;
    status: string;
    nativeId?: string;
    error?: string;
    updatedAt: string;
  }): void {
    this.write('projection.upsert', () => {
      this.db.prepare(`
        INSERT INTO kernel_projections(
          entity_type, entity_id, kernel_id, desired_version, applied_version,
          status, native_id, error, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(entity_type, entity_id, kernel_id) DO UPDATE SET
          desired_version = excluded.desired_version,
          applied_version = excluded.applied_version,
          status = excluded.status,
          native_id = excluded.native_id,
          error = excluded.error,
          updated_at = excluded.updated_at
      `).run(
        input.entityType,
        input.entityId,
        input.kernelId,
        input.desiredVersion,
        input.appliedVersion ?? null,
        input.status,
        input.nativeId ?? null,
        input.error ?? null,
        input.updatedAt,
      );
    });
  }

  deleteProjection(entityType: string, entityId: string, kernelId: KernelId): boolean {
    return this.write('projection.delete', () => {
      const result = this.db.prepare(`
        DELETE FROM kernel_projections
        WHERE entity_type = ? AND entity_id = ? AND kernel_id = ?
      `).run(entityType, entityId, kernelId);
      return result.changes === 1;
    });
  }

  listProjections(entityType: string, entityId: string): Array<Record<string, unknown>> {
    return this.db.prepare(`
      SELECT entity_type AS entityType, entity_id AS entityId, kernel_id AS kernelId,
        desired_version AS desiredVersion, applied_version AS appliedVersion,
        status, native_id AS nativeId, error, updated_at AS updatedAt
      FROM kernel_projections
      WHERE entity_type = ? AND entity_id = ?
      ORDER BY kernel_id
    `).all(entityType, entityId) as Array<Record<string, unknown>>;
  }

  getKernelCatalogState(channel: KernelCatalogStateRecord['channel']): KernelCatalogStateRecord | undefined {
    const row = this.db.prepare(`
      SELECT channel, highest_sequence, highest_catalog_sha256, cached_catalog_json,
        cached_catalog_sha256, etag, source_url, fetched_at, updated_at
      FROM kernel_catalog_state WHERE channel = ?
    `).get(channel) as Record<string, SqlValue> | undefined;
    if (!row) return undefined;
    return {
      channel: String(row.channel) as KernelCatalogStateRecord['channel'],
      highestSequence: Number(row.highest_sequence),
      ...(row.highest_catalog_sha256 ? { highestCatalogSha256: String(row.highest_catalog_sha256) } : {}),
      ...(row.cached_catalog_json ? { cachedCatalog: parseJson(row.cached_catalog_json) as KernelCatalogStateRecord['cachedCatalog'] } : {}),
      ...(row.cached_catalog_sha256 ? { cachedCatalogSha256: String(row.cached_catalog_sha256) } : {}),
      ...(row.etag ? { etag: String(row.etag) } : {}),
      ...(row.source_url ? { sourceUrl: String(row.source_url) } : {}),
      ...(row.fetched_at ? { fetchedAt: String(row.fetched_at) } : {}),
      updatedAt: String(row.updated_at),
    };
  }

  putKernelCatalogState(input: KernelCatalogStateRecord): void {
    this.write('kernel.catalog.put', () => {
      const existing = this.db.prepare(`
        SELECT highest_sequence, highest_catalog_sha256 FROM kernel_catalog_state WHERE channel = ?
      `).get(input.channel) as { highest_sequence: number; highest_catalog_sha256: string | null } | undefined;
      if (existing && input.highestSequence < existing.highest_sequence) {
        throw new Error('Kernel catalog trust state cannot move backwards');
      }
      if (existing && input.highestSequence === existing.highest_sequence
        && existing.highest_catalog_sha256 && input.highestCatalogSha256
        && existing.highest_catalog_sha256 !== input.highestCatalogSha256) {
        throw new Error('Kernel catalog sequence cannot be reused for different content');
      }
      this.db.prepare(`
        INSERT INTO kernel_catalog_state(
          channel, highest_sequence, highest_catalog_sha256, cached_catalog_json,
          cached_catalog_sha256, etag, source_url, fetched_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(channel) DO UPDATE SET
          highest_sequence = excluded.highest_sequence,
          highest_catalog_sha256 = excluded.highest_catalog_sha256,
          cached_catalog_json = excluded.cached_catalog_json,
          cached_catalog_sha256 = excluded.cached_catalog_sha256,
          etag = excluded.etag,
          source_url = excluded.source_url,
          fetched_at = excluded.fetched_at,
          updated_at = excluded.updated_at
      `).run(
        input.channel,
        input.highestSequence,
        input.highestCatalogSha256 ?? null,
        input.cachedCatalog ? json(input.cachedCatalog) : null,
        input.cachedCatalogSha256 ?? null,
        input.etag ?? null,
        input.sourceUrl ?? null,
        input.fetchedAt ?? null,
        input.updatedAt,
      );
    });
  }

  getKernelInstallation(kernelId: KernelId): KernelInstallationRecord | undefined {
    const row = this.db.prepare(`
      SELECT kernel_id, desired_version, active_version, last_known_good_version,
        state, manifest_json, last_error, updated_at
      FROM kernel_installations WHERE kernel_id = ?
    `).get(kernelId) as Record<string, SqlValue> | undefined;
    return row ? kernelInstallationFromRow(row) : undefined;
  }

  listKernelInstallations(): KernelInstallationRecord[] {
    return (this.db.prepare(`
      SELECT kernel_id, desired_version, active_version, last_known_good_version,
        state, manifest_json, last_error, updated_at
      FROM kernel_installations ORDER BY kernel_id
    `).all() as Array<Record<string, SqlValue>>).map(kernelInstallationFromRow);
  }

  putKernelInstallation(input: KernelInstallationRecord): void {
    this.write('kernel.installation.put', () => this.putKernelInstallationRow(input));
  }

  upsertKernelRuntimeVersion(input: KernelRuntimeVersionRecord): void {
    this.write('kernel.version.put', () => {
      this.db.prepare(`
        INSERT INTO kernel_runtime_versions(
          kernel_id, artifact_version, platform, arch, archive_sha256, state,
          manifest_json, installed_at, verified_at, last_scan_at, quarantine_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(kernel_id, artifact_version) DO UPDATE SET
          platform = excluded.platform,
          arch = excluded.arch,
          archive_sha256 = excluded.archive_sha256,
          state = excluded.state,
          manifest_json = excluded.manifest_json,
          verified_at = excluded.verified_at,
          last_scan_at = excluded.last_scan_at,
          quarantine_reason = excluded.quarantine_reason
      `).run(
        input.kernelId,
        input.artifactVersion,
        input.platform,
        input.arch,
        input.archiveSha256,
        input.state,
        json(input.manifest),
        input.installedAt,
        input.verifiedAt,
        input.lastScanAt ?? null,
        input.quarantineReason ?? null,
      );
    });
  }

  getKernelRuntimeVersion(kernelId: KernelId, artifactVersion: string): KernelRuntimeVersionRecord | undefined {
    const row = this.db.prepare(`
      SELECT kernel_id, artifact_version, platform, arch, archive_sha256, state,
        manifest_json, installed_at, verified_at, last_scan_at, quarantine_reason
      FROM kernel_runtime_versions WHERE kernel_id = ? AND artifact_version = ?
    `).get(kernelId, artifactVersion) as Record<string, SqlValue> | undefined;
    return row ? kernelRuntimeVersionFromRow(row) : undefined;
  }

  listKernelRuntimeVersions(kernelId?: KernelId): KernelRuntimeVersionRecord[] {
    const rows = (kernelId
      ? this.db.prepare(`
          SELECT kernel_id, artifact_version, platform, arch, archive_sha256, state,
            manifest_json, installed_at, verified_at, last_scan_at, quarantine_reason
          FROM kernel_runtime_versions WHERE kernel_id = ? ORDER BY artifact_version
        `).all(kernelId)
      : this.db.prepare(`
          SELECT kernel_id, artifact_version, platform, arch, archive_sha256, state,
            manifest_json, installed_at, verified_at, last_scan_at, quarantine_reason
          FROM kernel_runtime_versions ORDER BY kernel_id, artifact_version
        `).all()) as Array<Record<string, SqlValue>>;
    return rows.map(kernelRuntimeVersionFromRow);
  }

  removeKernelRuntimeVersion(kernelId: KernelId, artifactVersion: string): void {
    this.write('kernel.version.remove', () => {
      this.db.prepare('DELETE FROM kernel_runtime_versions WHERE kernel_id = ? AND artifact_version = ?')
        .run(kernelId, artifactVersion);
    });
  }

  commitKernelActivation(input: {
    kernelId: KernelId;
    activeVersion: string;
    lastKnownGoodVersion: string;
    expectedActiveVersion: string | null;
    reason: KernelActivationHistoryRecord['reason'];
    manifest: KernelInstallationRecord['manifest'];
    updatedAt: string;
  }): KernelInstallationRecord {
    return this.write('kernel.activation.commit', () => {
      const version = this.db.prepare(`
        SELECT state FROM kernel_runtime_versions WHERE kernel_id = ? AND artifact_version = ?
      `).get(input.kernelId, input.activeVersion) as { state: string } | undefined;
      if (version?.state !== 'verified') throw new Error('Only a verified runtime version can be activated');
      const current = this.getKernelInstallation(input.kernelId);
      if ((current?.activeVersion ?? null) !== input.expectedActiveVersion) {
        throw new Error('Kernel active version changed during activation');
      }
      const installation: KernelInstallationRecord = {
        kernelId: input.kernelId,
        desiredVersion: input.activeVersion,
        activeVersion: input.activeVersion,
        lastKnownGoodVersion: input.lastKnownGoodVersion,
        state: 'installed',
        ...(input.manifest ? { manifest: input.manifest } : {}),
        updatedAt: input.updatedAt,
      };
      this.putKernelInstallationRow(installation);
      this.db.prepare(`
        INSERT INTO kernel_activation_history(kernel_id, from_version, to_version, reason, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(input.kernelId, current?.activeVersion ?? null, input.activeVersion, input.reason, input.updatedAt);
      return installation;
    });
  }

  listKernelActivationHistory(kernelId: KernelId, limit = 100): KernelActivationHistoryRecord[] {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 1_000);
    return (this.db.prepare(`
      SELECT id, kernel_id, from_version, to_version, reason, created_at
      FROM kernel_activation_history WHERE kernel_id = ? ORDER BY id DESC LIMIT ?
    `).all(kernelId, safeLimit) as Array<Record<string, SqlValue>>).map(row => ({
      id: Number(row.id),
      kernelId: String(row.kernel_id),
      ...(row.from_version ? { fromVersion: String(row.from_version) } : {}),
      toVersion: String(row.to_version),
      reason: String(row.reason) as KernelActivationHistoryRecord['reason'],
      createdAt: String(row.created_at),
    }));
  }

  integrityCheck(): string {
    const row = this.db.prepare('PRAGMA quick_check').get() as Record<string, unknown>;
    return String(Object.values(row)[0]);
  }

  async backupTo(path: string): Promise<void> {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    await backup(this.db, path);
  }

  close(): void {
    this.db.close();
  }

  private putKernelInstallationRow(input: KernelInstallationRecord): void {
    this.db.prepare(`
      INSERT INTO kernel_installations(
        kernel_id, desired_version, active_version, last_known_good_version,
        state, manifest_json, last_error, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(kernel_id) DO UPDATE SET
        desired_version = excluded.desired_version,
        active_version = excluded.active_version,
        last_known_good_version = excluded.last_known_good_version,
        state = excluded.state,
        manifest_json = excluded.manifest_json,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `).run(
      input.kernelId,
      input.desiredVersion ?? null,
      input.activeVersion ?? null,
      input.lastKnownGoodVersion ?? null,
      input.state,
      input.manifest ? json(input.manifest) : null,
      input.lastError ?? null,
      input.updatedAt,
    );
  }

  private insertBlocks(turnId: string, blocks: CanonicalContentBlock[], createdAt: string): void {
    const statement = this.db.prepare(`
      INSERT INTO content_blocks(
        id, turn_id, position, type, visibility, kernel_id, mime_type,
        text_content, json_content, blob_hash, revoked_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    blocks.forEach((block, position) => {
      statement.run(
        block.id,
        turnId,
        position,
        block.type,
        block.visibility,
        block.kernelId ?? null,
        block.mimeType ?? null,
        block.text ?? null,
        block.json === undefined ? null : json(block.json),
        block.blobHash ?? null,
        block.revoked ? createdAt : null,
        createdAt,
      );
    });
  }

  private refreshConversationSearch(conversationId: string): void {
    const conversation = this.db.prepare('SELECT title FROM conversations WHERE id = ?').get(conversationId) as { title: string | null } | undefined;
    if (!conversation) return;
    this.db.prepare('DELETE FROM conversation_fts WHERE conversation_id = ?').run(conversationId);
    const turns = this.db.prepare(`
      SELECT t.id AS turn_id, GROUP_CONCAT(COALESCE(b.text_content, ''), '\n') AS content
      FROM turns t
      LEFT JOIN content_blocks b ON b.turn_id = t.id AND b.revoked_at IS NULL AND b.visibility = 'portable'
      WHERE t.conversation_id = ?
      GROUP BY t.id, t.position
      ORDER BY t.position
    `).all(conversationId) as Array<{ turn_id: string; content: string }>;
    const insert = this.db.prepare('INSERT INTO conversation_fts(conversation_id, turn_id, title, content) VALUES (?, ?, ?, ?)');
    for (const turn of turns) insert.run(conversationId, turn.turn_id, conversation.title ?? '', turn.content ?? '');
    if (turns.length === 0) insert.run(conversationId, '', conversation.title ?? '', '');
  }
}

function kernelInstallationFromRow(row: Record<string, SqlValue>): KernelInstallationRecord {
  return {
    kernelId: String(row.kernel_id),
    ...(row.desired_version ? { desiredVersion: String(row.desired_version) } : {}),
    ...(row.active_version ? { activeVersion: String(row.active_version) } : {}),
    ...(row.last_known_good_version ? { lastKnownGoodVersion: String(row.last_known_good_version) } : {}),
    state: String(row.state) as KernelInstallationRecord['state'],
    ...(row.manifest_json ? { manifest: parseJson(row.manifest_json) as KernelInstallationRecord['manifest'] } : {}),
    ...(row.last_error ? { lastError: String(row.last_error) } : {}),
    updatedAt: String(row.updated_at),
  };
}

function kernelRuntimeVersionFromRow(row: Record<string, SqlValue>): KernelRuntimeVersionRecord {
  return {
    kernelId: String(row.kernel_id),
    artifactVersion: String(row.artifact_version),
    platform: String(row.platform),
    arch: String(row.arch),
    archiveSha256: String(row.archive_sha256),
    state: String(row.state) as KernelRuntimeVersionRecord['state'],
    manifest: parseJson(row.manifest_json) as KernelRuntimeVersionRecord['manifest'],
    installedAt: String(row.installed_at),
    verifiedAt: String(row.verified_at),
    ...(row.last_scan_at ? { lastScanAt: String(row.last_scan_at) } : {}),
    ...(row.quarantine_reason ? { quarantineReason: String(row.quarantine_reason) } : {}),
  };
}
