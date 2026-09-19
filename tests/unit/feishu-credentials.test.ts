// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { feishuCredentialChangeRequiresSecret, validateFeishuCredentials } from '@electron/channels/feishu-credentials';
import { proxyAwareFetch } from '@electron/utils/proxy-fetch';
vi.mock('@electron/utils/proxy-fetch', () => ({ proxyAwareFetch: vi.fn() }));
const request = vi.mocked(proxyAwareFetch);
afterEach(() => { vi.resetAllMocks(); vi.useRealTimers(); });

describe('Feishu credentials', () => {
  it('rejects invalid fields locally without sending credentials', async () => {
    for (const config of [{}, { appId: 'cli' }, { appId: 'cli', appSecret: 'cli' }, { appId: 'cli', appSecret: 'secret', domain: 'https://untrusted.example' }]) {
      expect((await validateFeishuCredentials(config)).valid).toBe(false);
    }
    expect(request).not.toHaveBeenCalled();
    expect(feishuCredentialChangeRequiresSecret({ appId: 'old' }, { appId: 'new' })).toBe(true);
    expect(feishuCredentialChangeRequiresSecret({ appId: 'old' }, { appId: 'old' })).toBe(false);
    expect(feishuCredentialChangeRequiresSecret({ appId: 'old' }, { appId: 'new', appSecret: 'new-secret' })).toBe(false);
  });

  it('detects Lark for new accounts and returns no token or server error body', async () => {
    request.mockResolvedValueOnce(Response.json({ code: 1, msg: 'secret echo' })).mockResolvedValueOnce(Response.json({ code: 0, tenant_access_token: 'never exposed' }));
    expect(await validateFeishuCredentials({ appId: 'cli', appSecret: 'secret' })).toEqual({ valid: true, errors: [], warnings: [], details: { domain: 'lark' } });
    expect(request.mock.calls.map(call => call[0])).toEqual(['https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', 'https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal']);
    expect(request.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
  });

  it('rejects explicit-domain credentials without trying another domain or exposing response details', async () => {
    request.mockResolvedValue(Response.json({ code: 0, msg: 'Authorization: Bearer provider-secret' }));
    expect(await validateFeishuCredentials({ appId: 'cli', appSecret: 'secret', domain: 'lark' }))
      .toEqual({ valid: false, errors: [], warnings: [], errorCode: 'feishuRejected' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('keeps its deadline active while reading the response body', async () => {
    vi.useFakeTimers();
    request.mockImplementation(async (_url, init) => ({ ok: true, json: () => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error('secret-bearing failure')), { once: true });
    }) }) as Response);
    const result = validateFeishuCredentials({ appId: 'cli', appSecret: 'secret' });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await result).toMatchObject({ valid: false, errorCode: 'feishuConnectionError', errors: [] });
  });
});
