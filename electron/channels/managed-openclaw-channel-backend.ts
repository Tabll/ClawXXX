import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { CanonicalChannelAccount, CanonicalChannelTarget } from '@shared/domains/channels';
import { isSupportedChannelType } from '@shared/types/channel';
import type { GatewayManager } from '../gateway/manager';
import { mutateOpenClawConfig } from '../gateway/config-delivery';
import {
  deleteChannelAccountConfig,
  saveChannelConfig,
  validateChannelCredentials,
  type OpenClawConfig,
} from '../utils/channel-config';
import {
  ensureDiscordPluginInstalled,
  ensureDingTalkPluginInstalled,
  ensureFeishuPluginInstalled,
  ensureQQBotPluginInstalled,
  ensureWeChatPluginInstalled,
  ensureWeComPluginInstalled,
  ensureWhatsAppPluginInstalled,
} from '../utils/plugin-install';
import { getOpenClawConfigDir } from '../utils/paths';
import {
  toOpenClawChannelType,
} from '../utils/channel-alias';
import {
  cancelWeChatLoginSession,
  saveWeChatAccountState,
  startWeChatLoginSession,
  waitForWeChatLoginSession,
} from '../utils/wechat-login';
import { whatsAppLoginManager } from '../utils/whatsapp-login';
import type { ChannelHandoffServer } from './channel-handoff-server';
import type { OpenClawNativeChannelBackend } from './openclaw-channel-adapter';
import type {
  ChannelConnectorStatus,
  ChannelCredentialValidation,
  ChannelLoginEvent,
  ChannelOutboundEnvelope,
} from './channel-runtime-contracts';
import {
  captureChannelAuthBundle,
  restoreChannelAuthBundle,
  safeChannelProjectionPath,
} from './channel-auth-bundle';

const HANDOFF_PLUGIN_ID = 'clawx-channel-handoff';
const WECHAT_QR_TIMEOUT_MS = 8 * 60_000;

type OpenClawStatusPayload = {
  channelAccounts?: Record<string, Array<{
    accountId?: string;
    connected?: boolean;
    running?: boolean;
    linked?: boolean;
    configured?: boolean;
    lastError?: string;
  }>>;
};

type TargetLoader = (
  channelType: string,
  nativeAccountId: string,
  query?: string,
) => Promise<CanonicalChannelTarget[]>;

/** OpenClaw native connector projection with canonical ingress hand-off. */
export class ManagedOpenClawChannelBackend implements OpenClawNativeChannelBackend {
  private readonly projectedConfig = new Map<string, Record<string, unknown>>();
  private readonly projectedAccounts = new Map<string, CanonicalChannelAccount>();
  private readonly loginSessions = new Map<string, string>();
  private readonly authSyncTimers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly authBundleHashes = new Map<string, string>();

  constructor(
    private readonly gateway: GatewayManager,
    private readonly handoff: ChannelHandoffServer,
    private readonly pluginPath: string,
    private readonly loadTargets: TargetLoader,
    private readonly persistCredential?: (accountId: string, values: Record<string, string>) => Promise<void>,
  ) {}

  async validate(
    channelType: string,
    config: Readonly<Record<string, unknown>>,
  ): Promise<ChannelCredentialValidation> {
    if (!isSupportedChannelType(channelType)) {
      return { valid: false, errors: [`Unsupported Channel: ${channelType}`] };
    }
    return validateChannelCredentials(channelType, config as Record<string, string>);
  }

  async projectAccount(
    account: CanonicalChannelAccount,
    config: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await ensureHandoffPluginProjection(this.pluginPath);
    await ensureChannelPlugin(account.channelType);
    const next: Record<string, unknown> = { ...config, enabled: account.enabled };
    if (account.channelType === 'whatsapp' && typeof next.authBundle === 'string') {
      this.authBundleHashes.set(account.id, bundleHash(next.authBundle));
      await restoreChannelAuthBundle(authRoot(account.nativeAccountId), next.authBundle);
      delete next.authBundle;
    }
    await saveChannelConfig(account.channelType, next, account.nativeAccountId);
    this.projectedConfig.set(account.id, { ...next });
    this.projectedAccounts.set(account.id, account);
  }

  async removeAccount(account: CanonicalChannelAccount): Promise<void> {
    this.stopAuthSync(account.id);
    this.projectedConfig.delete(account.id);
    this.projectedAccounts.delete(account.id);
    this.authBundleHashes.delete(account.id);
    await deleteChannelAccountConfig(account.channelType, account.nativeAccountId);
  }

  async enableAccount(account: CanonicalChannelAccount): Promise<void> {
    const config = this.projectedConfig.get(account.id) ?? {};
    await saveChannelConfig(account.channelType, { ...config, enabled: true }, account.nativeAccountId);
    if (account.channelType === 'whatsapp') this.startAuthSync(account);
  }

  async disableAccount(account: CanonicalChannelAccount): Promise<void> {
    this.stopAuthSync(account.id);
    if (account.channelType === 'whatsapp') await this.syncWhatsAppAuth(account).catch(() => undefined);
    const config = this.projectedConfig.get(account.id) ?? {};
    await saveChannelConfig(account.channelType, { ...config, enabled: false }, account.nativeAccountId);
  }

  async send(message: ChannelOutboundEnvelope): Promise<void> {
    const account = this.projectedAccounts.get(message.accountId);
    if (!account) throw new Error(`OpenClaw Channel account is not projected: ${message.accountId}`);
    const channel = toOpenClawChannelType(message.channelType);
    const sends = message.attachments.length > 0 ? message.attachments : [undefined];
    for (let index = 0; index < sends.length; index += 1) {
      const attachment = sends[index];
      await this.gateway.rpc('send', {
        to: message.targetId,
        ...(index === 0 && message.text !== undefined ? { message: message.text } : {}),
        ...(attachment ? {
          buffer: Buffer.from(attachment.data).toString('base64'),
          filename: attachment.fileName ?? `attachment-${index + 1}`,
          contentType: attachment.mimeType,
        } : {}),
        channel,
        accountId: account.nativeAccountId,
        ...(message.replyToExternalMessageId ? { replyToId: message.replyToExternalMessageId } : {}),
        idempotencyKey: `${message.externalMessageId}:${index}`,
      }, 30_000);
    }
  }

  async targets(account: CanonicalChannelAccount, query?: string): Promise<CanonicalChannelTarget[]> {
    return this.loadTargets(account.channelType, account.nativeAccountId, query);
  }

  async status(account: CanonicalChannelAccount): Promise<ChannelConnectorStatus> {
    try {
      const payload = await this.gateway.rpc<OpenClawStatusPayload>('channels.status', { probe: false }, 8_000);
      const storedChannel = toOpenClawChannelType(account.channelType);
      const snapshot = payload.channelAccounts?.[storedChannel]?.find(candidate => (
        candidate.accountId === account.nativeAccountId
      ));
      if (snapshot?.lastError) {
        return { state: 'error', detail: snapshot.lastError.slice(0, 500), changedAt: new Date().toISOString() };
      }
      if (snapshot?.connected || snapshot?.running || snapshot?.linked) {
        return { state: 'connected', changedAt: new Date().toISOString() };
      }
      return {
        state: this.gateway.getStatus().state === 'running' ? 'connecting' : 'disconnected',
        changedAt: new Date().toISOString(),
      };
    } catch (error) {
      return {
        state: 'error',
        detail: safeError(error),
        changedAt: new Date().toISOString(),
      };
    }
  }

  async subscribeInbound(
    account: CanonicalChannelAccount,
    handler: Parameters<ChannelHandoffServer['subscribe']>[1],
  ): Promise<() => void> {
    return this.handoff.subscribe(account, handler);
  }

  async startLogin(
    channelType: string,
    nativeAccountId: string | undefined,
    emit: (event: ChannelLoginEvent) => void,
  ): Promise<void> {
    const accountId = nativeAccountId ?? 'default';
    if (channelType === 'whatsapp') {
      const onQr = (payload: { qr?: string; raw?: string }) => {
        const qr = payload.qr ?? payload.raw;
        if (qr) emit({ type: 'qr', qr });
      };
      const onSuccess = async (payload: { accountId?: string }) => {
        cleanup();
        try {
          const resolvedAccountId = payload.accountId ?? accountId;
          emit({
            type: 'success',
            nativeAccountId: resolvedAccountId,
            credential: { authBundle: await captureChannelAuthBundle(authRoot(resolvedAccountId)) },
          });
        } catch (error) {
          emit({ type: 'error', message: safeError(error) });
        }
      };
      const onError = (error: unknown) => {
        cleanup();
        emit({ type: 'error', message: safeError(error) });
      };
      const cleanup = () => {
        whatsAppLoginManager.off('qr', onQr);
        whatsAppLoginManager.off('success', onSuccess);
        whatsAppLoginManager.off('error', onError);
      };
      whatsAppLoginManager.on('qr', onQr);
      whatsAppLoginManager.on('success', onSuccess);
      whatsAppLoginManager.on('error', onError);
      try {
        await whatsAppLoginManager.start(accountId);
      } catch (error) {
        cleanup();
        throw error;
      }
      return;
    }
    if (channelType !== 'wechat') throw new Error(`Unsupported OpenClaw login channel: ${channelType}`);
    await ensureChannelPlugin(channelType);
    const started = await startWeChatLoginSession({ accountId, force: true });
    if (!started.sessionKey || !started.qrcodeUrl) {
      throw new Error(started.message || 'Failed to start WeChat QR login');
    }
    const loginKey = `${channelType}:${accountId}`;
    this.loginSessions.set(loginKey, started.sessionKey);
    emit({ type: 'qr', qr: started.qrcodeUrl, sessionKey: started.sessionKey });
    void this.awaitWeChatLogin(loginKey, accountId, started.sessionKey, emit);
  }

  async cancelLogin(channelType: string, nativeAccountId?: string): Promise<void> {
    if (channelType === 'whatsapp') {
      await whatsAppLoginManager.stop();
      return;
    }
    if (channelType !== 'wechat') return;
    const key = `${channelType}:${nativeAccountId ?? 'default'}`;
    const sessionKey = this.loginSessions.get(key);
    this.loginSessions.delete(key);
    if (sessionKey) await cancelWeChatLoginSession(sessionKey);
  }

  private async awaitWeChatLogin(
    loginKey: string,
    requestedAccountId: string,
    sessionKey: string,
    emit: (event: ChannelLoginEvent) => void,
  ): Promise<void> {
    try {
      const result = await waitForWeChatLoginSession({
        sessionKey,
        timeoutMs: WECHAT_QR_TIMEOUT_MS,
        onQrRefresh: async ({ qrcodeUrl }) => {
          if (this.loginSessions.get(loginKey) === sessionKey) {
            emit({ type: 'qr', qr: qrcodeUrl, sessionKey });
          }
        },
      });
      if (this.loginSessions.get(loginKey) !== sessionKey) return;
      if (!result.connected || !result.accountId || !result.botToken) {
        emit({ type: 'error', message: result.message || 'WeChat login did not complete' });
        return;
      }
      const nativeAccountId = await saveWeChatAccountState(result.accountId, {
        token: result.botToken,
        baseUrl: result.baseUrl,
        userId: result.userId,
      });
      emit({
        type: 'success',
        nativeAccountId: nativeAccountId || requestedAccountId,
        message: result.message,
        credential: {
          botToken: result.botToken,
          ...(result.baseUrl ? { baseUrl: result.baseUrl } : {}),
          ...(result.userId ? { userId: result.userId } : {}),
        },
      });
    } catch (error) {
      if (this.loginSessions.get(loginKey) === sessionKey) {
        emit({ type: 'error', message: safeError(error) });
      }
    } finally {
      if (this.loginSessions.get(loginKey) === sessionKey) this.loginSessions.delete(loginKey);
      await cancelWeChatLoginSession(sessionKey).catch(() => undefined);
    }
  }

  private startAuthSync(account: CanonicalChannelAccount): void {
    this.stopAuthSync(account.id);
    const timer = setInterval(() => {
      void this.syncWhatsAppAuth(account).catch(() => undefined);
    }, 10_000);
    timer.unref?.();
    this.authSyncTimers.set(account.id, timer);
  }

  private stopAuthSync(accountId: string): void {
    const timer = this.authSyncTimers.get(accountId);
    if (timer) clearInterval(timer);
    this.authSyncTimers.delete(accountId);
  }

  private async syncWhatsAppAuth(account: CanonicalChannelAccount): Promise<void> {
    if (!this.persistCredential) return;
    const authBundle = await captureChannelAuthBundle(authRoot(account.nativeAccountId));
    const hash = bundleHash(authBundle);
    if (this.authBundleHashes.get(account.id) === hash) return;
    await this.persistCredential(account.id, { authBundle });
    this.authBundleHashes.set(account.id, hash);
  }
}

export async function ensureHandoffPluginProjection(pluginPath: string): Promise<void> {
  const normalizedPath = resolve(pluginPath);
  await mutateOpenClawConfig((snapshot) => {
    const config = snapshot as OpenClawConfig;
    const plugins = config.plugins ?? (config.plugins = {});
    plugins.enabled = true;
    const load = isRecord(plugins.load) ? plugins.load : {};
    const paths = Array.isArray(load.paths) ? load.paths.filter((value): value is string => typeof value === 'string') : [];
    if (!paths.includes(normalizedPath)) paths.push(normalizedPath);
    load.paths = paths;
    plugins.load = load;
    const allow = Array.isArray(plugins.allow) ? plugins.allow : [];
    if (!allow.includes(HANDOFF_PLUGIN_ID)) plugins.allow = [...allow, HANDOFF_PLUGIN_ID];
    const entries = plugins.entries ?? (plugins.entries = {});
    entries[HANDOFF_PLUGIN_ID] = { ...(entries[HANDOFF_PLUGIN_ID] ?? {}), enabled: true };
  });
}

async function ensureChannelPlugin(channelType: string): Promise<void> {
  const installer = installerMap[channelType as keyof typeof installerMap];
  if (!installer) return;
  const result = await installer();
  if (!result.installed) throw new Error(result.warning || `${channelType} plugin installation failed`);
}

const installerMap = {
  discord: ensureDiscordPluginInstalled,
  dingtalk: ensureDingTalkPluginInstalled,
  feishu: ensureFeishuPluginInstalled,
  qqbot: ensureQQBotPluginInstalled,
  whatsapp: ensureWhatsAppPluginInstalled,
  wechat: ensureWeChatPluginInstalled,
  wecom: ensureWeComPluginInstalled,
};

function authRoot(accountId: string): string {
  return safeChannelProjectionPath(resolve(getOpenClawConfigDir(), 'credentials', 'whatsapp'), accountId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/((?:token|secret|password|authorization)\s*[=:]\s*)\S+/gi, '$1[redacted]')
    .slice(0, 500);
}

function bundleHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
