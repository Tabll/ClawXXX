import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SessionAlreadyOwnedError, SessionOwnershipLostError } from '@deepseek-ai/dsh-session-persistence'
import { meta, oneTurnLog } from '../../session-persistence/tests/contract.ts'
import ClawXSessionPersistence from '../src/index.ts'
import { MemoryClawXClient } from './memory-client.ts'

describe('ClawX RPC SessionHandle lifecycle', () => {
  const contexts: Context[] = []
  afterEach(async () => {
    await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
    vi.restoreAllMocks()
  })

  async function backend(client = new MemoryClawXClient()) {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(ClawXSessionPersistence, { client })
    return { ctx, client, persistence: ctx.sessionPersistence }
  }

  it('fences write ownership across independent provider instances while allowing readers', async () => {
    const first = await backend()
    const second = await backend(first.client.fork())
    const writer = await first.persistence.create(meta('shared'))
    await writer.append(oneTurnLog())
    await expect(second.persistence.open(writer.id, 'write')).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    const reader = await second.persistence.open(writer.id, 'read')
    expect(await reader.read()).toHaveLength(6)
    await writer.close()
    const next = await second.persistence.open(writer.id, 'write')
    await first.ctx.fiber.dispose()
    expect(await next.read()).toHaveLength(6)
    await next.close()
    await reader.close()
    expect(first.client.activeLeaseCount).toBe(0)
  })

  it('releases a lease when cancellation races a successful acquisition', async () => {
    const { client, persistence } = await backend()
    const grant = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const acquire = client.acquire.bind(client)
    vi.spyOn(client, 'acquire').mockImplementationOnce(async (...args) => {
      const lease = await acquire(...args)
      grant.resolve()
      await resume.promise
      return lease
    })
    const abort = new AbortController()
    const pending = persistence.create(meta('cancelled-acquire'), { signal: abort.signal })
    const rejected = expect(pending).rejects.toThrow('cancelled acquisition')
    await grant.promise
    abort.abort(new Error('cancelled acquisition'))
    resume.resolve()
    await rejected
    expect(client.activeLeaseCount).toBe(0)
    expect(await persistence.stat(SessionId('cancelled-acquire'))).toBeUndefined()
  })

  it('waits for pending acquisitions during provider teardown and releases late grants', async () => {
    const { ctx, client, persistence } = await backend()
    const grant = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const acquire = client.acquire.bind(client)
    vi.spyOn(client, 'acquire').mockImplementationOnce(async (...args) => {
      const lease = await acquire(...args)
      grant.resolve()
      await resume.promise
      return lease
    })
    const pending = persistence.create(meta('dispose-acquire'))
    const rejected = expect(pending).rejects.toThrow('closed during acquisition')
    await grant.promise
    let disposed = false
    const disposal = ctx.fiber.dispose().then(() => { disposed = true })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(disposed).toBe(false)
    resume.resolve()
    await rejected
    await disposal
    expect(client.activeLeaseCount).toBe(0)
  })

  it('rejects pre-cancelled work before acquiring host resources', async () => {
    const { client, persistence } = await backend()
    const acquire = vi.spyOn(client, 'acquire')
    await expect(persistence.create(meta('never-created'), { signal: AbortSignal.abort(new Error('cancelled')) }))
      .rejects.toThrow('cancelled')
    expect(acquire).not.toHaveBeenCalled()
    expect(client.activeLeaseCount).toBe(0)
  })

  it('refuses further mutation after the server revokes writer ownership', async () => {
    const { client, persistence } = await backend()
    const writer = await persistence.create(meta('revoked'))
    await writer.append(oneTurnLog())
    client.revokeWriters()
    await expect(writer.append([])).rejects.toBeInstanceOf(SessionOwnershipLostError)
    await expect(writer.flush()).rejects.toBeInstanceOf(SessionOwnershipLostError)
    await writer.close()
    expect(client.activeLeaseCount).toBe(0)
  })

  it('rejects a read that regresses below an already acknowledged prefix', async () => {
    const { client, persistence } = await backend()
    const writer = await persistence.create(meta('freshness'))
    await writer.append(oneTurnLog())
    vi.spyOn(client, 'read').mockResolvedValueOnce([])
    await expect(writer.read()).rejects.toThrow('regressed prefix')
    await writer.close()
  })

  it('flushes all writers even when one barrier fails and releases all handles', async () => {
    const { client, persistence } = await backend()
    const one = await persistence.create(meta('one'))
    const two = await persistence.create(meta('two'))
    const original = client.flush.bind(client)
    const flush = vi.spyOn(client, 'flush').mockRejectedValueOnce(new Error('disk full'))
      .mockImplementation(original)
    await expect(persistence.flush()).rejects.toBeInstanceOf(AggregateError)
    expect(flush).toHaveBeenCalledTimes(2)
    await Promise.all([one.close(), two.close()])
    expect(client.activeLeaseCount).toBe(0)
  })

  it('retains a failed live event batch and checkpoints it before reads and release', async () => {
    const { ctx, client, persistence } = await backend()
    const writer = await persistence.create(meta('live-retry'))
    const append = client.append.bind(client)
    const writes = vi.spyOn(client, 'append').mockRejectedValueOnce(new Error('temporary transport failure'))
      .mockImplementation(append)
    const events = oneTurnLog()
    for (const event of events) ctx.emit('session/event', { id: writer.id } as never, event)
    await vi.waitFor(() => expect(writes).toHaveBeenCalledTimes(1))
    await writer.flush()
    expect(await writer.read()).toEqual(events)
    await writer.close()
    expect(client.activeLeaseCount).toBe(0)
  })

  it('drains accepted operations before idempotent close and rejects later work', async () => {
    const { client, persistence } = await backend()
    const writer = await persistence.create(meta('ordered'))
    const events = oneTurnLog()
    const append = writer.append(events)
    events.splice(0)
    const close = writer.close()
    expect(writer.close()).toBe(close)
    await expect(writer.read()).rejects.toThrow('closed handle')
    await append
    await close
    expect((await client.load(writer.id))?.events).toHaveLength(6)
    expect(client.activeLeaseCount).toBe(0)
  })
})
