import { createHash, randomBytes } from 'crypto';
import { createServer, type Server } from 'http';
import { proxyAwareFetch } from './proxy-fetch';

export const TOKENDANCE_APP_URL = 'https://clawx.com.cn';
export const TOKENDANCE_AUTH_URL = 'https://tokendance.space/auth';
export const TOKENDANCE_KEY_EXCHANGE_URL = 'https://tokendance.space/portal/api/v1/auth/keys';
export const TOKENDANCE_GATEWAY_BASE_URL = 'https://tokendance.space/gateway/v1';
export const TOKENDANCE_DEFAULT_MODEL = 'qwen3.8-max';
export const TOKENDANCE_APP_HEADER = { 'X-App-URL': TOKENDANCE_APP_URL } as const;

const OAUTH_TIMEOUT_MS = 10 * 60 * 1_000;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type TokenDanceOAuthResult = {
  apiKey: string;
};

export type TokenDanceOAuthOptions = {
  openUrl: (url: string) => Promise<void>;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  onAuthorizationUrl?: (url: string) => void;
  onProgress?: (message: string) => void;
};

function base64Url(value: Buffer): string {
  return value.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function createTokenDancePkce(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(64));
  const challenge = base64Url(createHash('sha256').update(verifier, 'ascii').digest());
  return { verifier, challenge };
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
    // Chromium may retain the loopback callback socket as a keep-alive
    // connection for several seconds. It is no longer needed once the
    // one-time code has been exchanged, so do not let it delay OAuth success.
    server.closeAllConnections();
  });
}

function abortError(message = 'tokendanceOAuth.cancelled'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

import { I18N_RESOURCES } from '@shared/i18n/resources';

function renderSuccessPage(acceptLanguage: string | string[] | undefined): string {
  const requestedLanguage = Array.isArray(acceptLanguage) ? acceptLanguage[0] : acceptLanguage;
  const language = requestedLanguage?.trim().toLowerCase() || 'en';
  const locale = language.startsWith('zh')
    ? 'zh'
    : language.startsWith('ja')
      ? 'ja'
      : language.startsWith('ru')
        ? 'ru'
        : 'en';
  const copy = I18N_RESOURCES[locale].settings.tokendanceOAuth.callback;
  const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

  return `<!doctype html>
<html lang="${locale}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>ClawX · TokenDance</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: #f7f7f5; color: #171717; }
    main { width: min(420px, calc(100vw - 48px)); padding: 40px; text-align: center; border-radius: 24px; background: #fff; box-shadow: 0 18px 60px rgba(0,0,0,.12); }
    .mark { display: grid; place-items: center; width: 56px; height: 56px; margin: 0 auto 20px; border-radius: 50%; background: #18181b; color: #fff; font-size: 30px; }
    h1 { margin: 0 0 12px; font-size: 26px; font-weight: 650; }
    p { margin: 6px 0; color: #52525b; line-height: 1.6; }
    @media (prefers-color-scheme: dark) { body { background: #111; color: #fafafa; } main { background: #1c1c1e; } p { color: #b3b3b8; } .mark { background: #fafafa; color: #18181b; } }
  </style>
</head>
<body>
  <main>
    <div class="mark" aria-hidden="true">✓</div>
    <h1>${escape(copy.title)}</h1>
    <p>${escape(copy.description)}</p>
    <p>${escape(copy.closeHint)}</p>
  </main>
  <script>window.setTimeout(() => window.close(), 3000)</script>
</body>
</html>`;
}

async function listenOnLoopback(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('tokendanceOAuth.callbackUnavailable');
  }
  return address.port;
}

export async function loginTokenDanceOAuth(
  options: TokenDanceOAuthOptions,
): Promise<TokenDanceOAuthResult> {
  if (options.signal?.aborted) throw abortError();
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort(abortError());
  options.signal?.addEventListener('abort', onOuterAbort, { once: true });
  const deadline = setTimeout(() => controller.abort(new Error('tokendanceOAuth.timedOut')), options.timeoutMs ?? OAUTH_TIMEOUT_MS);
  deadline.unref?.();

  const { verifier, challenge } = createTokenDancePkce();
  const flowId = base64Url(randomBytes(24));
  let settleCode: ((code: string) => void) | null = null;
  let rejectCode: ((error: Error) => void) | null = null;
  let settled = false;

  const codePromise = new Promise<string>((resolve, reject) => {
    settleCode = resolve;
    rejectCode = reject;
  });

  // Register rejection handling before opening the browser or binding sockets.
  void codePromise.catch(() => undefined);

  const server = createServer((request, response) => {
    try {
      const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
      const code = requestUrl.searchParams.get('code')?.trim();
      const callbackFlowId = requestUrl.searchParams.get('flow_id');
      if (request.method !== 'GET' || settled || requestUrl.pathname !== '/callback' || callbackFlowId !== flowId || !code || code.length > 4096) {
        response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end();
        return;
      }

      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Connection': 'close',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
      });
      response.end(renderSuccessPage(request.headers['accept-language']));
      if (!settled) {
        settled = true;
        options.onProgress?.('TokenDance authorization callback received');
        settleCode?.(code);
      }
    } catch (error) {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end();
      if (!settled) {
        settled = true;
        rejectCode?.(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });

  const onAbort = () => {
    if (!settled) {
      settled = true;
      rejectCode?.(controller.signal.reason instanceof Error ? controller.signal.reason : abortError());
    }
  };

  try {
    const port = await listenOnLoopback(server);
    const callbackUrl = new URL(`http://127.0.0.1:${port}/callback`);
    callbackUrl.searchParams.set('flow_id', flowId);

    const authorizationUrl = new URL(TOKENDANCE_AUTH_URL);
    authorizationUrl.searchParams.set('callback_url', callbackUrl.toString());
    authorizationUrl.searchParams.set('code_challenge', challenge);
    authorizationUrl.searchParams.set('code_challenge_method', 'S256');
    authorizationUrl.searchParams.set('app_url', TOKENDANCE_APP_URL);
    authorizationUrl.searchParams.set('key_name', 'ClawX');

    controller.signal.addEventListener('abort', onAbort, { once: true });
    if (controller.signal.aborted) onAbort();
    controller.signal.throwIfAborted();
    options.onAuthorizationUrl?.(authorizationUrl.toString());
    await options.openUrl(authorizationUrl.toString());
    const code = await codePromise;

    const fetchImpl = options.fetchImpl ?? proxyAwareFetch;
    const exchangeStartedAt = Date.now();
    const exchangeResponse = await fetchImpl(TOKENDANCE_KEY_EXCHANGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        code_verifier: verifier,
        code_challenge_method: 'S256',
      }),
      signal: controller.signal,
      redirect: 'error',
    });

    if (!exchangeResponse.ok) {
      throw new Error(`tokendanceOAuth.exchangeFailed:${exchangeResponse.status}`);
    }

    const reader = exchangeResponse.body?.getReader();
    let body = '';
    if (reader) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          controller.signal.throwIfAborted();
          if (done) break;
          if (Buffer.byteLength(body) + value.length > 16_384) throw new Error('tokendanceOAuth.exchangeFailed');
          body += Buffer.from(value).toString('utf8');
        }
      } finally { await reader.cancel().catch(() => undefined); }
    }
    controller.signal.throwIfAborted();
    let payload: { key?: unknown } | null = null;
    try { payload = JSON.parse(body); } catch { /* Fixed error below. */ }
    const apiKey = typeof payload?.key === 'string' ? payload.key.trim() : '';
    if (!apiKey || apiKey.length > 8192 || /[\r\n\0]/.test(apiKey)) {
      throw new Error('tokendanceOAuth.missingKey');
    }
    options.onProgress?.(`TokenDance API key exchange completed in ${Date.now() - exchangeStartedAt}ms`);
    controller.signal.throwIfAborted();
    return { apiKey };
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (error instanceof Error && /^tokendanceOAuth\.(exchangeFailed|missingKey|callbackUnavailable)(?::\d+)?$/.test(error.message)) throw error;
    // Provider transport errors may carry authorization codes or credentials.
    // eslint-disable-next-line preserve-caught-error
    throw new Error('tokendanceOAuth.failed');
  } finally {
    clearTimeout(deadline);
    options.signal?.removeEventListener('abort', onOuterAbort);
    controller.signal.removeEventListener('abort', onAbort);
    const closeStartedAt = Date.now();
    await closeServer(server);
    options.onProgress?.(`TokenDance callback server closed in ${Date.now() - closeStartedAt}ms`);
  }
}
