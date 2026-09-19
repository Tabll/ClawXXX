import type { ChannelCredentialErrorCode } from '@shared/types/channel';
import { proxyAwareFetch } from '../utils/proxy-fetch';

const ORIGINS = { feishu: 'https://open.feishu.cn', lark: 'https://open.larksuite.com' } as const;
export type FeishuValidation = {
  valid: boolean;
  errors: string[];
  warnings: string[];
  errorCode?: ChannelCredentialErrorCode;
  details?: { domain: 'feishu' | 'lark' };
};

export function feishuValidationFailure(errorCode: ChannelCredentialErrorCode): FeishuValidation {
  return { valid: false, errors: [], warnings: [], errorCode };
}

/** Main-only validation shared by native OpenClaw and the host relay. */
export async function validateFeishuCredentials(config: Readonly<Record<string, unknown>>): Promise<FeishuValidation> {
  const appId = typeof config.appId === 'string' ? config.appId.trim() : '';
  const appSecret = typeof config.appSecret === 'string' ? config.appSecret.trim() : '';
  if (!appId) return feishuValidationFailure('feishuAppIdRequired');
  if (!appSecret || appSecret === '__OPENCLAW_REDACTED__') return feishuValidationFailure('feishuAppSecretRequired');
  if (appSecret === appId) return feishuValidationFailure('feishuAppSecretEqualsAppId');
  const domain = typeof config.domain === 'string' ? config.domain.trim().toLowerCase() : '';
  if (domain && domain !== 'feishu' && domain !== 'lark') return feishuValidationFailure('feishuInvalidDomain');
  const domains: Array<keyof typeof ORIGINS> = domain ? [domain as keyof typeof ORIGINS] : ['feishu', 'lark'];
  let rejected = false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    for (const candidate of domains) {
      try {
        const response = await proxyAwareFetch(`${ORIGINS[candidate]}/open-apis/auth/v3/tenant_access_token/internal`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error',
          body: JSON.stringify({ app_id: appId, app_secret: appSecret }), signal: controller.signal,
        });
        const payload = await response.json() as { code?: number; tenant_access_token?: unknown };
        if (response.ok && payload.code === 0 && typeof payload.tenant_access_token === 'string' && payload.tenant_access_token.trim()) {
          return { valid: true, errors: [], warnings: [], details: { domain: candidate } };
        }
        rejected = true;
      } catch {
        if (controller.signal.aborted) break;
      }
    }
    // Provider bodies and credentials never become user-visible errors.
    return feishuValidationFailure(rejected ? 'feishuRejected' : 'feishuConnectionError');
  } finally { clearTimeout(timer); }
}

export function feishuCredentialChangeRequiresSecret(existing: Record<string, unknown>, incoming: Record<string, unknown>): boolean {
  return typeof incoming.appId === 'string' && typeof existing.appId === 'string'
    && incoming.appId.trim() !== existing.appId.trim() && !incoming.appSecret;
}
