/** Optional RPC SessionHandle provider; never opens a native history file. */
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { SessionLogOffset, type SessionEvent, type SessionHeader, type SessionId } from '@deepseek-ai/dsh-session'
import {
  SessionPersistence, SessionHandleClosedError, SessionReadOnlyError,
  assertContiguous, assertStoredId, assertVersion,
  materializeAppendBatch, materializeCreateHeader, validateStoredEvents,
  type SessionAccess, type SessionHandle, type SessionHandleAppendOptions,
  type SessionHandleFlushOptions, type SessionHandleReadOptions,
  type SessionPersistenceCreateOptions, type SessionPersistenceOpenOptions,
  type SessionPersistenceStatOptions, type SessionPersistenceListOptions,
  type SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence'

export const CLAWX_DSH_STORE_PROTOCOL = 'clawx.dsh-session-store/v2' as const

/** Server-issued capability bound to one authenticated client and generation. */
export interface ClawXSessionLease {
  readonly leaseId: string
  readonly header: SessionHeader
  readonly access: SessionAccess
  readonly inheritedEventCount: SessionLogOffset
}

/**
 * Authenticated host transport. The server atomically acquires single-writer
 * ownership and fences every operation by leaseId; a process-local mutex is
 * insufficient. Acquire must release a granted lease before rejecting, or
 * return it even if cancellation raced, so the provider can release it.
 * Release is idempotent, flushes materialized writes and releases ownership
 * even on flush failure; empty, unflushed creates disappear. Reads never serve
 * a torn tail or an older acknowledged prefix. Transports restore upstream
 * typed persistence errors from their wire error codes.
 */
export interface ClawXSessionStoreClient {
  acquire(input: {
    protocol: typeof CLAWX_DSH_STORE_PROTOCOL
    requestId: string
    id: SessionId
    access: SessionAccess
    create?: { header: SessionHeader; inheritedEventCount: SessionLogOffset }
  }, signal?: AbortSignal): Promise<ClawXSessionLease>
  read(leaseId: string, offset: number, length?: number, signal?: AbortSignal): Promise<SessionEvent[]>
  append(leaseId: string, events: readonly SessionEvent[], signal?: AbortSignal): Promise<void>
  flush(leaseId: string, signal?: AbortSignal): Promise<void>
  release(leaseId: string): Promise<void>
  stat(id: SessionId, signal?: AbortSignal): Promise<SessionPersistenceSnapshot | undefined>
  list(signal?: AbortSignal): Promise<readonly SessionPersistenceSnapshot[]>
}

export interface Config {
  readonly client: ClawXSessionStoreClient
}

class RpcSessionHandle implements SessionHandle {
  readonly id: SessionId
  readonly header: SessionHeader
  readonly inheritedEventCount: SessionLogOffset
  readonly access: SessionAccess
  private tail: Promise<unknown> = Promise.resolve()
  private closing: Promise<void> | undefined
  private observedEnd = 0
  private liveEvents: SessionEvent[] = []
  private liveScheduled = false
  private livePaused = false

  constructor(
    private readonly client: ClawXSessionStoreClient,
    private readonly lease: ClawXSessionLease,
    private readonly released: () => void,
  ) {
    this.header = Object.freeze(structuredClone(lease.header))
    this.id = this.header.id
    this.access = lease.access
    this.inheritedEventCount = lease.inheritedEventCount
  }

  private async ordered<T>(operation: string, mutate: boolean, signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
    if (this.closing !== undefined) throw new SessionHandleClosedError(this.id, operation)
    if (mutate && this.access !== 'write') throw new SessionReadOnlyError(this.id, operation)
    signal?.throwIfAborted()
    const result = this.tail.then(() => { signal?.throwIfAborted(); return work() })
    this.tail = result.catch(() => undefined)
    return result
  }

  read(offset = 0, length?: number, options?: SessionHandleReadOptions): Promise<readonly SessionEvent[]> {
    return this.ordered('read', false, options?.signal, async () => {
      await this.drainLive()
      for (const value of [offset, ...(length === undefined ? [] : [length])]) {
        if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Session read offset/length must be non-negative safe integers')
      }
      const events = validateStoredEvents(this.header, structuredClone(
        await this.client.read(this.lease.leaseId, offset, length, options?.signal),
      ))
      assertContiguous(this.id, events, offset)
      if ((length !== undefined && events.length > length)
        || events.length < Math.min(Math.max(0, this.observedEnd - offset), length ?? Infinity)) {
        throw new Error('ClawX Session read returned an invalid or regressed prefix')
      }
      if (events.length > 0) this.observedEnd = Math.max(this.observedEnd, offset + events.length)
      return events
    })
  }

  async append(events: readonly SessionEvent[], options?: SessionHandleAppendOptions): Promise<void> {
    // Snapshot before queueing: the accepted batch cannot follow caller edits.
    const batch = materializeAppendBatch(events)
    return this.ordered('append', true, options?.signal, async () => {
      await this.drainLive()
      await this.client.append(this.lease.leaseId, batch, options?.signal)
      const last = batch.at(-1)
      if (last !== undefined) this.observedEnd = Math.max(this.observedEnd, last.seq + 1)
    })
  }

  flush(options?: SessionHandleFlushOptions): Promise<void> {
    return this.ordered('flush', true, options?.signal, async () => {
      await this.drainLive()
      await this.client.flush(this.lease.leaseId, options?.signal)
    })
  }

  close(): Promise<void> {
    return this.closing ??= this.tail.then(async () => {
      const errors: unknown[] = []
      try { await this.drainLive() } catch (error) { errors.push(error) }
      try { await this.client.release(this.lease.leaseId) } catch (error) { errors.push(error) }
      if (errors.length) throw new AggregateError(errors, 'Session drain/release failed')
    }).finally(this.released)
  }

  route(event: SessionEvent, report: (error: unknown) => void): void {
    this.liveEvents.push(...materializeAppendBatch([event]))
    if (this.liveScheduled || this.livePaused || this.closing !== undefined) return
    this.liveScheduled = true
    void this.ordered('route', true, undefined, () => this.drainLive())
      .catch(report).finally(() => { this.liveScheduled = false })
  }

  private async drainLive(): Promise<void> {
    this.livePaused = false
    while (this.liveEvents.length) {
      const batch = this.liveEvents.slice()
      try { await this.client.append(this.lease.leaseId, batch) }
      catch (error) { this.livePaused = true; throw error }
      this.liveEvents.splice(0, batch.length)
      this.observedEnd = Math.max(this.observedEnd, batch.at(-1)!.seq + 1)
    }
  }

  [Symbol.asyncDispose](): Promise<void> { return this.close() }

  barrier(): Promise<void> { return this.closing ?? this.flush() }
}

/** SessionHandle lifecycle over host-owned storage; the client remains caller-owned. */
export class ClawXSessionPersistence extends SessionPersistence {
  private readonly handles = new Set<RpcSessionHandle>()
  private readonly acquisitions = new Set<Promise<RpcSessionHandle>>()
  private readonly writers = new Map<SessionId, RpcSessionHandle>()
  private closed = false

  constructor(ctx: Context, readonly config: Config) {
    super(ctx)
    if (config.client === undefined) throw new Error('ClawX session persistence requires an authenticated client')
    ctx.on('session/event', (session, event) => {
      this.writers.get(session.id)?.route(event, error => ctx.logger.warn(`ClawX session write retained for retry: ${String(error)}`))
    })
    ctx.on('session/flush', session => this.writers.get(session.id)?.barrier())
    ctx.on('session/disposed', session => {
      void this.writers.get(session.id)?.close().catch(error => ctx.logger.warn(`ClawX session close failed: ${String(error)}`))
    })
    ctx.effect(() => () => this.disposeHandles())
  }

  private async acquire(input: Parameters<ClawXSessionStoreClient['acquire']>[0], signal?: AbortSignal): Promise<RpcSessionHandle> {
    if (this.closed) throw new Error('ClawX session persistence is closed')
    signal?.throwIfAborted()
    const pending = (async () => {
      const lease = await this.config.client.acquire(input, signal)
      try {
        signal?.throwIfAborted()
        if (this.closed) throw new Error('ClawX session persistence closed during acquisition')
        assertStoredId(input.id, lease.header)
        assertVersion(lease.header)
        if (!lease.leaseId || lease.access !== input.access) throw new Error('ClawX Session lease identity/access mismatch')
        const inherited = SessionLogOffset(lease.inheritedEventCount)
        if (!lease.header.isSeeded && inherited !== 0) throw new Error('ClawX Session inherited prefix mismatch')
        const handle = new RpcSessionHandle(this.config.client, lease, () => {
          this.handles.delete(handle)
          if (this.writers.get(handle.id) === handle) this.writers.delete(handle.id)
        })
        this.handles.add(handle)
        if (handle.access === 'write') this.writers.set(handle.id, handle)
        return handle
      } catch (error) {
        try { await this.config.client.release(lease.leaseId) }
        catch (releaseError) { throw new AggregateError([error, releaseError], 'Session acquisition and release failed', { cause: releaseError }) }
        throw error
      }
    })()
    this.acquisitions.add(pending)
    try { return await pending }
    finally { this.acquisitions.delete(pending) }
  }

  async create(header: SessionHeader, options?: SessionPersistenceCreateOptions): Promise<SessionHandle> {
    options?.signal?.throwIfAborted()
    const meta = materializeCreateHeader(header)
    assertVersion(meta)
    const inheritedEventCount = SessionLogOffset(options?.inheritedEventCount ?? 0)
    if (meta.isSeeded ? options?.inheritedEventCount === undefined : inheritedEventCount !== 0) throw new Error('Session inherited prefix mismatch')
    return this.acquire({
      protocol: CLAWX_DSH_STORE_PROTOCOL, requestId: randomUUID(), id: meta.id,
      access: 'write', create: { header: meta, inheritedEventCount },
    }, options?.signal)
  }

  open(id: SessionId, access: SessionAccess, options?: SessionPersistenceOpenOptions): Promise<SessionHandle> {
    return this.acquire({ protocol: CLAWX_DSH_STORE_PROTOCOL, requestId: randomUUID(), id, access }, options?.signal)
  }

  async flush(): Promise<void> {
    if (this.closed) throw new Error('ClawX session persistence is closed')
    const results = await Promise.allSettled([...this.handles].filter(handle => handle.access === 'write').map(handle => handle.barrier()))
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (errors.length > 0) throw new AggregateError(errors, 'ClawX Session flush failed')
  }

  async stat(id: SessionId, options?: SessionPersistenceStatOptions): Promise<SessionPersistenceSnapshot | undefined> {
    if (this.closed) throw new Error('ClawX session persistence is closed')
    options?.signal?.throwIfAborted()
    const snapshot = await this.config.client.stat(id, options?.signal)
    options?.signal?.throwIfAborted()
    if (snapshot !== undefined) assertStoredId(id, snapshot.header)
    return structuredClone(snapshot)
  }

  async list(options?: SessionPersistenceListOptions): Promise<readonly SessionPersistenceSnapshot[]> {
    if (this.closed) throw new Error('ClawX session persistence is closed')
    options?.signal?.throwIfAborted()
    const snapshots = await this.config.client.list(options?.signal)
    options?.signal?.throwIfAborted()
    return structuredClone(snapshots)
  }

  private async disposeHandles(): Promise<void> {
    this.closed = true
    // Acquisition rejection belongs to its caller; rollback releases any late
    // lease. Teardown still waits until that rollback is complete.
    await Promise.allSettled([...this.acquisitions])
    const results = await Promise.allSettled([...this.handles].map(handle => handle.close()))
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (errors.length > 0) throw new AggregateError(errors, 'ClawX Session close failed')
  }
}

export default ClawXSessionPersistence
