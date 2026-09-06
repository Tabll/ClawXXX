/** Shared-memory stand-in for the authenticated host, including atomic lease fencing. */
import { randomUUID } from 'node:crypto'
import type { SessionEvent, SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import {
  assertContiguous, validateStoredEvents, SessionAlreadyExistsError, SessionAlreadyOwnedError,
  SessionPersistenceNotFoundError, SessionReadOnlyError, SessionOwnershipLostError, SessionPersistenceRevision,
  type SessionAccess, type SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence'
import { CLAWX_DSH_STORE_PROTOCOL, type ClawXSessionStoreClient, type ClawXSessionLease } from '../src/index.ts'

type Row = {
  meta: SessionHeader
  inheritedEventCount: SessionLogOffset
  events: SessionEvent[]
  revision: number
  materialized: boolean
  creator: string
  writer?: string
}
type Lease = { row: Row; clientId: string; access: SessionAccess }
type Storage = { rows: Map<SessionId, Row>; leases: Map<string, Lease> }

export class MemoryClawXClient implements ClawXSessionStoreClient {
  private readonly clientId = randomUUID()
  constructor(private readonly storage: Storage = { rows: new Map(), leases: new Map() }) {}

  fork(): MemoryClawXClient { return new MemoryClawXClient(this.storage) }

  async acquire(input: Parameters<ClawXSessionStoreClient['acquire']>[0], signal?: AbortSignal): Promise<ClawXSessionLease> {
    signal?.throwIfAborted()
    if (input.protocol !== CLAWX_DSH_STORE_PROTOCOL) throw new Error('Session store protocol mismatch')
    let row = this.storage.rows.get(input.id)
    if (input.create !== undefined) {
      if (row !== undefined) throw new SessionAlreadyExistsError(input.id)
      row = {
        meta: structuredClone(input.create.header), inheritedEventCount: input.create.inheritedEventCount,
        events: [], revision: 0, materialized: false, creator: this.clientId,
      }
      this.storage.rows.set(input.id, row)
    } else if (row === undefined || !this.visible(row)) {
      throw new SessionPersistenceNotFoundError(input.id)
    }
    if (input.access === 'write') {
      if (row.writer !== undefined) throw new SessionAlreadyOwnedError(input.id)
      validateStoredEvents(row.meta, structuredClone(row.events))
    }
    const leaseId = randomUUID()
    if (input.access === 'write') row.writer = leaseId
    this.storage.leases.set(leaseId, { row, access: input.access, clientId: this.clientId })
    return { leaseId, header: structuredClone(row.meta), access: input.access, inheritedEventCount: row.inheritedEventCount }
  }

  private visible(row: Row): boolean { return row.materialized || row.creator === this.clientId }

  private lease(id: string, mutate = false): Lease {
    const lease = this.storage.leases.get(id)
    if (lease === undefined || lease.clientId !== this.clientId) throw new Error('Unknown or foreign lease')
    if (mutate && lease.access !== 'write') throw new SessionReadOnlyError(lease.row.meta.id, 'mutation')
    if (mutate && lease.row.writer !== id) throw new SessionOwnershipLostError(lease.row.meta.id)
    return lease
  }

  async read(id: string, offset: number, length?: number, signal?: AbortSignal): Promise<SessionEvent[]> {
    signal?.throwIfAborted()
    const row = this.lease(id).row
    return validateStoredEvents(row.meta, structuredClone(row.events.slice(offset, length === undefined ? undefined : offset + length)))
  }

  async append(id: string, events: readonly SessionEvent[], signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const row = this.lease(id, true).row
    assertContiguous(row.meta.id, events, row.events.length)
    if (events.length === 0) return
    row.events.push(...structuredClone(events))
    row.revision += 1
    row.materialized = true
  }

  async flush(id: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    this.lease(id, true).row.materialized = true
  }

  async release(id: string): Promise<void> {
    if (!this.storage.leases.has(id)) return
    const lease = this.lease(id)
    if (lease.access === 'write' && lease.row.writer === id) {
      delete lease.row.writer
      if (!lease.row.materialized) this.storage.rows.delete(lease.row.meta.id)
    }
    this.storage.leases.delete(id)
  }

  async stat(id: SessionId, signal?: AbortSignal): Promise<SessionPersistenceSnapshot | undefined> {
    signal?.throwIfAborted()
    const row = this.storage.rows.get(id)
    return row === undefined || !this.visible(row) ? undefined : {
      header: structuredClone(row.meta), eventCount: row.events.length,
      revision: SessionPersistenceRevision('memory:' + id + ':' + row.revision),
    }
  }

  async list(signal?: AbortSignal): Promise<readonly SessionPersistenceSnapshot[]> {
    signal?.throwIfAborted()
    const rows = await Promise.all([...this.storage.rows.keys()].map(id => this.stat(id, signal)))
    return rows.filter((row): row is SessionPersistenceSnapshot => row !== undefined)
  }

  async load(id: SessionId): Promise<{ events: SessionEvent[] } | undefined> {
    const row = this.storage.rows.get(id)
    return row === undefined || !this.visible(row) ? undefined : { events: structuredClone(row.events) }
  }

  revokeWriters(): void {
    for (const row of this.storage.rows.values()) delete row.writer
  }

  get activeLeaseCount(): number { return this.storage.leases.size }
}
