/**
 * Package-owned invariant companion for ClawX's RPC-backed DSH persistence.
 *
 * Persistence correctness is verified by the upstream persistence contract and
 * by the host DataService contract. There is no continuously observable
 * in-process relation to register beyond reserving package ownership.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@clawx/dsh-session-persistence'

export const name = 'session-persistence-clawx-invariant'
export const inject = ['invariants']

const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
