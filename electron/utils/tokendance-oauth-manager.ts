import { EventEmitter } from 'node:events';
import { shell } from 'electron';
import type { ProviderAccount, ProviderSecret } from '../shared/providers/types';
import { getProviderService } from '../services/providers/provider-service';
import { getSecretStore } from '../services/secrets/secret-store';
import { loginTokenDanceOAuth, TOKENDANCE_APP_HEADER, TOKENDANCE_DEFAULT_MODEL, TOKENDANCE_GATEWAY_BASE_URL } from './tokendance-oauth';

type Flow = { accountId: string; controller: AbortController; done: Promise<void> };
export type TokenDanceFlowDependencies = {
  login: typeof loginTokenDanceOAuth;
  openUrl(url: string): Promise<void>;
  accounts: Pick<ReturnType<typeof getProviderService>, 'getAccount' | 'createAccount' | 'deleteAccount'>;
  secrets: { get(id: string): Promise<ProviderSecret | null>; set(secret: ProviderSecret): Promise<void>; delete(id: string): Promise<void> };
};

/** One browser flow; immutable account identity and no Renderer credential event. */
export class TokenDanceOAuthManager extends EventEmitter {
  private flow?: Flow;
  private epoch = 0;
  private serial: Promise<unknown> = Promise.resolve();
  private reconcile: (id: string) => Promise<unknown> = async () => undefined;
  private removeProjection: (id: string) => Promise<unknown> = async () => undefined;
  constructor(private readonly deps: TokenDanceFlowDependencies = {
    login: loginTokenDanceOAuth, openUrl: url => shell.openExternal(url),
    accounts: {
      getAccount: id => getProviderService().getAccount(id),
      createAccount: (account, key) => getProviderService().createAccount(account, key),
      deleteAccount: id => getProviderService().deleteAccount(id),
    },
    secrets: { get: id => getSecretStore().get(id), set: secret => getSecretStore().set(secret), delete: id => getSecretStore().delete(id) },
  }) { super(); }

  configure(reconcile: (id: string) => Promise<unknown>, removeProjection: (id: string) => Promise<unknown>): void {
    this.reconcile = reconcile; this.removeProjection = removeProjection;
  }

  async start(options: { accountId?: string; label?: string }): Promise<void> {
    const revision = ++this.epoch;
    const operation = this.serial.catch(() => undefined).then(async () => {
      if (revision !== this.epoch) return;
      await this.stop(undefined, false);
      const accountId = options.accountId || 'tokendance';
      if (!/^[a-zA-Z0-9_-]{1,160}$/.test(accountId)) throw new Error('tokendanceOAuth.failed');
      const existing = await this.deps.accounts.getAccount(accountId) ?? undefined;
      if (revision !== this.epoch) return;
      if (existing && existing.vendorId !== 'tokendance') throw new Error('tokendanceOAuth.failed');
      const flow: Flow = { accountId, controller: new AbortController(), done: Promise.resolve() };
      this.flow = flow;
      flow.done = this.execute(flow, options.label, existing);
    });
    this.serial = operation;
    await operation;
  }

  async stop(accountId?: string, invalidate = true): Promise<void> {
    if (invalidate && (!accountId || !this.flow || this.flow.accountId === accountId)) this.epoch++;
    const flow = this.flow;
    if (!flow || (accountId && accountId !== flow.accountId)) return;
    flow.controller.abort();
    await flow.done;
    if (this.flow === flow) this.flow = undefined;
  }

  private async execute(flow: Flow, label: string | undefined, existing: ProviderAccount | undefined): Promise<void> {
    const signal = flow.controller.signal;
    let previousSecret: ProviderSecret | null = null;
    let wroteAccount = false;
    try {
      const token = await this.deps.login({ openUrl: this.deps.openUrl, signal });
      signal.throwIfAborted();
      if (JSON.stringify(await this.deps.accounts.getAccount(flow.accountId) ?? undefined) !== JSON.stringify(existing)) throw new Error('tokendanceOAuth.failed');
      previousSecret = await this.deps.secrets.get(flow.accountId);
      signal.throwIfAborted();
      const model = existing?.model?.replace(/^tokendance\//, '').trim() || TOKENDANCE_DEFAULT_MODEL;
      const headers = Object.fromEntries(Object.entries(existing?.headers ?? {}).filter(([name]) => name.toLowerCase() !== 'x-app-url'));
      const now = new Date().toISOString();
      wroteAccount = true;
      await this.deps.accounts.createAccount({
        ...existing, id: flow.accountId, vendorId: 'tokendance', label: label || existing?.label || 'TokenDance',
        authMode: 'oauth_browser', baseUrl: TOKENDANCE_GATEWAY_BASE_URL, apiProtocol: 'openai-completions',
        headers: { ...headers, ...TOKENDANCE_APP_HEADER }, model,
        enabled: existing?.enabled ?? true, isDefault: existing?.isDefault ?? false,
        createdAt: existing?.createdAt ?? now, updatedAt: now,
      }, token.apiKey);
      signal.throwIfAborted();
      await this.reconcile(flow.accountId);
      signal.throwIfAborted();
      this.emit('oauth:success', { provider: 'tokendance', accountId: flow.accountId, success: true });
    } catch (error) {
      if (wroteAccount) {
        // Cancellation can race a storage await. Finish rollback before another
        // flow or account deletion is admitted; never restore into a newer flow.
        try {
          if (existing) await this.deps.accounts.createAccount(existing);
          else await this.deps.accounts.deleteAccount(flow.accountId);
          if (previousSecret) await this.deps.secrets.set(previousSecret);
          else await this.deps.secrets.delete(flow.accountId);
          if (existing) await this.reconcile(flow.accountId);
          else await this.removeProjection(flow.accountId);
        } catch { this.emit('oauth:error', { provider: 'tokendance', accountId: flow.accountId, message: 'tokendanceOAuth.failed' }); }
      }
      if (!signal.aborted) {
        const message = error instanceof Error && error.message === 'tokendanceOAuth.timedOut'
          ? error.message : 'tokendanceOAuth.failed';
        this.emit('oauth:error', { provider: 'tokendance', accountId: flow.accountId, message });
      }
    } finally { if (this.flow === flow) this.flow = undefined; }
  }
}

export const tokenDanceOAuthManager = new TokenDanceOAuthManager();
