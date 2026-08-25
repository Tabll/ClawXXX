import { create } from 'zustand';
import { hostApi } from '@/lib/host-api';
import {
  asConversationId,
  type ConversationQueryFilters,
  type ConversationSummary,
} from '@shared/conversations/contracts';
import { useSessionAttentionStore } from './session-attention';
import {
  DEFAULT_SESSION_KEY,
  type ChatSession,
  type ChatState,
} from './chat/types';

export type { ChatSession } from './chat/types';

let loadInFlight: Promise<void> | null = null;
let reloadQueued = false;
let localId = 0;

/** Legacy Gateway epochs no longer own Conversation catalog freshness. */
export function synchronizeGatewaySessionGeneration(_generation: number): void {
  // Intentionally empty: canonical catalog state comes from DataService.
}

function agentIdFromKey(key: string): string {
  if (!key.startsWith('agent:')) return 'main';
  return key.split(':')[1] || 'main';
}

function pathFromWorkspaceUri(uri: string | undefined): string | undefined {
  if (!uri) return undefined;
  if (!uri.startsWith('file:')) return uri;
  try {
    const pathname = decodeURIComponent(new URL(uri).pathname);
    return /^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1) : pathname;
  } catch {
    return undefined;
  }
}

function rowToSession(row: ConversationSummary): ChatSession {
  const updatedAt = Date.parse(row.updatedAt);
  const workspacePath = pathFromWorkspaceUri(row.workspaceUri);
  return {
    key: row.id,
    displayName: row.title || row.id,
    ...(row.title ? { label: row.title, derivedTitle: row.title } : {}),
    ...(Number.isFinite(updatedAt) ? { updatedAt } : {}),
    ...(row.pinnedAt ? { pinned: true } : {}),
    ...(row.hasActiveRun ? { hasActiveRun: true, status: 'running' } : {}),
    ...(row.lastKernelId ? { kernelId: row.lastKernelId } : {}),
    ...(row.kernelIds ? { kernelIds: row.kernelIds } : {}),
    ...(row.lastAgentId ? { agentId: row.lastAgentId } : {}),
    ...(row.sourceChannel ? { sourceChannel: row.sourceChannel, channel: row.sourceChannel } : {}),
    ...(workspacePath ? { workspacePath } : {}),
  };
}

const CATALOG_PAGE_SIZE = 100;

function newConversationKey(agentId = 'main'): string {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${localId += 1}`;
  return `agent:${agentId}:conversation-${suffix}`;
}

function ensureSession(sessions: ChatSession[], key: string, workspacePath?: string): ChatSession[] {
  const existing = sessions.find(session => session.key === key);
  if (existing) {
    if (!workspacePath || existing.workspacePath === workspacePath) return sessions;
    return sessions.map(session => session.key === key ? { ...session, workspacePath } : session);
  }
  return [...sessions, {
    key,
    displayName: key,
    createdLocally: true,
    ...(workspacePath ? { workspacePath } : {}),
  }];
}

function chooseSelection(current: string, sessions: ChatSession[]): string {
  if (sessions.some(session => session.key === current)) return current;
  const first = [...sessions].sort((left, right) => {
    if (Boolean(left.pinned) !== Boolean(right.pinned)) return left.pinned ? -1 : 1;
    return (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
  })[0];
  return first?.key ?? DEFAULT_SESSION_KEY;
}

function withoutKeys<T>(record: Record<string, T>, keys: ReadonlySet<string>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !keys.has(key)));
}

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: [],
  sessionCatalogReady: false,
  sessionCatalogLoading: false,
  sessionNextCursor: undefined,
  currentSessionKey: DEFAULT_SESSION_KEY,
  currentAgentId: 'main',
  sessionLabels: {},
  sessionLastActivity: {},

  loadSessions: async (options) => {
    if (loadInFlight) {
      if (options?.force) reloadQueued = true;
      await loadInFlight;
      return;
    }

    const run = async () => {
      do {
        reloadQueued = false;
        set({ sessionCatalogLoading: true });
        try {
          const page = await hostApi.conversations.list({ limit: CATALOG_PAGE_SIZE });
          const canonical = page.items.map(rowToSession);
          set((state) => {
            const byKey = new Map(canonical.map(session => [session.key, session] as const));
            for (const local of state.sessions) {
              if (!local.createdLocally || byKey.has(local.key)) continue;
              byKey.set(local.key, local);
            }
            const sessions = [...byKey.values()];
            const currentSessionKey = chooseSelection(state.currentSessionKey, sessions);
            const sessionLabels = Object.fromEntries(sessions.flatMap(session => {
              const label = session.label?.trim();
              return label ? [[session.key, label]] : [];
            }));
            const sessionLastActivity = Object.fromEntries(sessions.flatMap(session => (
              typeof session.updatedAt === 'number' ? [[session.key, session.updatedAt]] : []
            )));
            useSessionAttentionStore.getState().reconcileSessionRows(sessions);
            return {
              sessions,
              sessionCatalogReady: true,
              sessionCatalogLoading: false,
              sessionNextCursor: page.nextCursor,
              currentSessionKey,
              currentAgentId: agentIdFromKey(currentSessionKey),
              sessionLabels,
              sessionLastActivity,
            };
          });
        } catch (error) {
          console.warn('Failed to load canonical Conversation catalog:', error);
          set({ sessionCatalogReady: false, sessionCatalogLoading: false });
        }
      } while (reloadQueued);
    };

    loadInFlight = run();
    try {
      await loadInFlight;
    } finally {
      loadInFlight = null;
    }
  },

  loadMoreSessions: async () => {
    const cursor = get().sessionNextCursor;
    if (!cursor || get().sessionCatalogLoading) return;
    set({ sessionCatalogLoading: true });
    try {
      const page = await hostApi.conversations.list({ limit: CATALOG_PAGE_SIZE, cursor });
      if (page.nextCursor && page.nextCursor === cursor) {
        throw new Error('Repeated Conversation page cursor');
      }
      const nextRows = page.items.map(rowToSession);
      set(state => {
        const byKey = new Map(state.sessions.map(session => [session.key, session] as const));
        nextRows.forEach(session => byKey.set(session.key, session));
        const sessions = [...byKey.values()];
        useSessionAttentionStore.getState().reconcileSessionRows(sessions);
        return {
          sessions,
          sessionCatalogLoading: false,
          sessionNextCursor: page.nextCursor,
        };
      });
    } catch (error) {
      console.warn('Failed to load more Conversations:', error);
      set({ sessionCatalogLoading: false, sessionNextCursor: undefined });
    }
  },

  searchSessions: async (query, filters: ConversationQueryFilters = {}) => {
    const normalized = query.trim();
    const rows = normalized
      ? await hostApi.conversations.search(normalized, { ...filters, limit: 50 })
      : (await hostApi.conversations.list({ ...filters, limit: 50 })).items;
    const results = rows.map(rowToSession);
    set(state => {
      const byKey = new Map(state.sessions.map(session => [session.key, session] as const));
      results.forEach(session => byKey.set(session.key, session));
      return { sessions: [...byKey.values()] };
    });
    return results;
  },

  exportSession: async (key) => {
    try {
      const exported = await hostApi.conversations.export(asConversationId(key));
      const blob = new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `clawx-conversation-${key.replace(/[^A-Za-z0-9._-]+/g, '-')}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  handleSessionsChanged: () => {
    void get().loadSessions({ force: true });
  },

  handleConversationCatalogChanged: (payload) => {
    const updatedAt = Date.parse(payload.updatedAt);
    const existing = get().sessions.some(session => session.key === payload.conversationId);
    if (!existing) {
      void get().loadSessions({ force: true });
      return;
    }
    set(state => {
      const sessions = state.sessions.map(session => (
        session.key === payload.conversationId
          ? {
              ...session,
              kernelId: payload.kernelId,
              kernelIds: [...new Set([...(session.kernelIds ?? []), payload.kernelId])],
              hasActiveRun: payload.hasActiveRun,
              status: payload.hasActiveRun ? 'running' : 'done',
              ...(Number.isFinite(updatedAt) ? { updatedAt } : {}),
            }
          : session
      ));
      useSessionAttentionStore.getState().reconcileSessionRows(sessions);
      return {
        sessions,
        ...(Number.isFinite(updatedAt) ? {
          sessionLastActivity: {
            ...state.sessionLastActivity,
            [payload.conversationId]: updatedAt,
          },
        } : {}),
      };
    });
  },

  switchSession: (key) => {
    if (!key || key === get().currentSessionKey) return;
    set(state => ({
      sessions: ensureSession(state.sessions, key),
      currentSessionKey: key,
      currentAgentId: agentIdFromKey(key),
    }));
  },

  selectAcpSession: (key, workspacePath) => {
    if (!key) return;
    set(state => ({
      sessions: ensureSession(state.sessions, key, workspacePath),
      currentSessionKey: key,
      currentAgentId: agentIdFromKey(key),
    }));
  },

  newSession: () => {
    const key = newConversationKey(get().currentAgentId);
    set(state => ({
      sessions: ensureSession(state.sessions.filter(session => !session.createdLocally), key),
      currentSessionKey: key,
    }));
  },

  acknowledgeAcpSessionCreated: (key, workspacePath, initialPrompt) => {
    const title = initialPrompt?.trim().slice(0, 50);
    set(state => ({
      sessions: ensureSession(state.sessions, key, workspacePath).map(session => {
        if (session.key !== key) return session;
        const acknowledged = { ...session };
        delete acknowledged.createdLocally;
        return { ...acknowledged, ...(title ? { label: title, derivedTitle: title } : {}) };
      }),
      ...(title ? { sessionLabels: { ...state.sessionLabels, [key]: title } } : {}),
    }));
    void get().loadSessions({ force: true });
  },

  deleteSession: async (key) => {
    try {
      const result = await hostApi.conversations.delete(asConversationId(key), true);
      if (!result.success) return { success: false, error: result.error || 'Failed to delete Conversation' };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
    const removed = new Set([key]);
    useSessionAttentionStore.getState().removeSession(key);
    set(state => {
      const sessions = state.sessions.filter(session => session.key !== key);
      const currentSessionKey = chooseSelection(state.currentSessionKey, sessions);
      return {
        sessions,
        currentSessionKey,
        currentAgentId: agentIdFromKey(currentSessionKey),
        sessionLabels: withoutKeys(state.sessionLabels, removed),
        sessionLastActivity: withoutKeys(state.sessionLastActivity, removed),
      };
    });
    return { success: true };
  },

  deleteSessions: async (keys) => {
    const requested = [...new Set(keys.filter(Boolean))];
    const results = await Promise.all(requested.map(async key => {
      try {
        const result = await hostApi.conversations.delete(asConversationId(key), true);
        return [key, result.success] as const;
      } catch {
        return [key, false] as const;
      }
    }));
    const deletedKeys = results.filter(([, ok]) => ok).map(([key]) => key);
    const failedKeys = results.filter(([, ok]) => !ok).map(([key]) => key);
    const removed = new Set(deletedKeys);
    for (const key of removed) useSessionAttentionStore.getState().removeSession(key);
    if (removed.size > 0) {
      set(state => {
        const sessions = state.sessions.filter(session => !removed.has(session.key));
        const currentSessionKey = chooseSelection(state.currentSessionKey, sessions);
        return {
          sessions,
          currentSessionKey,
          currentAgentId: agentIdFromKey(currentSessionKey),
          sessionLabels: withoutKeys(state.sessionLabels, removed),
          sessionLastActivity: withoutKeys(state.sessionLastActivity, removed),
        };
      });
    }
    return { deletedKeys, failedKeys };
  },

  renameSession: async (key, label) => {
    const title = label.trim();
    if (!title) throw new Error('Conversation title cannot be empty');
    const result = await hostApi.conversations.rename(asConversationId(key), title);
    if (!result.success) throw new Error(result.error || 'Failed to rename Conversation');
    set(state => ({
      sessions: state.sessions.map(session => (
        session.key === key ? { ...session, label: title, displayName: title, derivedTitle: title } : session
      )),
      sessionLabels: { ...state.sessionLabels, [key]: title },
    }));
  },

  setSessionPinned: async (key, pinned) => {
    const result = await hostApi.conversations.pin(asConversationId(key), pinned);
    if (!result.success) throw new Error(result.error || 'Failed to update Conversation pin');
    set(state => ({
      sessions: state.sessions.map(session => session.key === key ? { ...session, pinned } : session),
    }));
  },
}));
