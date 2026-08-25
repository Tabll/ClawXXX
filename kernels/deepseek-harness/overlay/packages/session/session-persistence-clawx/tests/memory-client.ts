import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type {
  ClawXSessionStoreClient,
  ClawXStoredSession,
} from '../src/index.ts'

export class MemoryClawXClient implements ClawXSessionStoreClient {
  private readonly sessions = new Map<SessionId, {
    meta: SessionHeader
    events: SessionEvent[]
    revision: number
  }>()

  load(id: SessionId, signal?: AbortSignal): Promise<ClawXStoredSession | undefined> {
    signal?.throwIfAborted()
    const row = this.sessions.get(id)
    return Promise.resolve(row === undefined ? undefined : {
      meta: structuredClone(row.meta),
      events: row.events.map(event => structuredClone(event)),
      revision: `memory:${id}:${row.revision}`,
    })
  }

  revision(id: SessionId, signal?: AbortSignal): Promise<string | undefined> {
    signal?.throwIfAborted()
    const row = this.sessions.get(id)
    return Promise.resolve(row === undefined ? undefined : `memory:${id}:${row.revision}`)
  }

  async loadFrom(id: SessionId, fromSeq: number, signal?: AbortSignal) {
    const row = await this.load(id, signal)
    return row === undefined
      ? undefined
      : { meta: row.meta, events: row.events.filter(event => event.seq >= fromSeq) }
  }

  append(input: {
    meta: SessionHeader
    events: readonly SessionEvent[]
    isMaterialized: boolean
  }): Promise<void> {
    if (input.events.length === 0) return Promise.resolve()
    const existing = this.sessions.get(input.meta.id)
    const events = existing?.events ?? []
    const expected = events.length
    if (input.events[0]?.seq !== expected) {
      return Promise.reject(new Error(`session ${input.meta.id} append starts at the wrong seq`))
    }
    for (const [offset, event] of input.events.entries()) {
      if (event.seq !== expected + offset) return Promise.reject(new Error('session append contains a seq gap'))
      JSON.stringify(event.data)
    }
    if (existing === undefined && input.isMaterialized) {
      return Promise.reject(new Error('ClawX store materialization state disagrees with append'))
    }
    this.sessions.set(input.meta.id, {
      meta: structuredClone(input.meta),
      events: [...events, ...input.events.map(event => structuredClone(event))],
      revision: (existing?.revision ?? 0) + 1,
    })
    return Promise.resolve()
  }

  repair(input: {
    meta: SessionHeader
    tornFrom?: number
    closers: readonly SessionEvent[]
  }): Promise<void> {
    const existing = this.sessions.get(input.meta.id)
    if (existing === undefined) return Promise.reject(new Error(`session ${input.meta.id} not found`))
    const prefix = input.tornFrom === undefined
      ? existing.events
      : existing.events.filter(event => event.seq < input.tornFrom!)
    const expected = prefix.length
    if (input.closers[0] !== undefined && input.closers[0].seq !== expected) {
      return Promise.reject(new Error('repair closer starts at the wrong seq'))
    }
    this.sessions.set(input.meta.id, {
      meta: structuredClone(input.meta),
      events: [...prefix, ...input.closers.map(event => structuredClone(event))],
      revision: existing.revision + 1,
    })
    return Promise.resolve()
  }

  list(signal?: AbortSignal): Promise<Array<{ meta: SessionHeader; revision: string }>> {
    signal?.throwIfAborted()
    return Promise.resolve([...this.sessions.values()].map(row => ({
      meta: structuredClone(row.meta),
      revision: `memory:${row.meta.id}:${row.revision}`,
    })))
  }
}
