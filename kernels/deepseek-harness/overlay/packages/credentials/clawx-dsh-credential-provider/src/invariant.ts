import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@clawx/dsh-credential-provider'

export const name = 'clawx-dsh-credential-provider-invariant'
export const inject = ['invariants']

// The provider is deliberately stateless outside AsyncLocalStorage; its
// account isolation, read-only surface and no-cache contract are pinned by
// the package suite and by Main's CredentialBroker contract tests.
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
