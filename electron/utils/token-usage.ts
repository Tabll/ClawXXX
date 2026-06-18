import { readdir, readFile, stat } from 'fs/promises';
import { basename, join } from 'path';
import { getOpenClawConfigDir } from './paths';
import { logger } from './logger';
import {
  extractSessionIdFromTranscriptFileName,
  normalizeTokenUsageContextWeight,
  normalizeTokenUsageSessionMetadata,
  parseUsageEntriesFromJsonl,
  type TokenUsageContextWeight,
  type TokenUsageHistoryEntry,
  type TokenUsageSessionMetadata,
} from './token-usage-core';
import { listConfiguredAgentIds } from './agent-config';

export {
  extractSessionIdFromTranscriptFileName,
  normalizeTokenUsageContextWeight,
  normalizeTokenUsageSessionMetadata,
  parseUsageEntriesFromJsonl,
  type TokenUsageContextWeight,
  type TokenUsageHistoryEntry,
  type TokenUsageSessionMetadata,
} from './token-usage-core';

type SessionStoreRecord = {
  key?: string;
  value: Record<string, unknown>;
};

type SessionUsageContext = {
  contextWeight?: TokenUsageContextWeight;
  sessionMeta?: TokenUsageSessionMetadata;
};

async function listAgentIdsWithSessionDirs(): Promise<string[]> {
  const openclawDir = getOpenClawConfigDir();
  const agentsDir = join(openclawDir, 'agents');
  const agentIds = new Set<string>();

  try {
    for (const agentId of await listConfiguredAgentIds()) {
      const normalized = agentId.trim();
      if (normalized) {
        agentIds.add(normalized);
      }
    }
  } catch {
    // Ignore config discovery failures and fall back to disk scan.
  }

  try {
    const agentEntries = await readdir(agentsDir, { withFileTypes: true });
    for (const entry of agentEntries) {
      if (entry.isDirectory()) {
        const normalized = entry.name.trim();
        if (normalized) {
          agentIds.add(normalized);
        }
      }
    }
  } catch {
    // Ignore disk discovery failures and return whatever we already found.
  }

  return [...agentIds];
}

async function listRecentSessionFiles(): Promise<Array<{ filePath: string; sessionId: string; agentId: string; mtimeMs: number }>> {
  const openclawDir = getOpenClawConfigDir();
  const agentsDir = join(openclawDir, 'agents');

  try {
    const agentEntries = await listAgentIdsWithSessionDirs();
    const files: Array<{ filePath: string; sessionId: string; agentId: string; mtimeMs: number }> = [];

    for (const agentId of agentEntries) {
      const sessionsDir = join(agentsDir, agentId, 'sessions');
      try {
        const sessionEntries = await readdir(sessionsDir);

        for (const fileName of sessionEntries) {
          const sessionId = extractSessionIdFromTranscriptFileName(fileName);
          if (!sessionId) continue;
          const filePath = join(sessionsDir, fileName);
          try {
            const fileStat = await stat(filePath);
            files.push({
              filePath,
              sessionId,
              agentId,
              mtimeMs: fileStat.mtimeMs,
            });
          } catch {
            continue;
          }
        }
      } catch {
        continue;
      }
    }

    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return files;
  } catch {
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeSessionIdCandidate(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return basename(trimmed)
    .replace(/\.deleted\.jsonl$/, '')
    .replace(/\.jsonl(?:\.reset\..+)?$/, '');
}

function collectSessionStoreRecords(store: Record<string, unknown>): SessionStoreRecord[] {
  const records: SessionStoreRecord[] = [];
  for (const [key, value] of Object.entries(store)) {
    if (key === 'sessions' || !isRecord(value)) continue;
    records.push({ key, value });
  }
  if (Array.isArray(store.sessions)) {
    for (const value of store.sessions) {
      if (!isRecord(value)) continue;
      const key = typeof value.key === 'string'
        ? value.key
        : typeof value.sessionKey === 'string'
          ? value.sessionKey
          : undefined;
      records.push({ key, value });
    }
  }
  return records;
}

function collectContextSessionIds(record: SessionStoreRecord): string[] {
  const ids = new Set<string>();
  const add = (value: unknown) => {
    const normalized = normalizeSessionIdCandidate(value);
    if (normalized) ids.add(normalized);
  };
  add(record.key);
  add(record.value.id);
  add(record.value.sessionId);
  add(record.value.currentSessionId);
  add(record.value.sessionFile);
  add(record.value.file);
  add(record.value.fileName);
  add(record.value.path);
  if (Array.isArray(record.value.usageFamilySessionIds)) {
    for (const sessionId of record.value.usageFamilySessionIds) add(sessionId);
  }
  if (Array.isArray(record.value.includedSessionIds)) {
    for (const sessionId of record.value.includedSessionIds) add(sessionId);
  }
  return [...ids];
}

async function loadSessionContexts(agentIds: string[]): Promise<Map<string, SessionUsageContext>> {
  const openclawDir = getOpenClawConfigDir();
  const agentsDir = join(openclawDir, 'agents');
  const contextBySession = new Map<string, SessionUsageContext>();

  for (const agentId of agentIds) {
    const sessionsJsonPath = join(agentsDir, agentId, 'sessions', 'sessions.json');
    let parsed: Record<string, unknown>;
    try {
      const raw = await readFile(sessionsJsonPath, 'utf8');
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }

    for (const record of collectSessionStoreRecords(parsed)) {
      const contextWeight = normalizeTokenUsageContextWeight(record.value.systemPromptReport);
      const sessionMeta = normalizeTokenUsageSessionMetadata(record.value, record.key);
      if (!contextWeight && !sessionMeta) continue;
      for (const sessionId of collectContextSessionIds(record)) {
        contextBySession.set(`${agentId}::${sessionId}`, {
          ...(contextWeight ? { contextWeight } : {}),
          ...(sessionMeta ? { sessionMeta } : {}),
        });
      }
    }
  }

  return contextBySession;
}

export async function getRecentTokenUsageHistory(limit?: number): Promise<TokenUsageHistoryEntry[]> {
  const files = await listRecentSessionFiles();
  const contextBySession = await loadSessionContexts([...new Set(files.map((file) => file.agentId))]);
  const results: TokenUsageHistoryEntry[] = [];
  const maxEntries = typeof limit === 'number' && Number.isFinite(limit)
    ? Math.max(Math.floor(limit), 0)
    : Number.POSITIVE_INFINITY;

  for (const file of files) {
    if (results.length >= maxEntries) break;
    try {
      const content = await readFile(file.filePath, 'utf8');
      const sessionContext = contextBySession.get(`${file.agentId}::${file.sessionId}`);
      const entries = parseUsageEntriesFromJsonl(content, {
        sessionId: file.sessionId,
        agentId: file.agentId,
        ...(sessionContext?.contextWeight ? { contextWeight: sessionContext.contextWeight } : {}),
        ...(sessionContext?.sessionMeta ? { sessionMeta: sessionContext.sessionMeta } : {}),
      }, Number.isFinite(maxEntries) ? maxEntries - results.length : undefined);
      results.push(...entries);
    } catch (error) {
      logger.debug(`Failed to read token usage transcript ${file.filePath}:`, error);
    }
  }

  results.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  return Number.isFinite(maxEntries) ? results.slice(0, maxEntries) : results;
}
