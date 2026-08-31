import { Context } from '@deepseek-ai/cordis'
import type {
  SessionEvent,
  SessionHeader,
  SessionId,
  SessionPreparation,
} from '@deepseek-ai/dsh-session'
import {
  DEFAULT_PREPARED_SESSION_CACHE_SIZE,
  DEFAULT_WRITE_BATCH_MAX_DELAY_MS,
  PersistenceCoordinator,
  SessionPersistence,
  SessionPersistenceRevision,
  type PersistenceBackend,
  type BorrowedSessionSource,
  type SessionInspection,
  type SessionLocation,
  type SessionPersistenceSnapshot,
  type StoredPrefix,
  type StoredSuffix,
} from '@deepseek-ai/dsh-session-persistence'

export const CLAWX_DSH_STORE_PROTOCOL = 'clawx.dsh-session-store/v1' as const

export interface ClawXStoredSession {
  readonly meta: SessionHeader
  readonly events: SessionEvent[]
  readonly revision: string
  readonly tornFrom?: number
}

export interface ClawXSessionStoreClient {
  load(id: SessionId, signal?: AbortSignal): Promise<ClawXStoredSession | undefined>
  revision(id: SessionId, signal?: AbortSignal): Promise<string | undefined>
  loadFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<{
    meta: SessionHeader
    events: SessionEvent[]
  } | undefined>
  append(input: {
    protocol: typeof CLAWX_DSH_STORE_PROTOCOL
    meta: SessionHeader
    events: readonly SessionEvent[]
    isMaterialized: boolean
  }): Promise<void>
  repair(input: {
    protocol: typeof CLAWX_DSH_STORE_PROTOCOL
    meta: SessionHeader
    tornFrom?: number
    closers: readonly SessionEvent[]
  }): Promise<void>
  list(signal?: AbortSignal): Promise<Array<{ meta: SessionHeader; revision: string }>>
  close?(): Promise<void>
}

export interface Config {
  readonly client: ClawXSessionStoreClient
  readonly preparedSessionCacheSize?: number
  readonly writeBatchMaxDelayMs?: number
}

class ClawXPersistenceBackend implements PersistenceBackend<number> {
  readonly name = 'session-persistence-clawx'

  constructor(private readonly client: ClawXSessionStoreClient) {}

  async loadStored(id: SessionId, signal?: AbortSignal): Promise<StoredPrefix<number> | undefined> {
    signal?.throwIfAborted()
    const stored = await this.client.load(id, signal)
    signal?.throwIfAborted()
    if (stored === undefined) return undefined
    return {
      meta: structuredClone(stored.meta),
      events: stored.events.map(event => structuredClone(event)),
      revision: SessionPersistenceRevision(stored.revision),
      ...stored.tornFrom === undefined ? {} : { tornMarker: stored.tornFrom },
    }
  }

  async readStoredRevision(id: SessionId, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const revision = await this.client.revision(id, signal)
    signal?.throwIfAborted()
    return revision === undefined ? undefined : SessionPersistenceRevision(revision)
  }

  async loadStoredFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<StoredSuffix | undefined> {
    signal?.throwIfAborted()
    const stored = await this.client.loadFrom(id, fromSeq, signal)
    signal?.throwIfAborted()
    return stored === undefined
      ? undefined
      : {
          meta: structuredClone(stored.meta),
          events: stored.events.map(event => structuredClone(event)),
        }
  }

  appendBatch(meta: SessionHeader, events: readonly SessionEvent[], isMaterialized: boolean): Promise<void> {
    return this.client.append({
      protocol: CLAWX_DSH_STORE_PROTOCOL,
      meta: structuredClone(meta),
      events: events.map(event => structuredClone(event)),
      isMaterialized,
    })
  }

  commitRepair(meta: SessionHeader, tornMarker: number | undefined, closers: readonly SessionEvent[]): Promise<void> {
    return this.client.repair({
      protocol: CLAWX_DSH_STORE_PROTOCOL,
      meta: structuredClone(meta),
      ...tornMarker === undefined ? {} : { tornFrom: tornMarker },
      closers: closers.map(event => structuredClone(event)),
    })
  }

  async list(signal?: AbortSignal): Promise<SessionHeader[]> {
    signal?.throwIfAborted()
    const rows = await this.client.list(signal)
    signal?.throwIfAborted()
    return rows.map(row => structuredClone(row.meta))
  }

  async close(): Promise<void> {
    await this.client.close?.()
  }
}

export class ClawXSessionPersistence extends SessionPersistence {
  override readonly supportsRawArtifacts = false
  override readonly name = 'session-persistence-clawx'

  static inject = ['sessions']

  private readonly backend: ClawXPersistenceBackend
  private readonly coordinator: PersistenceCoordinator<number>

  constructor(ctx: Context, readonly config: Config) {
    super(ctx)
    if (config.client === undefined) throw new Error('ClawX session persistence requires an authenticated client')
    this.backend = new ClawXPersistenceBackend(config.client)
    this.coordinator = new PersistenceCoordinator(ctx, this.backend, {
      preparedSessionCacheSize: config.preparedSessionCacheSize ?? DEFAULT_PREPARED_SESSION_CACHE_SIZE,
      writeBatchMaxDelayMs: config.writeBatchMaxDelayMs ?? DEFAULT_WRITE_BATCH_MAX_DELAY_MS,
    })
  }

  locate(_meta: SessionHeader): SessionLocation | undefined {
    return undefined
  }

  create(meta: SessionHeader): Promise<void> {
    return this.coordinator.create(meta)
  }

  append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    return this.coordinator.append(id, events)
  }

  override prepare(id: SessionId, signal?: AbortSignal): Promise<SessionPreparation> {
    return this.coordinator.prepare(id, signal)
  }

  load(id: SessionId): Promise<SessionInspection> {
    return this.coordinator.load(id)
  }

  inspect(id: SessionId, signal?: AbortSignal): Promise<SessionInspection> {
    return this.coordinator.inspect(id, signal)
  }

  override borrowSession(id: SessionId, signal?: AbortSignal): Promise<BorrowedSessionSource> {
    return this.coordinator.borrowSession(id, signal)
  }

  readFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<{
    meta: SessionHeader
    events: SessionEvent[]
  }> {
    return this.coordinator.readFrom(id, fromSeq, signal)
  }

  list(signal?: AbortSignal): Promise<SessionHeader[]> {
    return this.backend.list(signal)
  }

  async listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
    signal?.throwIfAborted()
    const rows = await this.config.client.list(signal)
    signal?.throwIfAborted()
    return rows.map(row => ({
      header: structuredClone(row.meta),
      revision: SessionPersistenceRevision(row.revision),
    }))
  }
}

export default ClawXSessionPersistence
