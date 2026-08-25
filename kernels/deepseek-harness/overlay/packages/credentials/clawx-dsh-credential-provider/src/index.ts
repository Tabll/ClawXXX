import { AsyncLocalStorage } from 'node:async_hooks'
import type { Context } from '@deepseek-ai/cordis'
import {
  CredentialProvider,
  type CredentialInfo,
  type CredentialKey,
  type CredentialRecord,
  type CredentialRecordEntry,
  type CredentialRecordInfo,
  type CredentialRef,
  type ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'

export type ClawXCredentialPurpose = 'model-request' | 'channel-connect' | 'provider-validate'

export type ClawXCredentialRequestContext = {
  accountId: string
  purpose: ClawXCredentialPurpose
}

export type ClawXDshCredentialProviderConfig = {
  resolve(input: ClawXCredentialRequestContext & { ref: string }): Promise<string>
  allowedRefs?: string[]
}

/**
 * A request-scoped, read-only provider. AsyncLocalStorage prevents concurrent
 * runs using different accounts from sharing a global DEEPSEEK_API_KEY slot.
 */
export class ClawXDshCredentialProvider extends CredentialProvider {
  private readonly requestContext = new AsyncLocalStorage<ClawXCredentialRequestContext>()
  private readonly allowedRefs: ReadonlySet<string>

  constructor(ctx: Context, private readonly config: ClawXDshCredentialProviderConfig) {
    super(ctx)
    this.allowedRefs = new Set(config.allowedRefs ?? ['DEEPSEEK_API_KEY'])
  }

  withRequestContext<T>(context: ClawXCredentialRequestContext, operation: () => Promise<T>): Promise<T> {
    if (!context.accountId.trim()) throw new Error('ClawX Provider account selection is required')
    return this.requestContext.run(context, operation)
  }

  override async resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    if (!this.allowedRefs.has(ref)) return undefined
    const context = this.requestContext.getStore()
    if (!context) throw new Error('Credential resolution is outside an authenticated ClawX run')
    const value = await this.config.resolve({ ...context, ref })
    if (!value) throw new Error('ClawX CredentialBroker returned an empty credential')
    return { value, source: 'clawx-credential-broker' }
  }

  override describe(ref: CredentialRef): Promise<CredentialInfo> {
    return Promise.resolve({
      configured: this.allowedRefs.has(ref) && this.requestContext.getStore() !== undefined,
      ...(this.allowedRefs.has(ref) ? { source: 'clawx-credential-broker' } : {}),
      writable: false,
    })
  }

  override set(_ref: CredentialRef, _value: string): Promise<void> {
    return Promise.reject(new Error('ClawX credentials are Main-owned and read-only'))
  }

  override unset(_ref: CredentialRef): Promise<void> {
    return Promise.reject(new Error('ClawX credentials are Main-owned and read-only'))
  }

  override readRecord(_key: CredentialKey): Promise<CredentialRecord | undefined> {
    return Promise.resolve(undefined)
  }

  override describeRecord(_key: CredentialKey): Promise<CredentialRecordInfo> {
    return Promise.resolve({ configured: false, writable: false })
  }

  override listRecords(): Promise<readonly CredentialRecordEntry[]> {
    return Promise.resolve([])
  }

  override modifyRecord(
    _key: CredentialKey,
    _mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    return Promise.reject(new Error('ClawX credential records are Main-owned and read-only'))
  }

  override deleteRecord(_key: CredentialKey): Promise<void> {
    return Promise.reject(new Error('ClawX credential records are Main-owned and read-only'))
  }
}

export default ClawXDshCredentialProvider
