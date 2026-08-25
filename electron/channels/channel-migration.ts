import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isSupportedChannelType } from '@shared/types/channel';
import { listAgentsSnapshotFromConfig } from '../utils/agent-config';
import { toUiChannelType } from '../utils/channel-alias';
import {
  getChannelFormValues,
  listConfiguredChannelAccountsFromConfig,
  readOpenClawConfig,
} from '../utils/channel-config';
import { getOpenClawConfigDir } from '../utils/paths';
import { captureChannelAuthBundle, safeChannelProjectionPath } from './channel-auth-bundle';
import type { ChannelAccountUpsertInput } from './channel-account-service';

export type LegacyCanonicalChannel = ChannelAccountUpsertInput & { agentId?: string };

/**
 * One-time metadata/config cutover only. Message, Conversation and Cron history
 * are intentionally never scanned or imported.
 */
export async function scanLegacyOpenClawChannels(): Promise<LegacyCanonicalChannel[]> {
  const config = await readOpenClawConfig();
  const configured = collectLegacyChannelAccounts(config);
  const agents = await listAgentsSnapshotFromConfig(config);
  const result: LegacyCanonicalChannel[] = [];
  const seen = new Set<string>();
  for (const [rawChannelType, accounts] of Object.entries(configured)) {
    const channelType = toUiChannelType(rawChannelType);
    if (!isSupportedChannelType(channelType)) continue;
    for (const nativeAccountId of accounts.accountIds) {
      const key = `${channelType}:${nativeAccountId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const values = await getChannelFormValues(channelType, nativeAccountId) ?? {};
      if (channelType === 'whatsapp') {
        const authRoot = safeChannelProjectionPath(
          resolve(getOpenClawConfigDir(), 'credentials', 'whatsapp'),
          nativeAccountId,
        );
        if (await pathExists(authRoot)) values.authBundle = await captureChannelAuthBundle(authRoot);
      }
      const section = config.channels?.[rawChannelType];
      const nativeAccounts = isRecord(section?.accounts) ? section.accounts : undefined;
      const nativeAccount = nativeAccounts && isRecord(nativeAccounts[nativeAccountId])
        ? nativeAccounts[nativeAccountId]
        : undefined;
      const agentId = agents.channelAccountOwners[`${rawChannelType}:${nativeAccountId}`]
        ?? agents.channelAccountOwners[`${channelType}:${nativeAccountId}`]
        ?? agents.channelOwners[rawChannelType]
        ?? agents.channelOwners[channelType]
        ?? agents.defaultAgentId;
      result.push({
        channelType,
        nativeAccountId,
        displayName: nativeAccountId,
        config: values,
        enabled: section?.enabled !== false && nativeAccount?.enabled !== false,
        isDefault: nativeAccountId === accounts.defaultAccountId,
        // This is an OpenClaw metadata import. Main extends compatibility from
        // every registered Channel adapter after registration completes.
        supportedKernels: ['openclaw'],
        ...(agentId ? { agentId } : {}),
      });
    }
  }
  return result;
}

/**
 * The ordinary OpenClaw helper intentionally hides disabled sections. A
 * one-time metadata migration must retain those accounts so users can enable
 * them later from the canonical UI. Empty control-only sections are ignored.
 */
export function collectLegacyChannelAccounts(
  config: Awaited<ReturnType<typeof readOpenClawConfig>>,
): ReturnType<typeof listConfiguredChannelAccountsFromConfig> {
  const result = listConfiguredChannelAccountsFromConfig(config);
  for (const [channelType, rawSection] of Object.entries(config.channels ?? {})) {
    if (!isRecord(rawSection)) continue;
    const rawAccounts = isRecord(rawSection.accounts) ? rawSection.accounts : undefined;
    const accountIds = rawAccounts
      ? Object.keys(rawAccounts).filter(accountId => accountId.trim().length > 0)
      : [];
    const hasPayload = Object.keys(rawSection).some(key => !['enabled', 'defaultAccount', 'accounts'].includes(key));
    if (accountIds.length === 0 && !hasPayload) continue;
    const defaultCandidate = typeof rawSection.defaultAccount === 'string' && rawSection.defaultAccount.trim()
      ? rawSection.defaultAccount.trim()
      : 'default';
    const sortedIds = accountIds.sort((left, right) => {
      if (left === 'default') return -1;
      if (right === 'default') return 1;
      return left.localeCompare(right);
    });
    result[channelType] = {
      defaultAccountId: sortedIds.includes(defaultCandidate)
        ? defaultCandidate
        : sortedIds[0] ?? 'default',
      accountIds: sortedIds.length > 0 ? sortedIds : ['default'],
    };
  }
  return result;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
