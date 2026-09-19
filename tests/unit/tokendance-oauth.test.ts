import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loginTokenDanceOAuth, TOKENDANCE_KEY_EXCHANGE_URL } from '../../electron/utils/tokendance-oauth';
import type { ProviderAccount, ProviderSecret } from '../../electron/shared/providers/types';
vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }));
vi.mock('../../electron/services/providers/provider-service', () => ({ getProviderService: vi.fn() }));
vi.mock('../../electron/services/secrets/secret-store', () => ({ getSecretStore: vi.fn() }));
import { TokenDanceOAuthManager } from '../../electron/utils/tokendance-oauth-manager';

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });

describe('TokenDance loopback OAuth', () => {
  it('binds a one-use callback to the random flow and S256 verifier, with no secret in browser HTML', async () => {
    let challenge = ''; let callback = '';
    const result = await loginTokenDanceOAuth({
      openUrl: async url => {
        const auth = new URL(url); challenge = auth.searchParams.get('code_challenge')!;
        callback = auth.searchParams.get('callback_url')!;
        const wrong = new URL(callback); wrong.searchParams.set('flow_id', 'foreign'); wrong.searchParams.set('code', 'code');
        expect((await fetch(wrong)).status).toBe(400);
        const valid = new URL(callback); valid.searchParams.set('code', 'one-use-code');
        expect((await fetch(valid, { method: 'POST' })).status).toBe(400);
        const response = await fetch(valid); expect(response.status).toBe(200);
        expect(await response.text()).not.toContain('one-use-code');
        expect((await fetch(valid)).status).toBe(400);
      },
      fetchImpl: async (url, init) => {
        expect(url).toBe(TOKENDANCE_KEY_EXCHANGE_URL);
        expect(init?.redirect).toBe('error');
        const body = JSON.parse(String(init?.body));
        expect(body.code).toBe('one-use-code');
        expect(createHash('sha256').update(body.code_verifier).digest('base64url')).toBe(challenge);
        return Response.json({ key: 'private-fixture-key' });
      },
    });
    expect(result).toEqual({ apiKey: 'private-fixture-key' });
    await expect(fetch(callback)).rejects.toThrow();
  });

  it('keeps the deadline active while the exchange response body is stalled', async () => {
    const server = createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('{"key":"'); });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    await expect(loginTokenDanceOAuth({ timeoutMs: 150,
      openUrl: async url => { const callback = new URL(new URL(url).searchParams.get('callback_url')!); callback.searchParams.set('code', 'fixture'); await fetch(callback); },
      fetchImpl: (_url, init) => fetch(`http://127.0.0.1:${port}`, init),
    })).rejects.toThrow('tokendanceOAuth.timedOut');
  });

  it('cancels waiting callbacks and redacts exchange failures', async () => {
    const controller = new AbortController();
    let callback = '';
    await expect(loginTokenDanceOAuth({ signal: controller.signal, openUrl: async url => {
      callback = new URL(url).searchParams.get('callback_url')!; controller.abort();
    } })).rejects.toMatchObject({ name: 'AbortError' });
    await expect(fetch(callback)).rejects.toThrow();
    await expect(loginTokenDanceOAuth({ openUrl: async url => {
      const cb = new URL(new URL(url).searchParams.get('callback_url')!); cb.searchParams.set('code', 'fixture'); await fetch(cb);
    }, fetchImpl: async () => { throw new Error('private-token-provider-response'); } })).rejects.toThrow(/^tokendanceOAuth.failed$/);
  });
});

describe('TokenDance canonical persistence', () => {
  function fixture(login: typeof loginTokenDanceOAuth) {
    const accounts = new Map<string, ProviderAccount>(); const secrets = new Map<string, ProviderSecret>();
    const deps = { login, openUrl: vi.fn(async () => undefined), accounts: {
      getAccount: vi.fn(async (id: string) => accounts.get(id) ?? null),
      createAccount: vi.fn(async (account: ProviderAccount, key?: string) => { accounts.set(account.id, account); if (key) secrets.set(account.id, { type: 'api_key', accountId: account.id, apiKey: key }); return account; }),
      deleteAccount: vi.fn(async (id: string) => accounts.delete(id)),
    }, secrets: { get: async (id: string) => secrets.get(id) ?? null, set: async (secret: ProviderSecret) => { secrets.set(secret.accountId, secret); }, delete: async (id: string) => { secrets.delete(id); } } };
    const manager = new TokenDanceOAuthManager(deps); const success = vi.fn(); const errors = vi.fn();
    manager.on('oauth:success', success); manager.on('oauth:error', errors);
    const reconcile = vi.fn(async () => undefined); const remove = vi.fn(async () => undefined);
    manager.configure(reconcile, remove);
    return { accounts, secrets, deps, manager, success, errors, reconcile, remove };
  }

  it('stores the exchanged key only through canonical credentials and reconciles before success', async () => {
    const f = fixture(async () => ({ apiKey: 'fixture-secret' }));
    await f.manager.start({ accountId: 'tokendance-one' });
    await vi.waitFor(() => expect(f.success).toHaveBeenCalledOnce());
    expect(f.accounts.get('tokendance-one')).toMatchObject({ vendorId: 'tokendance', authMode: 'oauth_browser', model: 'qwen3.8-max', headers: { 'X-App-URL': 'https://clawx.com.cn' } });
    expect(f.reconcile).toHaveBeenCalledWith('tokendance-one');
    expect(JSON.stringify(f.success.mock.calls)).not.toContain('fixture-secret');
    expect(JSON.stringify([...f.accounts.values()])).not.toContain('fixture-secret');
  });

  it('rolls back a cancelled storage write before admitting a replacement flow', async () => {
    const f = fixture(async () => ({ apiKey: 'fixture-secret' }));
    let release!: () => void;
    f.reconcile.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    await f.manager.start({ accountId: 'tokendance-one' });
    await vi.waitFor(() => expect(f.reconcile).toHaveBeenCalledOnce());
    const stopped = f.manager.stop(); release(); await stopped;
    expect(f.accounts.size).toBe(0); expect(f.secrets.size).toBe(0); expect(f.success).not.toHaveBeenCalled();
    expect(f.remove).toHaveBeenCalledWith('tokendance-one');
    await f.manager.start({ accountId: 'tokendance-two' });
    await vi.waitFor(() => expect(f.success).toHaveBeenCalledOnce());
    expect(f.success).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'tokendance-two' }));
  });

  it('rejects a late key from a cancelled login even when the transport ignores abort', async () => {
    let release!: (value: { apiKey: string }) => void;
    const f = fixture(() => new Promise(resolve => { release = resolve; }));
    await f.manager.start({ accountId: 'tokendance-one' }); const stop = f.manager.stop();
    release({ apiKey: 'late-secret' }); await stop;
    expect(f.accounts.size).toBe(0); expect(f.success).not.toHaveBeenCalled();
  });
});
