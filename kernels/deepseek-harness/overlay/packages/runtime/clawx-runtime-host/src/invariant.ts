import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

export const name = 'clawx-runtime-host-invariant'
export const inject = ['invariants']

// The host is a composition boundary. Its protocol, home-lock and canonical
// storage invariants are exercised by its dedicated contract tests.
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@clawx/dsh-runtime-host', install))
