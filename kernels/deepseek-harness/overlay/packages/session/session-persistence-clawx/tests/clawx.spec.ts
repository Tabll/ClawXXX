import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import {
  runPersistenceContract,
  type ContractBackend,
} from '../../session-persistence/tests/contract.ts'
import ClawXSessionPersistence, {
} from '../src/index.ts'
import { MemoryClawXClient } from './memory-client.ts'

async function backend(client: MemoryClawXClient): Promise<ContractBackend> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const fiber = await ctx.plugin(ClawXSessionPersistence, {
    client,
  })
  return {
    persistence: ctx.sessionPersistence,
    dispose: async () => { await fiber.dispose(); await ctx.fiber.dispose() },
    reopen: () => backend(client.fork()),
  }
}

runPersistenceContract('clawx-rpc', () => backend(new MemoryClawXClient()))
