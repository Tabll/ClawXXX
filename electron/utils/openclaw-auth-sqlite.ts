/**
 * OpenClaw 2026.6+ persists agent auth in openclaw-agent.sqlite.
 * ClawX historically wrote auth-profiles.json only; gateway runtime reads SQLite.
 */
import { existsSync } from 'fs';
import { access, readFile } from 'fs/promises';
import { constants } from 'fs';
import { join } from 'path';
import { DatabaseSync } from 'node:sqlite';
import { getOpenClawConfigDir } from './paths';
import { writeOpenClawAgentAuth } from './openclaw-agent-auth-writer';

const AUTH_PROFILE_FILENAME = 'auth-profiles.json';
const AUTH_SQLITE_FILENAME = 'openclaw-agent.sqlite';
const PRIMARY_ROW_KEY = 'primary';

export interface PersistedAuthProfileCredential {
  type: string;
  provider: string;
  key?: string;
  access?: string;
  refresh?: string;
  expires?: number;
  email?: string;
  projectId?: string;
  [extra: string]: unknown;
}

export interface PersistedAuthProfilesStore {
  version: number;
  profiles: Record<string, PersistedAuthProfileCredential>;
  order?: Record<string, string[]>;
  lastGood?: Record<string, string>;
  usageStats?: Record<string, unknown>;
}

function getAgentAuthDir(agentId: string): string {
  return join(getOpenClawConfigDir(), 'agents', agentId, 'agent');
}

export function getAuthProfilesJsonPath(agentId: string): string {
  return join(getAgentAuthDir(agentId), AUTH_PROFILE_FILENAME);
}

export function getAuthProfilesSqlitePath(agentId: string): string {
  return join(getAgentAuthDir(agentId), AUTH_SQLITE_FILENAME);
}


function parseJsonCell(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function coerceAuthProfilesStore(raw: Record<string, unknown> | null): PersistedAuthProfilesStore | null {
  if (!raw || typeof raw !== 'object') return null;
  const profiles = raw.profiles;
  if (!profiles || typeof profiles !== 'object') return null;
  const version = typeof raw.version === 'number' ? raw.version : 1;
  const store: PersistedAuthProfilesStore = {
    version,
    profiles: profiles as Record<string, PersistedAuthProfileCredential>,
  };
  if (raw.order && typeof raw.order === 'object') {
    store.order = raw.order as Record<string, string[]>;
  }
  if (raw.lastGood && typeof raw.lastGood === 'object') {
    store.lastGood = raw.lastGood as Record<string, string>;
  }
  if (raw.usageStats && typeof raw.usageStats === 'object') {
    store.usageStats = raw.usageStats as Record<string, unknown>;
  }
  return store;
}

function buildSecretsPayload(store: PersistedAuthProfilesStore): Record<string, unknown> {
  return {
    version: store.version ?? 1,
    profiles: store.profiles,
  };
}

function buildStatePayload(store: PersistedAuthProfilesStore): Record<string, unknown> | null {
  if (!store.order && !store.lastGood && !store.usageStats) {
    return null;
  }
  return {
    version: 1,
    ...(store.order ? { order: store.order } : {}),
    ...(store.lastGood ? { lastGood: store.lastGood } : {}),
    ...(store.usageStats ? { usageStats: store.usageStats } : {}),
  };
}

function mergeStoreAndState(
  secrets: Record<string, unknown> | null,
  state: Record<string, unknown> | null,
): PersistedAuthProfilesStore | null {
  const base = coerceAuthProfilesStore(secrets);
  if (!base) return null;
  if (!state) return base;
  if (state.order && typeof state.order === 'object') {
    base.order = state.order as Record<string, string[]>;
  }
  if (state.lastGood && typeof state.lastGood === 'object') {
    base.lastGood = state.lastGood as Record<string, string>;
  }
  if (state.usageStats && typeof state.usageStats === 'object') {
    base.usageStats = state.usageStats as Record<string, unknown>;
  }
  return base;
}

function hasPersistedProfiles(store: PersistedAuthProfilesStore | null | undefined): boolean {
  return !!store && Object.keys(store.profiles).length > 0;
}

export function readAuthProfilesFromSqlite(agentId: string): PersistedAuthProfilesStore | null {
  const sqlitePath = getAuthProfilesSqlitePath(agentId);
  if (!existsSync(sqlitePath)) {
    return null;
  }

  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    const storeRow = db.prepare(
      'SELECT store_json FROM auth_profile_store WHERE store_key = ?',
    ).get(PRIMARY_ROW_KEY) as { store_json?: string } | undefined;
    const stateRow = db.prepare(
      'SELECT state_json FROM auth_profile_state WHERE state_key = ?',
    ).get(PRIMARY_ROW_KEY) as { state_json?: string } | undefined;
    return mergeStoreAndState(
      parseJsonCell(storeRow?.store_json),
      parseJsonCell(stateRow?.state_json),
    );
  } catch (error) {
    console.warn(`Failed to read auth profiles from SQLite (${sqlitePath}):`, error);
    return null;
  } finally {
    db.close();
  }
}

export async function writeAuthProfilesToSqlite(
  store: PersistedAuthProfilesStore,
  agentId: string,
): Promise<void> {
  await writeOpenClawAgentAuth(agentId, buildSecretsPayload(store), buildStatePayload(store));
}

export async function readAuthProfilesJson(agentId: string): Promise<PersistedAuthProfilesStore | null> {
  const jsonPath = getAuthProfilesJsonPath(agentId);
  try {
    await access(jsonPath, constants.F_OK);
    const raw = JSON.parse(await readFile(jsonPath, 'utf-8')) as Record<string, unknown>;
    return coerceAuthProfilesStore(raw);
  } catch {
    return null;
  }
}

export async function migrateAuthProfilesJsonToSqliteIfNeeded(agentId: string): Promise<boolean> {
  const sqliteStore = readAuthProfilesFromSqlite(agentId);
  if (hasPersistedProfiles(sqliteStore)) {
    return false;
  }

  const jsonStore = await readAuthProfilesJson(agentId);
  if (!hasPersistedProfiles(jsonStore)) {
    return false;
  }

  await writeAuthProfilesToSqlite(jsonStore!, agentId);
  console.log(
    `[auth-sync] Migrated auth-profiles.json to SQLite for agent "${agentId}"`,
  );
  return true;
}
