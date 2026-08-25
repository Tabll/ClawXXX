import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { describe, expect, it } from 'vitest'
import ClawXDshCredentialProvider from '../src/index.ts'

describe('ClawX DSH credential provider', () => {
  it('resolves per-run accounts without caching and rejects writes', async () => {
    const calls: string[] = []
    const ctx = new Context()
    await ctx.plugin(ClawXDshCredentialProvider, {
      resolve: async ({ accountId }) => {
        calls.push(accountId)
        return `value-for-${accountId}`
      },
    })
    const provider = ctx.credentials as ClawXDshCredentialProvider
    await expect(provider.resolve(credentialRef('DEEPSEEK_API_KEY'))).rejects.toThrow(/outside/)
    await expect(Promise.all([
      provider.withRequestContext({ accountId: 'first', purpose: 'model-request' }, async () => (
        (await provider.resolve(credentialRef('DEEPSEEK_API_KEY')))?.value
      )),
      provider.withRequestContext({ accountId: 'second', purpose: 'model-request' }, async () => (
        (await provider.resolve(credentialRef('DEEPSEEK_API_KEY')))?.value
      )),
    ])).resolves.toEqual(['value-for-first', 'value-for-second'])
    expect(calls).toEqual(['first', 'second'])
    await expect(provider.set(credentialRef('DEEPSEEK_API_KEY'), 'not-stored')).rejects.toThrow(/read-only/)
    await ctx.fiber.dispose()
  })
})
