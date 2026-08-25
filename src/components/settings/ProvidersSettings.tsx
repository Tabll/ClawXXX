/**
 * Providers Settings Component
 * Manage AI provider configurations and API keys
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  Plus,
  Trash2,
  Edit,
  Check,
  X,
  Loader2,
  Key,
  ExternalLink,
  Copy,
  XCircle,
  ChevronDown,
  Brain,
  ImageIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  SecureSecretInput,
  type SecureSecretInputHandle,
} from '@/components/ui/secure-secret-input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';
import {
  useProviderStore,
  type ProviderAccount,
  type ProviderConfig,
  type ProviderKernelDefault,
  type ProviderVendorInfo,
} from '@/stores/providers';
import {
  PROVIDER_TYPE_INFO,
  getProviderDocsUrl,
  type ProviderType,
  getProviderIconUrl,
  resolveProviderModelForSave,
  shouldShowProviderModelId,
  shouldInvertInDark,
} from '@/lib/providers';
import {
  buildProviderAccountId,
  buildProviderListItems,
  hasConfiguredCredentials,
  type ProviderListItem,
} from '@/lib/provider-accounts';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '@/stores/settings';
import { hostApi } from '@/lib/host-api';
import { hostEvents } from '@/lib/host-events';
import type { OAuthCodeEvent, OAuthErrorEvent, OAuthSuccessEvent } from '@shared/host-events/contract';
import { kernelDisplayName, kernelOptionsFor, useKernelStore } from '@/stores/kernels';

const inputClasses = 'h-[44px] rounded-xl font-mono text-meta bg-transparent border-black/10 dark:border-white/10 focus-visible:ring-2 focus-visible:ring-blue-500/50 focus-visible:border-blue-500 shadow-sm transition-all text-foreground placeholder:text-foreground/40';
const labelClasses = 'text-sm text-foreground/80 font-bold';
type CodePlanMode = 'apikey' | 'codeplan';
function accountSupportsKernel(account: ProviderAccount, kernelId: string): boolean {
  return !account.supportedKernels?.length || account.supportedKernels.includes(kernelId);
}

function providerModelIds(account: ProviderAccount): string[] {
  return Array.from(new Set([
    account.model,
    ...(account.metadata?.customModels ?? []),
  ].map(value => value?.trim()).filter((value): value is string => Boolean(value))));
}

function isZaiProviderType(type: string | undefined): boolean {
  return type === 'zai' || type === 'zai-global';
}

function normalizeFallbackProviderIds(ids?: string[]): string[] {
  return Array.from(new Set((ids ?? []).filter(Boolean)));
}

function getProtocolBaseUrlPlaceholder(
  apiProtocol: ProviderAccount['apiProtocol'],
): string {
  if (apiProtocol === 'anthropic-messages') {
    return 'https://api.example.com/anthropic';
  }
  return 'https://api.example.com/v1';
}

function fallbackProviderIdsEqual(a?: string[], b?: string[]): boolean {
  const left = normalizeFallbackProviderIds(a).sort();
  const right = normalizeFallbackProviderIds(b).sort();
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function normalizeFallbackModels(models?: string[]): string[] {
  return Array.from(new Set((models ?? []).map((model) => model.trim()).filter(Boolean)));
}

function fallbackModelsEqual(a?: string[], b?: string[]): boolean {
  const left = normalizeFallbackModels(a);
  const right = normalizeFallbackModels(b);
  return left.length === right.length && left.every((model, index) => model === right[index]);
}

function getUserAgentHeader(headers?: Record<string, string>): string {
  if (!headers) return '';
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'user-agent') {
      return value;
    }
  }
  return '';
}

function mergeHeadersWithUserAgent(
  headers: Record<string, string> | undefined,
  userAgent: string,
): Record<string, string> {
  const next = Object.fromEntries(
    Object.entries(headers ?? {}).filter(([key]) => key.toLowerCase() !== 'user-agent'),
  );
  const normalizedUserAgent = userAgent.trim();
  if (normalizedUserAgent) {
    next['User-Agent'] = normalizedUserAgent;
  }
  return next;
}

function isCodePlanMode(
  baseUrl: string | undefined,
  modelId: string | undefined,
  codePlanPresetBaseUrl?: string,
  codePlanPresetModelId?: string,
): boolean {
  if (!codePlanPresetBaseUrl || !codePlanPresetModelId) return false;
  return (baseUrl || '').trim() === codePlanPresetBaseUrl && (modelId || '').trim() === codePlanPresetModelId;
}

function shouldShowUserAgentField(account: ProviderAccount): boolean {
  return account.vendorId === 'custom';
}

function shouldShowUserAgentFieldForNewProvider(providerType: ProviderType | null): boolean {
  return providerType === 'custom';
}

function getAuthModeLabel(
  authMode: ProviderAccount['authMode'],
  t: (key: string) => string
): string {
  switch (authMode) {
    case 'api_key':
      return t('aiProviders.authModes.apiKey');
    case 'oauth_device':
      return t('aiProviders.authModes.oauthDevice');
    case 'oauth_browser':
      return t('aiProviders.authModes.oauthBrowser');
    case 'local':
      return t('aiProviders.authModes.local');
    default:
      return authMode;
  }
}

type ModelCapabilitiesDraft = {
  reasoning: boolean;
  imageInput: boolean;
};

function inferModelImageInput(modelId: string | undefined): boolean {
  const normalized = (modelId ?? '').trim().toLowerCase();
  return (
    /\b(?:gpt-4o|gpt-4\.1|gpt-[5-9]|o[134])\b/.test(normalized)
    || /\bclaude-(?:3|4|fable|sonnet|opus|haiku)\b/.test(normalized)
    || /\bgemini\b/.test(normalized)
    || /\b(?:qwen[\w.-]*-?vl|qwen-vl)\b/.test(normalized)
    || /\b(?:vision|llava|pixtral|internvl|mllama|minicpm-v|glm-4v)\b/.test(normalized)
    || /(?:^|[-_/])vl(?:[-_/]|$)/.test(normalized)
  );
}

function resolveModelCapabilitiesDraft(
  capabilities: ProviderAccount['modelCapabilities'] | undefined,
  modelId: string | undefined,
): ModelCapabilitiesDraft {
  return {
    reasoning: capabilities?.reasoning ?? false,
    imageInput: capabilities?.imageInput ?? inferModelImageInput(modelId),
  };
}

function buildModelCapabilities(
  reasoning: boolean,
  imageInput: boolean,
): ModelCapabilitiesDraft {
  return { reasoning, imageInput };
}

function modelCapabilitiesEqual(left: ModelCapabilitiesDraft, right: ModelCapabilitiesDraft): boolean {
  return left.reasoning === right.reasoning && left.imageInput === right.imageInput;
}

export function ProvidersSettings() {
  const { t } = useTranslation('settings');
  const devModeUnlocked = useSettingsStore((state) => state.devModeUnlocked);
  const {
    statuses,
    accounts,
    vendors,
    defaultAccountId,
    kernelDefaults,
    loading,
    refreshProviderSnapshot,
    createAccount,
    removeAccount,
    updateAccount,
    setDefaultAccount,
    setKernelDefault,
    validateAccountApiKey,
  } = useProviderStore();
  const kernelCatalog = useKernelStore((state) => state.catalog);
  const providerKernelIds = useMemo(() => kernelOptionsFor(
    kernelCatalog,
    [
      ...kernelDefaults.map(entry => entry.kernelId),
      ...accounts.flatMap(account => [
        ...(account.supportedKernels ?? []),
        ...(account.projections ?? []).map(projection => projection.kernelId),
      ]),
    ],
  ).map(option => option.id), [accounts, kernelCatalog, kernelDefaults]);

  const [showAddDialog, setShowAddDialog] = useState(false);
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const vendorMap = new Map(vendors.map((vendor) => [vendor.id, vendor]));
  const existingVendorIds = new Set(accounts.map((account) => account.vendorId));
  const displayProviders = useMemo(
    () => buildProviderListItems(accounts, statuses, vendors, defaultAccountId),
    [accounts, statuses, vendors, defaultAccountId],
  );

  // Fetch providers on mount
  useEffect(() => {
    refreshProviderSnapshot();
  }, [refreshProviderSnapshot]);

  const handleAddProvider = async (
    type: ProviderType,
    name: string,
    credentialHandle: string | undefined,
    options?: {
      baseUrl?: string;
      model?: string;
      authMode?: ProviderAccount['authMode'];
      apiProtocol?: ProviderAccount['apiProtocol'];
      headers?: Record<string, string>;
      modelCapabilities?: ProviderAccount['modelCapabilities'];
    }
  ) => {
    const vendor = vendorMap.get(type);
    const id = buildProviderAccountId(type, null, vendors);
    try {
      await createAccount({
        id,
        vendorId: type,
        label: name,
        authMode: options?.authMode || vendor?.defaultAuthMode || (type === 'ollama' ? 'local' : 'api_key'),
        baseUrl: options?.baseUrl,
        apiProtocol: options?.apiProtocol,
        headers: options?.headers,
        model: options?.model,
        modelCapabilities: options?.modelCapabilities,
        enabled: true,
        isDefault: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }, credentialHandle);

      // Auto-set as default if no default is currently configured
      if (!defaultAccountId) {
        await setDefaultAccount(id);
      }

      setShowAddDialog(false);
      toast.success(t('aiProviders.toast.added'));
    } catch (error) {
      toast.error(`${t('aiProviders.toast.failedAdd')}: ${error}`);
    }
  };

  const handleDeleteProvider = async (providerId: string) => {
    try {
      await removeAccount(providerId);
      toast.success(t('aiProviders.toast.deleted'));
    } catch (error) {
      toast.error(`${t('aiProviders.toast.failedDelete')}: ${error}`);
    }
  };

  const handleSetDefault = async (providerId: string) => {
    try {
      await setDefaultAccount(providerId);
      toast.success(t('aiProviders.toast.defaultUpdated'));
    } catch (error) {
      toast.error(`${t('aiProviders.toast.failedDefault')}: ${error}`);
    }
  };

  const handleSetKernelDefault = async (kernelId: string, accountId: string, modelId?: string) => {
    try {
      await setKernelDefault(kernelId, accountId, modelId);
      toast.success(t('aiProviders.toast.kernelDefaultUpdated'));
    } catch (error) {
      toast.error(`${t('aiProviders.toast.failedKernelDefault')}: ${error}`);
    }
  };

  return (
    <div data-testid="providers-settings" className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 data-testid="providers-settings-title" className="text-3xl font-serif text-foreground font-normal tracking-tight">
          {t('aiProviders.title', 'AI Providers')}
        </h2>
        <Button data-testid="providers-add-button" onClick={() => setShowAddDialog(true)} className="rounded-full px-5 h-9 shadow-none font-medium text-meta">
          <Plus className="h-4 w-4 mr-2" />
          {t('aiProviders.add')}
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground bg-black/5 dark:bg-white/5 rounded-3xl border border-transparent border-dashed">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      ) : displayProviders.length === 0 ? (
        <div data-testid="providers-empty-state" className="flex flex-col items-center justify-center py-20 text-muted-foreground bg-black/5 dark:bg-white/5 rounded-3xl border border-transparent border-dashed">
          <Key className="h-12 w-12 mb-4 opacity-50" />
          <h3 className="text-sm font-medium mb-1 text-foreground">{t('aiProviders.empty.title')}</h3>
          <p className="text-meta text-center mb-6 max-w-sm">
            {t('aiProviders.empty.desc')}
          </p>
          <Button onClick={() => setShowAddDialog(true)} className="rounded-full px-6 h-10 bg-brand hover:bg-brand-hover text-white">
            <Plus className="h-4 w-4 mr-2" />
            {t('aiProviders.empty.cta')}
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <KernelProviderDefaultsPanel
            kernelIds={providerKernelIds}
            accounts={accounts}
            defaults={kernelDefaults}
            onChange={handleSetKernelDefault}
          />
          {displayProviders.map((item) => (
            <ProviderCard
              kernelIds={providerKernelIds}
              key={item.account.id}
              item={item}
              allProviders={displayProviders}
              isDefault={item.account.id === defaultAccountId}
              kernelDefaults={kernelDefaults}
              isEditing={editingProvider === item.account.id}
              onEdit={() => setEditingProvider(item.account.id)}
              onCancelEdit={() => setEditingProvider(null)}
              onDelete={() => handleDeleteProvider(item.account.id)}
              onSetDefault={() => handleSetDefault(item.account.id)}
              onSetKernelDefault={(kernelId) => (
                handleSetKernelDefault(kernelId, item.account.id, item.account.model)
              )}
              onSaveEdits={async (payload) => {
                const updates: Partial<ProviderAccount> = {};
                if (payload.updates) {
                  if (payload.updates.baseUrl !== undefined) updates.baseUrl = payload.updates.baseUrl;
                  if (payload.updates.apiProtocol !== undefined) updates.apiProtocol = payload.updates.apiProtocol;
                  if (payload.updates.headers !== undefined) updates.headers = payload.updates.headers;
                  if (payload.updates.model !== undefined) updates.model = payload.updates.model;
                  if (payload.updates.modelCapabilities !== undefined) {
                    updates.modelCapabilities = payload.updates.modelCapabilities;
                  }
                  if (payload.updates.fallbackModels !== undefined) updates.fallbackModels = payload.updates.fallbackModels;
                  if (payload.updates.fallbackProviderIds !== undefined) {
                    updates.fallbackAccountIds = payload.updates.fallbackProviderIds;
                  }
                }
                await updateAccount(
                  item.account.id,
                  updates,
                  payload.credentialHandle
                );
                setEditingProvider(null);
              }}
              onValidateKey={(handle, options) => validateAccountApiKey(
                item.account.id,
                handle,
                item.account.supportedKernels,
                options,
              )}
              devModeUnlocked={devModeUnlocked}
            />
          ))}
        </div>
      )}

      {/* Add Provider Dialog */}
      <AddProviderDialog
        kernelIds={providerKernelIds}
        open={showAddDialog}
        existingVendorIds={existingVendorIds}
        vendors={vendors}
        onClose={() => setShowAddDialog(false)}
        onAdd={handleAddProvider}
        onValidateKey={(type, handle, kernelIds, options) => (
          validateAccountApiKey(type, handle, kernelIds, options)
        )}
        devModeUnlocked={devModeUnlocked}
      />
    </div>
  );
}

function KernelProviderDefaultsPanel({
  kernelIds,
  accounts,
  defaults,
  onChange,
}: {
  kernelIds: string[];
  accounts: ProviderAccount[];
  defaults: ProviderKernelDefault[];
  onChange: (kernelId: string, accountId: string, modelId?: string) => Promise<void>;
}) {
  const { t } = useTranslation('settings');
  const [savingKernelId, setSavingKernelId] = useState<string | null>(null);

  return (
    <div
      data-testid="provider-kernel-defaults"
      className="grid gap-3 rounded-2xl border border-black/5 bg-black/[0.025] p-4 dark:border-white/5 dark:bg-white/[0.035] md:grid-cols-2"
    >
      {kernelIds.map((kernelId) => {
        const choices = accounts.flatMap(account => (
          accountSupportsKernel(account, kernelId)
            ? providerModelIds(account).map(modelId => ({ account, modelId }))
            : []
        ));
        const current = defaults.find(entry => entry.kernelId === kernelId);
        const currentAccount = current
          ? accounts.find(account => account.id === current.accountId)
          : undefined;
        const currentModel = current?.modelId || currentAccount?.model || '';
        const currentValue = current
          ? `${encodeURIComponent(current.accountId)}:${encodeURIComponent(currentModel)}`
          : '';

        return (
          <div key={kernelId} className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label className="text-sm font-bold text-foreground/80">
                {kernelDisplayName(kernelId)}
              </Label>
              <span className="rounded-full bg-black/5 px-2 py-0.5 font-mono text-2xs text-foreground/60 dark:bg-white/10">
                {t('aiProviders.kernels.defaultModel')}
              </span>
            </div>
            <select
              data-testid={`provider-kernel-default-${kernelId}`}
              value={currentValue}
              disabled={choices.length === 0 || savingKernelId === kernelId}
              onChange={async event => {
                const [encodedAccountId, encodedModelId = ''] = event.target.value.split(':');
                if (!encodedAccountId) return;
                setSavingKernelId(kernelId);
                try {
                  await onChange(
                    kernelId,
                    decodeURIComponent(encodedAccountId),
                    decodeURIComponent(encodedModelId) || undefined,
                  );
                } finally {
                  setSavingKernelId(null);
                }
              }}
              className="h-10 w-full rounded-xl border border-black/10 bg-surface-input px-3 text-meta text-foreground outline-none focus:border-blue-500 dark:border-white/10"
            >
              <option value="">{t('aiProviders.kernels.selectDefault')}</option>
              {choices.map(({ account, modelId }) => (
                <option
                  key={`${account.id}:${modelId}`}
                  value={`${encodeURIComponent(account.id)}:${encodeURIComponent(modelId)}`}
                >
                  {account.label} · {modelId}
                </option>
              ))}
            </select>
            {choices.length === 0 && (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                {t('aiProviders.kernels.noCompatibleModel')}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

interface ProviderCardProps {
  kernelIds: string[];
  item: ProviderListItem;
  allProviders: ProviderListItem[];
  isDefault: boolean;
  kernelDefaults: ProviderKernelDefault[];
  isEditing: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onDelete: () => void;
  onSetDefault: () => void;
  onSetKernelDefault: (kernelId: string) => Promise<void>;
  onSaveEdits: (payload: { credentialHandle?: string; updates?: Partial<ProviderConfig> }) => Promise<void>;
  onValidateKey: (
    credentialHandle: string,
    options?: { baseUrl?: string; apiProtocol?: ProviderAccount['apiProtocol']; modelId?: string }
  ) => Promise<{ valid: boolean; error?: string }>;
  devModeUnlocked: boolean;
}



function ProviderCard({
  kernelIds,
  item,
  allProviders,
  isDefault,
  kernelDefaults,
  isEditing,
  onEdit,
  onCancelEdit,
  onDelete,
  onSetDefault,
  onSetKernelDefault,
  onSaveEdits,
  onValidateKey,
  devModeUnlocked,
}: ProviderCardProps) {
  const { t, i18n } = useTranslation('settings');
  const { account, vendor, status } = item;
  const secretInputRef = React.useRef<SecureSecretInputHandle>(null);
  const [hasNewCredential, setHasNewCredential] = useState(false);
  const [baseUrl, setBaseUrl] = useState(account.baseUrl || '');
  const [apiProtocol, setApiProtocol] = useState<ProviderAccount['apiProtocol']>(account.apiProtocol || 'openai-completions');
  const [userAgent, setUserAgent] = useState(getUserAgentHeader(account.headers));
  const [modelId, setModelId] = useState(account.model || '');
  const [modelSupportsReasoning, setModelSupportsReasoning] = useState(
    resolveModelCapabilitiesDraft(account.modelCapabilities, account.model).reasoning,
  );
  const [modelSupportsImages, setModelSupportsImages] = useState(
    resolveModelCapabilitiesDraft(account.modelCapabilities, account.model).imageInput,
  );
  const [fallbackModelsText, setFallbackModelsText] = useState(
    normalizeFallbackModels(account.fallbackModels).join('\n')
  );
  const [fallbackProviderIds, setFallbackProviderIds] = useState<string[]>(
    normalizeFallbackProviderIds(account.fallbackAccountIds)
  );
  const [showFallback, setShowFallback] = useState(false);
  const [validating, setValidating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [codePlanMode, setCodePlanMode] = useState<CodePlanMode>('apikey');
  const [validationError, setValidationError] = useState<string | null>(null);

  const typeInfo = PROVIDER_TYPE_INFO.find((t) => t.id === account.vendorId);
  const providerDocsUrl = getProviderDocsUrl(typeInfo, i18n.language);
  const showModelIdField = shouldShowProviderModelId(typeInfo, devModeUnlocked);
  const codePlanPreset = typeInfo?.codePlanPresetBaseUrl && typeInfo?.codePlanPresetModelId
    ? {
      baseUrl: typeInfo.codePlanPresetBaseUrl,
      modelId: typeInfo.codePlanPresetModelId,
    }
    : null;
  const effectiveDocsUrl = codePlanMode === 'codeplan'
    ? (typeInfo?.codePlanDocsUrl || providerDocsUrl)
    : providerDocsUrl;
  const canEditModelConfig = Boolean(typeInfo?.showBaseUrl || showModelIdField);
  const showUserAgentField = shouldShowUserAgentField(account);

  useEffect(() => {
    if (isEditing) {
      secretInputRef.current?.clear();
      setHasNewCredential(false);
      setBaseUrl(account.baseUrl || '');
      setApiProtocol(account.apiProtocol || 'openai-completions');
      setUserAgent(getUserAgentHeader(account.headers));
      setModelId(account.model || '');
      const capabilities = resolveModelCapabilitiesDraft(account.modelCapabilities, account.model);
      setModelSupportsReasoning(capabilities.reasoning);
      setModelSupportsImages(capabilities.imageInput);
      setFallbackModelsText(normalizeFallbackModels(account.fallbackModels).join('\n'));
      setFallbackProviderIds(normalizeFallbackProviderIds(account.fallbackAccountIds));
      setValidationError(null);
      setCodePlanMode(
        isCodePlanMode(
          account.baseUrl,
          account.model,
          typeInfo?.codePlanPresetBaseUrl,
          typeInfo?.codePlanPresetModelId,
        ) ? 'codeplan' : 'apikey'
      );
    }
  }, [isEditing, account.baseUrl, account.headers, account.fallbackModels, account.fallbackAccountIds, account.model, account.modelCapabilities, account.apiProtocol, account.vendorId, typeInfo?.codePlanPresetBaseUrl, typeInfo?.codePlanPresetModelId]);

  const fallbackOptions = allProviders.filter((candidate) => candidate.account.id !== account.id);

  const toggleFallbackProvider = (providerId: string) => {
    setFallbackProviderIds((current) => (
      current.includes(providerId)
        ? current.filter((id) => id !== providerId)
        : [...current, providerId]
    ));
  };

  const handleSaveEdits = async () => {
    setSaving(true);
    setValidationError(null);
    try {
      const payload: { credentialHandle?: string; updates?: Partial<ProviderConfig> } = {};
      const normalizedFallbackModels = normalizeFallbackModels(fallbackModelsText.split('\n'));

      if (hasNewCredential) {
        const credentialHandle = await secretInputRef.current?.stage();
        if (!credentialHandle) throw new Error('Secure credential staging failed');
        setValidating(true);
        const result = await onValidateKey(credentialHandle, {
          baseUrl: baseUrl.trim() || undefined,
          apiProtocol: (account.vendorId === 'custom' || account.vendorId === 'ollama') ? apiProtocol : undefined,
          modelId: modelId.trim() || undefined,
        });
        setValidating(false);
        if (!result.valid) {
          setValidationError(result.error || t('aiProviders.toast.invalidKey'));
          setSaving(false);
          return;
        }
        payload.credentialHandle = credentialHandle;
      }

      {
        const updates: Partial<ProviderConfig> = {};
        if (typeInfo?.showBaseUrl && (baseUrl.trim() || undefined) !== (account.baseUrl || undefined)) {
          updates.baseUrl = baseUrl.trim() || undefined;
        }
        if ((account.vendorId === 'custom' || account.vendorId === 'ollama') && apiProtocol !== account.apiProtocol) {
          updates.apiProtocol = apiProtocol;
        }
        const existingUserAgent = getUserAgentHeader(account.headers).trim();
        const nextUserAgent = userAgent.trim();
        if (nextUserAgent !== existingUserAgent) {
          updates.headers = mergeHeadersWithUserAgent(account.headers, nextUserAgent);
        }
        if (!fallbackModelsEqual(normalizedFallbackModels, account.fallbackModels)) {
          updates.fallbackModels = normalizedFallbackModels;
        }
        if (!fallbackProviderIdsEqual(fallbackProviderIds, account.fallbackAccountIds)) {
          updates.fallbackProviderIds = normalizeFallbackProviderIds(fallbackProviderIds);
        }
        const previousCapabilities = resolveModelCapabilitiesDraft(account.modelCapabilities, account.model);
        const nextCapabilities = buildModelCapabilities(modelSupportsReasoning, modelSupportsImages);
        if (!modelCapabilitiesEqual(previousCapabilities, nextCapabilities)) {
          updates.modelCapabilities = nextCapabilities;
        }
        if (Object.keys(updates).length > 0) {
          payload.updates = updates;
        }
      }

      if (!payload.credentialHandle && !payload.updates) {
        onCancelEdit();
        setSaving(false);
        return;
      }

      await onSaveEdits(payload);
      secretInputRef.current?.clear();
      setHasNewCredential(false);
      toast.success(t('aiProviders.toast.updated'));
    } catch (error) {
      toast.error(`${t('aiProviders.toast.failedUpdate')}: ${error}`);
    } finally {
      setSaving(false);
      setValidating(false);
    }
  };

  const currentInputClasses = isDefault
    ? "h-[40px] rounded-xl font-mono text-meta bg-surface-modal border-black/10 dark:border-white/10 focus-visible:ring-2 focus-visible:ring-blue-500/50 shadow-sm"
    : inputClasses;

  const currentLabelClasses = isDefault ? "text-meta text-muted-foreground" : labelClasses;
  const currentSectionLabelClasses = isDefault ? "text-sm font-bold text-foreground/80" : labelClasses;

  return (
    <div
      data-testid={`provider-card-${account.id}`}
      className={cn(
        "group flex flex-col p-4 rounded-2xl transition-all relative overflow-hidden hover:bg-black/5 dark:hover:bg-white/5",
        isDefault
          ? "bg-black/[0.04] dark:bg-white/[0.06] border border-transparent"
          : "bg-transparent border border-transparent"
      )}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="h-[42px] w-[42px] shrink-0 flex items-center justify-center text-foreground border border-black/5 dark:border-white/10 rounded-full bg-black/5 dark:bg-white/5 shadow-sm group-hover:scale-105 transition-transform">
            {getProviderIconUrl(account.vendorId) ? (
              <img src={getProviderIconUrl(account.vendorId)} alt={typeInfo?.name || account.vendorId} className={cn('h-5 w-5', shouldInvertInDark(account.vendorId) && 'dark:invert')} />
            ) : (
              <span className="text-xl">{vendor?.icon || typeInfo?.icon || '⚙️'}</span>
            )}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-semibold text-sm">{account.label}</span>
              {isDefault && (
                <span className="flex items-center gap-1 font-mono text-2xs font-medium px-2 py-0.5 rounded-full bg-black/[0.04] dark:bg-white/[0.08] border-0 shadow-none text-foreground/70">
                  <Check className="h-3 w-3" />
                  {t('aiProviders.card.default')}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 mt-0.5 text-meta text-muted-foreground">
              <span className="capitalize">{vendor?.name || account.vendorId}</span>
              <span className="w-1 h-1 rounded-full bg-black/20 dark:bg-white/20" />
              <span>{getAuthModeLabel(account.authMode, t)}</span>
              {account.model && (
                <>
                  <span className="w-1 h-1 rounded-full bg-black/20 dark:bg-white/20" />
                  <span className="truncate max-w-[200px]">{account.model}</span>
                </>
              )}
              <span className="w-1 h-1 rounded-full bg-black/20 dark:bg-white/20" />
              <span className="flex items-center gap-1">
                {hasConfiguredCredentials(account, status) ? (
                  <><div className="w-1.5 h-1.5 rounded-full bg-green-500" /> {t('aiProviders.card.configured')}</>
                ) : (
                  <><div className="w-1.5 h-1.5 rounded-full bg-red-500" /> {t('aiProviders.dialog.apiKeyMissing')}</>
                )}
              </span>
              {((account.fallbackModels?.length ?? 0) > 0 || (account.fallbackAccountIds?.length ?? 0) > 0) && (
                <>
                  <span className="w-1 h-1 rounded-full bg-black/20 dark:bg-white/20" />
                  <span className="truncate max-w-[150px]" title={t('aiProviders.sections.fallback')}>
                    {t('aiProviders.sections.fallback')}: {[
                      ...normalizeFallbackModels(account.fallbackModels),
                      ...normalizeFallbackProviderIds(account.fallbackAccountIds)
                        .map((fallbackId) => allProviders.find((candidate) => candidate.account.id === fallbackId)?.account.label)
                        .filter(Boolean),
                    ].join(', ')}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

        {!isEditing && (
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            {!isDefault && (
            <Button
              data-testid={`provider-set-default-${account.id}`}
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-full text-muted-foreground hover:text-blue-600 hover:bg-surface-modal shadow-sm"
                onClick={onSetDefault}
                title={t('aiProviders.card.setDefault')}
              >
                <Check className="h-4 w-4" />
              </Button>
            )}
            <Button
              data-testid={`provider-edit-${account.id}`}
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-full text-muted-foreground hover:text-foreground hover:bg-surface-modal shadow-sm"
              onClick={onEdit}
              title={t('aiProviders.card.editKey')}
            >
              <Edit className="h-4 w-4" />
            </Button>
            <Button
              data-testid={`provider-delete-${account.id}`}
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-full text-muted-foreground hover:text-destructive hover:bg-surface-modal shadow-sm"
              onClick={onDelete}
              title={t('aiProviders.card.delete')}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div>

      <div
        data-testid={`provider-kernel-projections-${account.id}`}
        className="mt-3 flex flex-wrap gap-2 pl-[58px]"
      >
        {kernelIds.map(kernelId => {
          const supported = accountSupportsKernel(account, kernelId);
          const projection = account.projections?.find(item => item.kernelId === kernelId);
          const projectionStatus = supported ? (projection?.status ?? 'pending') : 'unsupported';
          const isKernelDefault = kernelDefaults.some(entry => (
            entry.kernelId === kernelId && entry.accountId === account.id
          ));
          const unhealthy = projectionStatus === 'failed' || projectionStatus === 'partial';
          return (
            <button
              type="button"
              key={kernelId}
              data-testid={`provider-kernel-${account.id}-${kernelId}`}
              disabled={!supported || isKernelDefault}
              onClick={() => void onSetKernelDefault(kernelId)}
              title={projection?.error || (
                isKernelDefault
                  ? t('aiProviders.kernels.currentDefault')
                  : t('aiProviders.kernels.setDefault')
              )}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-2xs transition-colors',
                !supported && 'cursor-not-allowed bg-black/5 text-foreground/35 dark:bg-white/5',
                supported && !unhealthy && 'bg-blue-500/10 text-blue-700 hover:bg-blue-500/15 dark:text-blue-400',
                unhealthy && 'bg-red-500/10 text-red-700 hover:bg-red-500/15 dark:text-red-400',
                isKernelDefault && 'ring-1 ring-current',
              )}
            >
              <span className={cn(
                'h-1.5 w-1.5 rounded-full bg-current',
                projectionStatus === 'applying' && 'animate-pulse',
              )} />
              {t(`aiProviders.kernels.${kernelId}.short`)}
              <span>·</span>
              <span>{t(`aiProviders.kernels.status.${projectionStatus}`)}</span>
              {isKernelDefault && (
                <>
                  <span>·</span>
                  <span>{t('aiProviders.kernels.default')}</span>
                </>
              )}
            </button>
          );
        })}
      </div>

      {isEditing && (
        <div className="space-y-6 mt-4 pt-4 border-t border-black/5 dark:border-white/5">
          {effectiveDocsUrl && (
            <div className="flex justify-end -mt-2 mb-2">
              <a
                href={effectiveDocsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-blue-500 hover:text-blue-600 font-medium inline-flex items-center gap-1"
              >
                {t('aiProviders.dialog.customDoc')}
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          )}
          {canEditModelConfig && (
            <div className="space-y-3">
              <p className={currentSectionLabelClasses}>{t('aiProviders.sections.model')}</p>
              {typeInfo?.showBaseUrl && (
                <div className="space-y-1.5">
                  <Label className={currentLabelClasses}>{t('aiProviders.dialog.baseUrl')}</Label>
                  <Input
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder={getProtocolBaseUrlPlaceholder(apiProtocol)}
                    className={currentInputClasses}
                  />
                </div>
              )}
              {showModelIdField && (
                <div className="space-y-1.5 pt-2">
                  <Label className={currentLabelClasses}>{t('aiProviders.dialog.modelId')}</Label>
                  <Input
                    data-testid={`provider-edit-model-id-${account.id}`}
                    value={modelId}
                    disabled
                    placeholder={typeInfo?.modelIdPlaceholder || 'provider/model-id'}
                    className={cn(currentInputClasses, 'cursor-not-allowed opacity-70')}
                  />
                  <p
                    data-testid={`provider-edit-model-id-help-${account.id}`}
                    className="text-xs text-muted-foreground"
                  >
                    {t('aiProviders.dialog.modelIdEditDisabled')}
                  </p>
                </div>
              )}
              {showModelIdField && (
                <div
                  data-testid={`provider-edit-model-capabilities-${account.id}`}
                  className="space-y-2 pt-2"
                >
                  <Label className={currentLabelClasses}>{t('aiProviders.dialog.modelCapabilities')}</Label>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <div className="flex items-center justify-between gap-3 rounded-lg border border-border/75 bg-surface-input/70 px-3 py-2 text-meta">
                      <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
                        <Brain className="h-4 w-4 shrink-0" />
                        <span className="truncate">{t('aiProviders.dialog.supportsThinking')}</span>
                      </span>
                      <Switch
                        data-testid={`provider-edit-supports-thinking-${account.id}`}
                        aria-label={t('aiProviders.dialog.supportsThinking')}
                        checked={modelSupportsReasoning}
                        onCheckedChange={setModelSupportsReasoning}
                      />
                    </div>
                    <div className="flex items-center justify-between gap-3 rounded-lg border border-border/75 bg-surface-input/70 px-3 py-2 text-meta">
                      <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
                        <ImageIcon className="h-4 w-4 shrink-0" />
                        <span className="truncate">{t('aiProviders.dialog.supportsImages')}</span>
                      </span>
                      <Switch
                        data-testid={`provider-edit-supports-images-${account.id}`}
                        aria-label={t('aiProviders.dialog.supportsImages')}
                        checked={modelSupportsImages}
                        onCheckedChange={setModelSupportsImages}
                      />
                    </div>
                  </div>
                </div>
              )}
              {codePlanPreset && (
                <div className="space-y-1.5 pt-2">
                  <div className="flex items-center justify-between gap-2">
                    <Label className={currentLabelClasses}>{t('aiProviders.dialog.codePlanPreset')}</Label>
                    {typeInfo?.codePlanDocsUrl && (
                      <a
                        href={typeInfo.codePlanDocsUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-blue-500 hover:text-blue-600 font-medium inline-flex items-center gap-1"
                      >
                        {t('aiProviders.dialog.codePlanDoc')}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </div>
                  <div className="flex gap-2 text-meta">
                    <button
                      type="button"
                      data-testid={`provider-edit-codeplan-apikey-${account.id}`}
                      disabled
                      onClick={() => {
                        setCodePlanMode('apikey');
                        setBaseUrl(typeInfo?.defaultBaseUrl || '');
                        if (modelId.trim() === codePlanPreset.modelId) {
                          setModelId(typeInfo?.defaultModelId || '');
                        }
                      }}
                      className={cn("flex-1 py-1.5 px-3 rounded-lg border transition-colors", codePlanMode === 'apikey' ? "bg-surface-modal border-black/20 dark:border-white/20 shadow-sm font-medium" : "border-transparent bg-black/5 dark:bg-white/5 text-muted-foreground hover:bg-black/10 dark:hover:bg-white/10")}
                    >
                      {t('aiProviders.authModes.apiKey')}
                    </button>
                    <button
                      type="button"
                      data-testid={`provider-edit-codeplan-mode-${account.id}`}
                      disabled
                      onClick={() => {
                        setCodePlanMode('codeplan');
                        setBaseUrl(codePlanPreset.baseUrl);
                        setModelId(codePlanPreset.modelId);
                      }}
                      className={cn("flex-1 py-1.5 px-3 rounded-lg border transition-colors", codePlanMode === 'codeplan' ? "bg-surface-modal border-black/20 dark:border-white/20 shadow-sm font-medium" : "border-transparent bg-black/5 dark:bg-white/5 text-muted-foreground hover:bg-black/10 dark:hover:bg-white/10")}
                    >
                      {t('aiProviders.dialog.codePlanMode')}
                    </button>
                  </div>
                  {codePlanMode === 'codeplan' && (
                    <p className="text-xs text-muted-foreground">
                      {t('aiProviders.dialog.codePlanPresetDesc', {
                        baseUrl: codePlanPreset.baseUrl,
                        modelId: codePlanPreset.modelId,
                      })}
                    </p>
                  )}
                </div>
              )}
              {account.vendorId === 'custom' && (
                <div className="space-y-1.5 pt-2">
                  <Label className={currentLabelClasses}>{t('aiProviders.dialog.protocol', 'Protocol')}</Label>
                  <div className="flex gap-2 text-meta">
                    <button
                      type="button"
                      onClick={() => setApiProtocol('openai-completions')}
                      className={cn("flex-1 py-1.5 px-3 rounded-lg border transition-colors", apiProtocol === 'openai-completions' ? "bg-surface-modal border-black/20 dark:border-white/20 shadow-sm font-medium" : "border-transparent bg-black/5 dark:bg-white/5 text-muted-foreground hover:bg-black/10 dark:hover:bg-white/10")}
                    >
                      {t('aiProviders.protocols.openaiCompletions', 'OpenAI Completions')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setApiProtocol('openai-responses')}
                      className={cn("flex-1 py-1.5 px-3 rounded-lg border transition-colors", apiProtocol === 'openai-responses' ? "bg-surface-modal border-black/20 dark:border-white/20 shadow-sm font-medium" : "border-transparent bg-black/5 dark:bg-white/5 text-muted-foreground hover:bg-black/10 dark:hover:bg-white/10")}
                    >
                      {t('aiProviders.protocols.openaiResponses', 'OpenAI Responses')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setApiProtocol('anthropic-messages')}
                      className={cn("flex-1 py-1.5 px-3 rounded-lg border transition-colors", apiProtocol === 'anthropic-messages' ? "bg-surface-modal border-black/20 dark:border-white/20 shadow-sm font-medium" : "border-transparent bg-black/5 dark:bg-white/5 text-muted-foreground hover:bg-black/10 dark:hover:bg-white/10")}
                    >
                      {t('aiProviders.protocols.anthropic', 'Anthropic')}
                    </button>
                  </div>
                </div>
              )}
              {showUserAgentField && (
                <div className="space-y-1.5 pt-2">
                  <Label className={currentLabelClasses}>{t('aiProviders.dialog.userAgent')}</Label>
                  <Input
                    value={userAgent}
                    onChange={(e) => setUserAgent(e.target.value)}
                    placeholder={t('aiProviders.dialog.userAgentPlaceholder')}
                    className={currentInputClasses}
                  />
                </div>
              )}
            </div>
          )}
          <div className="space-y-3">
            <button
              onClick={() => setShowFallback(!showFallback)}
              className="flex items-center justify-between w-full text-sm font-bold text-foreground/80 hover:text-foreground transition-colors"
            >
              <span>{t('aiProviders.sections.fallback')}</span>
              <ChevronDown className={cn("h-4 w-4 transition-transform", showFallback && "rotate-180")} />
            </button>
            {showFallback && (
              <div className="space-y-3 pt-2">
                <div className="space-y-1.5">
                  <Label className={currentLabelClasses}>{t('aiProviders.dialog.fallbackModelIds')}</Label>
                  <textarea
                    value={fallbackModelsText}
                    onChange={(e) => setFallbackModelsText(e.target.value)}
                    placeholder={t('aiProviders.dialog.fallbackModelIdsPlaceholder')}
                    className={isDefault
                      ? "min-h-24 w-full rounded-xl border border-black/10 dark:border-white/10 bg-surface-modal px-3 py-2 text-meta font-mono outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50 shadow-sm"
                      : "min-h-24 w-full rounded-xl border border-black/10 dark:border-white/10 bg-transparent px-3 py-2 text-meta font-mono outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50 focus-visible:border-blue-500 shadow-sm transition-all text-foreground placeholder:text-foreground/40"}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t('aiProviders.dialog.fallbackModelIdsHelp')}
                  </p>
                </div>
                <div className="space-y-2 pt-1">
                  <Label className={currentLabelClasses}>{t('aiProviders.dialog.fallbackProviders')}</Label>
                  {fallbackOptions.length === 0 ? (
                    <p className="text-meta text-muted-foreground">{t('aiProviders.dialog.noFallbackOptions')}</p>
                  ) : (
                    <div className={cn("space-y-2 rounded-xl border border-black/10 dark:border-white/10 p-3 shadow-sm", isDefault ? "bg-surface-modal" : "bg-transparent")}>
                      {fallbackOptions.map((candidate) => (
                        <label key={candidate.account.id} className="flex items-center gap-3 text-meta cursor-pointer group/label">
                          <input
                            type="checkbox"
                            checked={fallbackProviderIds.includes(candidate.account.id)}
                            onChange={() => toggleFallbackProvider(candidate.account.id)}
                            className="rounded border-black/20 dark:border-white/20 text-blue-500 focus:ring-blue-500/50"
                          />
                          <span className="font-medium group-hover/label:text-blue-500 transition-colors">{candidate.account.label}</span>
                          <span className="text-xs text-muted-foreground">
                            {candidate.account.model || candidate.vendor?.name || candidate.account.vendorId}
                          </span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="space-y-0.5">
                <Label className={currentSectionLabelClasses}>{t('aiProviders.dialog.apiKey')}</Label>
                <p className="text-xs text-muted-foreground">
                  {hasConfiguredCredentials(account, status)
                    ? t('aiProviders.dialog.apiKeyConfigured')
                    : t('aiProviders.dialog.apiKeyMissing')}
                </p>
              </div>
              {hasConfiguredCredentials(account, status) ? (
                <div className="flex items-center gap-1.5 text-tiny font-medium text-green-600 dark:text-green-500 bg-green-500/10 px-2 py-1 rounded-md">
                  <div className="w-1.5 h-1.5 rounded-full bg-current" />
                  {t('aiProviders.card.configured')}
                </div>
              ) : null}
            </div>
            {typeInfo?.apiKeyUrl && (
              <div className="flex justify-start">
                <a
                  href={typeInfo.apiKeyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-meta text-blue-500 hover:text-blue-600 hover:underline flex items-center gap-1"
                  tabIndex={-1}
                >
                  {t('aiProviders.oauth.getApiKey')} <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            )}
            <div className="space-y-1.5 pt-1">
              <Label className={currentLabelClasses}>{t('aiProviders.dialog.replaceApiKey')}</Label>
              <div className="flex gap-2">
                <div className="flex-1">
                  <SecureSecretInput
                    ref={secretInputRef}
                    data-testid={`provider-edit-key-input-${account.id}`}
                    aria-label={t('aiProviders.dialog.replaceApiKey')}
                    placeholder={typeInfo?.requiresApiKey ? typeInfo?.placeholder : (typeInfo?.id === 'ollama' ? t('aiProviders.notRequired') : t('aiProviders.card.editKey'))}
                    onPresenceChange={(present) => {
                      setHasNewCredential(present);
                      setValidationError(null);
                    }}
                    className={currentInputClasses}
                  />
                </div>
                <Button
                  data-testid={`provider-edit-save-${account.id}`}
                  variant="outline"
                  onClick={handleSaveEdits}
                  className={cn(
                    "rounded-xl px-4 border-black/10 dark:border-white/10",
                    isDefault
                      ? "h-[40px] bg-surface-modal hover:bg-black/5 dark:hover:bg-white/10"
                      : "h-[44px] bg-transparent hover:bg-black/5 dark:hover:bg-white/10 shadow-sm"
                  )}
                  disabled={
                    validating
                    || saving
                    || (
                      !hasNewCredential
                      && (baseUrl.trim() || undefined) === (account.baseUrl || undefined)
                      && apiProtocol === (account.apiProtocol || 'openai-completions')
                      && userAgent.trim() === getUserAgentHeader(account.headers).trim()
                      && fallbackModelsEqual(normalizeFallbackModels(fallbackModelsText.split('\n')), account.fallbackModels)
                      && fallbackProviderIdsEqual(fallbackProviderIds, account.fallbackAccountIds)
                      && modelCapabilitiesEqual(
                        resolveModelCapabilitiesDraft(account.modelCapabilities, account.model),
                        buildModelCapabilities(modelSupportsReasoning, modelSupportsImages),
                      )
                    )
                  }
                >
                  {validating || saving ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Check className="h-4 w-4 text-green-500" />
                  )}
                </Button>
                <Button
                  data-testid={`provider-edit-cancel-${account.id}`}
                  variant="ghost"
                  onClick={onCancelEdit}
                  className={cn(
                    "p-0 rounded-xl",
                    isDefault
                      ? "h-[40px] w-[40px] hover:bg-black/5 dark:hover:bg-white/10"
                      : "h-[44px] w-[44px] bg-transparent border border-black/10 dark:border-white/10 hover:bg-black/5 dark:hover:bg-white/10 shadow-sm text-muted-foreground hover:text-foreground"
                  )}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
              {validationError && (
                <p
                  data-testid={`provider-edit-validation-error-${account.id}`}
                  className="text-xs text-red-500 flex items-center gap-1 mt-1"
                >
                  <XCircle className="h-3 w-3 shrink-0" />
                  <span className="font-medium">{t('aiProviders.dialog.failed')}:</span>
                  <span>{validationError}</span>
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                {t('aiProviders.dialog.replaceApiKeyHelp')}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface AddProviderDialogProps {
  kernelIds: string[];
  open: boolean;
  existingVendorIds: Set<string>;
  vendors: ProviderVendorInfo[];
  onClose: () => void;
  onAdd: (
    type: ProviderType,
    name: string,
    credentialHandle: string | undefined,
    options?: {
      baseUrl?: string;
      model?: string;
      authMode?: ProviderAccount['authMode'];
      apiProtocol?: ProviderAccount['apiProtocol'];
      headers?: Record<string, string>;
      modelCapabilities?: ProviderAccount['modelCapabilities'];
    }
  ) => Promise<void>;
  onValidateKey: (
    type: string,
    credentialHandle: string,
    kernelIds: string[],
    options?: { baseUrl?: string; apiProtocol?: ProviderAccount['apiProtocol']; modelId?: string }
  ) => Promise<{ valid: boolean; error?: string }>;
  devModeUnlocked: boolean;
}

function AddProviderDialog({
  kernelIds,
  open,
  existingVendorIds,
  vendors,
  onClose,
  onAdd,
  onValidateKey,
  devModeUnlocked,
}: AddProviderDialogProps) {
  const { t, i18n } = useTranslation('settings');
  const [selectedType, setSelectedType] = useState<ProviderType | null>(null);
  const [name, setName] = useState('');
  const secretInputRef = React.useRef<SecureSecretInputHandle>(null);
  const [hasCredential, setHasCredential] = useState(false);
  const [baseUrl, setBaseUrl] = useState('');
  const [modelId, setModelId] = useState('');
  const [modelSupportsReasoning, setModelSupportsReasoning] = useState(false);
  const [modelSupportsImages, setModelSupportsImages] = useState(false);
  const [modelCapabilitiesTouched, setModelCapabilitiesTouched] = useState(false);
  const [apiProtocol, setApiProtocol] = useState<ProviderAccount['apiProtocol']>('openai-completions');
  const [showAdvancedConfig, setShowAdvancedConfig] = useState(false);
  const [userAgent, setUserAgent] = useState('');
  const [codePlanMode, setCodePlanMode] = useState<CodePlanMode>('apikey');
  const [saving, setSaving] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  // OAuth Flow State
  const [oauthFlowing, setOauthFlowing] = useState(false);
  const [oauthData, setOauthData] = useState<{
    mode: 'device';
    verificationUri: string;
    userCode: string;
    expiresIn: number;
  } | {
    mode: 'manual';
    authorizationUrl: string;
    message?: string;
  } | null>(null);
  const [manualCodeInput, setManualCodeInput] = useState('');
  const [oauthError, setOauthError] = useState<string | null>(null);
  // For providers that support both OAuth and API key, let the user choose.
  // Default to the vendor's declared auth mode instead of hard-coding OAuth.
  const [authMode, setAuthMode] = useState<'oauth' | 'apikey'>('apikey');
  const [prevOpen, setPrevOpen] = useState(open);
  const pendingOAuthRef = React.useRef<{ accountId: string; label: string } | null>(null);

  if (prevOpen !== open) {
    setPrevOpen(open);
    if (open) {
      setSelectedType(null);
      setName('');
      secretInputRef.current?.clear();
      setHasCredential(false);
      setBaseUrl('');
      setModelId('');
      setModelSupportsReasoning(false);
      setModelSupportsImages(false);
      setModelCapabilitiesTouched(false);
      setApiProtocol('openai-completions');
      setShowAdvancedConfig(false);
      setUserAgent('');
      setCodePlanMode('apikey');
      setSaving(false);
      setValidationError(null);
      setOauthFlowing(false);
      setOauthData(null);
      setManualCodeInput('');
      setOauthError(null);
      setAuthMode('apikey');
      pendingOAuthRef.current = null;
    }
  }

  const typeInfo = PROVIDER_TYPE_INFO.find((t) => t.id === selectedType);
  const providerDocsUrl = getProviderDocsUrl(typeInfo, i18n.language);
  const showModelIdField = shouldShowProviderModelId(typeInfo, devModeUnlocked);
  const codePlanPreset = typeInfo?.codePlanPresetBaseUrl && typeInfo?.codePlanPresetModelId
    ? {
      baseUrl: typeInfo.codePlanPresetBaseUrl,
      modelId: typeInfo.codePlanPresetModelId,
    }
    : null;
  const effectiveDocsUrl = codePlanMode === 'codeplan'
    ? (typeInfo?.codePlanDocsUrl || providerDocsUrl)
    : providerDocsUrl;
  const isOAuth = typeInfo?.isOAuth ?? false;
  const supportsApiKey = typeInfo?.supportsApiKey ?? false;
  const oauthUiHidden = typeInfo?.hideOAuthUi ?? false;
  const vendorMap = new Map(vendors.map((vendor) => [vendor.id, vendor]));
  const selectedVendor = selectedType ? vendorMap.get(selectedType) : undefined;
  const showUserAgentInAddDialog = shouldShowUserAgentFieldForNewProvider(selectedType);
  const preferredOAuthMode = selectedVendor?.supportedAuthModes.includes('oauth_browser')
    ? 'oauth_browser'
    : (selectedVendor?.supportedAuthModes.includes('oauth_device')
      ? 'oauth_device'
      : null);
  // Effective OAuth mode: pure OAuth providers, or dual-mode with oauth selected
  const useOAuthFlow = isOAuth && !oauthUiHidden && (!supportsApiKey || authMode === 'oauth');

  useEffect(() => {
    if (!selectedVendor || !isOAuth || !supportsApiKey) {
      return;
    }
    if (oauthUiHidden) {
      setAuthMode('apikey');
      return;
    }
    setAuthMode(selectedVendor.defaultAuthMode === 'api_key' ? 'apikey' : 'oauth');
  }, [selectedVendor, isOAuth, supportsApiKey, oauthUiHidden]);

  useEffect(() => {
    if (!typeInfo?.codePlanPresetBaseUrl || !typeInfo?.codePlanPresetModelId) {
      setCodePlanMode('apikey');
      return;
    }
    setCodePlanMode(
      isCodePlanMode(
        baseUrl,
        modelId,
        typeInfo.codePlanPresetBaseUrl,
        typeInfo.codePlanPresetModelId,
      ) ? 'codeplan' : 'apikey'
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedType]);

  // Keep refs to the latest values so event handlers see the current dialog state.
  const latestRef = React.useRef({ selectedType, typeInfo, onAdd, onClose, t });
  useEffect(() => {
    latestRef.current = { selectedType, typeInfo, onAdd, onClose, t };
  });

  // Manage OAuth events
  useEffect(() => {
    if (!open) {
      return;
    }

    const handleCode = (payload: OAuthCodeEvent) => {
      if ('mode' in payload && payload.mode === 'manual') {
        setOauthData({
          mode: 'manual',
          authorizationUrl: payload.authorizationUrl,
          message: payload.message,
        });
      } else {
        setOauthData({
          mode: 'device',
          verificationUri: payload.verificationUri,
          userCode: payload.userCode,
          expiresIn: payload.expiresIn,
        });
      }
      setOauthError(null);
    };

    const handleSuccess = async (payload: OAuthSuccessEvent) => {
      setOauthFlowing(false);
      setOauthData(null);
      setManualCodeInput('');
      setValidationError(null);

      const { onClose: close, t: translate } = latestRef.current;
      const accountId = payload?.accountId || pendingOAuthRef.current?.accountId;

      // device-oauth.ts already saved the provider config to the backend,
      // including the dynamically resolved baseUrl for the region (e.g. CN vs Global).
      // If we call add() here with undefined baseUrl, it will overwrite and erase it!
      // So we just fetch the latest list from the backend to update the UI.
      try {
        const store = useProviderStore.getState();
        await store.refreshProviderSnapshot();

        // OAuth sign-in should immediately become active default to avoid
        // leaving runtime on an API-key-only provider/model.
        if (accountId) {
          await store.setDefaultAccount(accountId);
        }
      } catch (err) {
        console.error('Failed to refresh providers after OAuth:', err);
      }

      pendingOAuthRef.current = null;
      close();
      toast.success(translate('aiProviders.toast.added'));
    };

    const handleError = (data: OAuthErrorEvent) => {
      setOauthError(data.message);
      setOauthData(null);
      pendingOAuthRef.current = null;
    };

    const offCode = hostEvents.onOAuthCode(handleCode);
    const offSuccess = hostEvents.onOAuthSuccess(handleSuccess);
    const offError = hostEvents.onOAuthError(handleError);

    return () => {
      offCode();
      offSuccess();
      offError();
    };
  }, [open]);

  const handleStartOAuth = async () => {
    if (!selectedType) return;

    const hasMinimax = existingVendorIds.has('minimax-portal') || existingVendorIds.has('minimax-portal-cn');
    if ((selectedType === 'minimax-portal' || selectedType === 'minimax-portal-cn') && hasMinimax) {
      toast.error(t('aiProviders.toast.minimaxConflict'));
      return;
    }
    const hasZai = existingVendorIds.has('zai') || existingVendorIds.has('zai-global');
    if (isZaiProviderType(selectedType) && hasZai) {
      toast.error(t('aiProviders.toast.zaiConflict'));
      return;
    }

    setOauthFlowing(true);
    setOauthData(null);
    setManualCodeInput('');
    setOauthError(null);

    try {
      const vendor = vendorMap.get(selectedType);
      const supportsMultipleAccounts = vendor?.supportsMultipleAccounts ?? selectedType === 'custom';
      const accountId = supportsMultipleAccounts ? `${selectedType}-${crypto.randomUUID()}` : selectedType;
      const label = name || (typeInfo?.id === 'custom' ? t('aiProviders.custom') : typeInfo?.name) || selectedType;
      pendingOAuthRef.current = { accountId, label };
      await hostApi.providers.requestOAuth({
        ['provider']: selectedType,
        accountId,
        label,
      });
    } catch (e) {
      setOauthError(String(e));
      setOauthFlowing(false);
      pendingOAuthRef.current = null;
    }
  };

  const handleCancelOAuth = async () => {
    setOauthFlowing(false);
    setOauthData(null);
    setManualCodeInput('');
    setOauthError(null);
    pendingOAuthRef.current = null;
    await hostApi.providers.cancelOAuth();
  };

  const handleSubmitManualOAuthCode = async () => {
    const value = manualCodeInput.trim();
    if (!value) return;
    try {
      await hostApi.providers.submitOAuth({ code: value });
      setOauthError(null);
    } catch (error) {
      setOauthError(String(error));
    }
  };

  const availableTypes = PROVIDER_TYPE_INFO.filter((type) => {
    // Skip providers that are temporarily hidden from the UI.
    if (type.hidden) return false;

    // MiniMax portal variants are mutually exclusive — hide BOTH variants
    // when either one already exists (account may have vendorId of either variant).
    const hasMinimax = existingVendorIds.has('minimax-portal') || existingVendorIds.has('minimax-portal-cn');
    if ((type.id === 'minimax-portal' || type.id === 'minimax-portal-cn') && hasMinimax) return false;

    // Z.AI CN/Global both map to OpenClaw key `zai` — mutually exclusive in the UI.
    const hasZai = existingVendorIds.has('zai') || existingVendorIds.has('zai-global');
    if (isZaiProviderType(type.id) && hasZai) return false;

    const vendor = vendorMap.get(type.id);
    if (!vendor) {
      return !existingVendorIds.has(type.id) || type.id === 'custom';
    }
    return vendor.supportsMultipleAccounts || !existingVendorIds.has(type.id);
  });

  const handleAdd = async () => {
    if (!selectedType) return;

    const hasMinimax = existingVendorIds.has('minimax-portal') || existingVendorIds.has('minimax-portal-cn');
    if ((selectedType === 'minimax-portal' || selectedType === 'minimax-portal-cn') && hasMinimax) {
      toast.error(t('aiProviders.toast.minimaxConflict'));
      return;
    }
    const hasZai = existingVendorIds.has('zai') || existingVendorIds.has('zai-global');
    if (isZaiProviderType(selectedType) && hasZai) {
      toast.error(t('aiProviders.toast.zaiConflict'));
      return;
    }

    setSaving(true);
    setValidationError(null);

    try {
      // The isolated field stages directly to Main. React only receives this
      // short-lived opaque handle and can reuse it for validation + save.
      const requiresKey = typeInfo?.requiresApiKey ?? false;
      if (requiresKey && !hasCredential) {
        setValidationError(t('aiProviders.toast.invalidKey')); // reusing invalid key msg or should add 'required' msg? null checks
        setSaving(false);
        return;
      }
      const credentialHandle = hasCredential
        ? await secretInputRef.current?.stage() ?? undefined
        : undefined;
      if (hasCredential && !credentialHandle) throw new Error('Secure credential staging failed');
      if (credentialHandle) {
        const result = await onValidateKey(selectedType, credentialHandle, kernelIds, {
          baseUrl: baseUrl.trim() || undefined,
          apiProtocol: (selectedType === 'custom' || selectedType === 'ollama') ? apiProtocol : undefined,
          modelId: modelId.trim() || undefined,
        });
        if (!result.valid) {
          setValidationError(result.error || t('aiProviders.toast.invalidKey'));
          setSaving(false);
          return;
        }
      }

      const requiresModel = showModelIdField;
      if (requiresModel && !modelId.trim()) {
        setValidationError(t('aiProviders.toast.modelRequired'));
        setSaving(false);
        return;
      }

      await onAdd(
        selectedType,
        name || (typeInfo?.id === 'custom' ? t('aiProviders.custom') : typeInfo?.name) || selectedType,
        credentialHandle,
        {
          baseUrl: baseUrl.trim() || undefined,
          apiProtocol: (selectedType === 'custom' || selectedType === 'ollama') ? apiProtocol : undefined,
          headers: userAgent.trim() ? { 'User-Agent': userAgent.trim() } : undefined,
          model: resolveProviderModelForSave(typeInfo, modelId, devModeUnlocked),
          modelCapabilities: buildModelCapabilities(modelSupportsReasoning, modelSupportsImages),
          authMode: useOAuthFlow ? (preferredOAuthMode || 'oauth_device') : selectedType === 'ollama'
            ? 'local'
            : (isOAuth && supportsApiKey && authMode === 'apikey')
              ? 'api_key'
              : vendorMap.get(selectedType)?.defaultAuthMode || 'api_key',
        }
      );
    } catch {
      // error already handled via toast in parent
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent asChild className="w-[calc(100%-2rem)] max-w-2xl max-h-[90vh] flex flex-col rounded-3xl border-0 shadow-2xl bg-surface-modal overflow-hidden">
        <Card data-testid="add-provider-dialog">
        <CardHeader className="relative pb-2 shrink-0">
          <DialogTitle asChild>
            <CardTitle className="text-2xl font-serif font-normal">{t('aiProviders.dialog.title')}</CardTitle>
          </DialogTitle>
          <DialogDescription asChild>
            <CardDescription className="text-sm mt-1 text-foreground/70">
              {t('aiProviders.dialog.desc')}
            </CardDescription>
          </DialogDescription>
          <Button
            data-testid="add-provider-close-button"
            variant="ghost"
            size="icon"
            className="absolute right-4 top-4 rounded-full h-8 w-8 -mr-2 -mt-2 text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </Button>
        </CardHeader>
        <CardContent className="overflow-y-auto flex-1 p-6">
          {!selectedType ? (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {availableTypes.map((type) => (
                <button
                  data-testid={`add-provider-type-${type.id}`}
                  key={type.id}
                  onClick={() => {
                    setSelectedType(type.id);
                    setName(type.id === 'custom' ? t('aiProviders.custom') : type.name);
                    setBaseUrl(type.defaultBaseUrl || '');
                    setModelId(type.defaultModelId || '');
                    setModelSupportsReasoning(false);
                    setModelSupportsImages(inferModelImageInput(type.defaultModelId));
                    setModelCapabilitiesTouched(false);
                    setUserAgent('');
                    setShowAdvancedConfig(false);
                    setCodePlanMode('apikey');
                  }}
                  className="p-4 rounded-2xl border border-black/5 dark:border-white/5 hover:bg-black/5 dark:hover:bg-white/5 transition-colors text-center group"
                >
                  <div className="h-12 w-12 mx-auto mb-3 flex items-center justify-center bg-black/5 dark:bg-white/5 rounded-xl shadow-sm border border-black/5 dark:border-white/5 group-hover:scale-105 transition-transform">
                    {getProviderIconUrl(type.id) ? (
                      <img src={getProviderIconUrl(type.id)} alt={type.name} className={cn('h-6 w-6', shouldInvertInDark(type.id) && 'dark:invert')} />
                    ) : (
                      <span className="text-2xl">{type.icon}</span>
                    )}
                  </div>
                  <p className="font-medium text-meta">{type.id === 'custom' ? t('aiProviders.custom') : type.name}</p>
                </button>
              ))}
            </div>
          ) : (
            <div className="space-y-6">
              <div className="flex items-center gap-3 p-4 rounded-2xl bg-transparent border border-black/5 dark:border-white/5 shadow-sm">
                <div className="h-10 w-10 shrink-0 flex items-center justify-center bg-black/5 dark:bg-white/5 rounded-xl">
                  {getProviderIconUrl(selectedType!) ? (
                    <img src={getProviderIconUrl(selectedType!)} alt={typeInfo?.name} className={cn('h-6 w-6', shouldInvertInDark(selectedType!) && 'dark:invert')} />
                  ) : (
                    <span className="text-xl">{typeInfo?.icon}</span>
                  )}
                </div>
                <div>
                  <p className="font-semibold text-sm">{typeInfo?.id === 'custom' ? t('aiProviders.custom') : typeInfo?.name}</p>
                  <button
                  data-testid="add-provider-change-type"
                  onClick={() => {
                    setSelectedType(null);
                    setValidationError(null);
                    setBaseUrl('');
                    setModelId('');
                    setModelSupportsReasoning(false);
                    setModelSupportsImages(false);
                    setModelCapabilitiesTouched(false);
                    setUserAgent('');
                    setShowAdvancedConfig(false);
                    setCodePlanMode('apikey');
                  }}
                  className="text-meta text-blue-500 hover:text-blue-600 font-medium"
                >
                    {t('aiProviders.dialog.change')}
                  </button>
                  {effectiveDocsUrl && (
                    <>
                      <span className="mx-2 text-foreground/20">|</span>
                      <a
                        href={effectiveDocsUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-meta text-blue-500 hover:text-blue-600 font-medium inline-flex items-center gap-1"
                      >
                        {t('aiProviders.dialog.customDoc')}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </>
                  )}
                </div>
              </div>

              <div className="space-y-6 bg-transparent p-0">
                <div className="space-y-2.5">
                  <Label htmlFor="name" className={labelClasses}>{t('aiProviders.dialog.displayName')}</Label>
                  <Input
                    data-testid="add-provider-name-input"
                    id="name"
                    placeholder={typeInfo?.id === 'custom' ? t('aiProviders.custom') : typeInfo?.name}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className={inputClasses}
                  />
                </div>

                {/* Auth mode toggle for providers supporting both */}
                {isOAuth && supportsApiKey && !oauthUiHidden && (
                  <div className="flex rounded-xl border border-black/10 dark:border-white/10 overflow-hidden text-meta font-medium shadow-sm bg-transparent p-1 gap-1">
                    <button
                      data-testid="add-provider-auth-oauth-tab"
                      onClick={() => setAuthMode('oauth')}
                      className={cn(
                        'flex-1 py-2 px-3 rounded-lg transition-colors',
                        authMode === 'oauth' ? 'bg-black/5 dark:bg-white/10 text-foreground' : 'text-muted-foreground hover:bg-black/5 dark:hover:bg-white/5'
                      )}
                    >
                      {t('aiProviders.oauth.loginMode')}
                    </button>
                    <button
                      data-testid="add-provider-auth-apikey-tab"
                      onClick={() => setAuthMode('apikey')}
                      className={cn(
                        'flex-1 py-2 px-3 rounded-lg transition-colors',
                        authMode === 'apikey' ? 'bg-black/5 dark:bg-white/10 text-foreground' : 'text-muted-foreground hover:bg-black/5 dark:hover:bg-white/5'
                      )}
                    >
                      {t('aiProviders.oauth.apikeyMode')}
                    </button>
                  </div>
                )}

                {/* API Key input — shown for non-OAuth providers or when apikey mode is selected */}
                {(!isOAuth || (supportsApiKey && authMode === 'apikey')) && (
                  <div className="space-y-2.5">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="apiKey" className={labelClasses}>{t('aiProviders.dialog.apiKey')}</Label>
                      {typeInfo?.apiKeyUrl && (
                        <a
                          href={typeInfo.apiKeyUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-meta text-blue-500 hover:text-blue-600 font-medium flex items-center gap-1"
                          tabIndex={-1}
                        >
                          {t('aiProviders.oauth.getApiKey')} <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </div>
                    <SecureSecretInput
                      ref={secretInputRef}
                      data-testid="add-provider-api-key-input"
                      aria-label={t('aiProviders.dialog.apiKey')}
                      placeholder={typeInfo?.id === 'ollama' ? t('aiProviders.notRequired') : typeInfo?.placeholder}
                      onPresenceChange={(present) => {
                        setHasCredential(present);
                        setValidationError(null);
                      }}
                      className={inputClasses}
                    />
                    {validationError && (
                      <p className="text-meta text-red-500 font-medium">{validationError}</p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      {t('aiProviders.dialog.apiKeyStored')}
                    </p>
                  </div>
                )}

                {typeInfo?.showBaseUrl && (
                  <div className="space-y-2.5">
                    <Label htmlFor="baseUrl" className={labelClasses}>{t('aiProviders.dialog.baseUrl')}</Label>
                    <Input
                      data-testid="add-provider-base-url-input"
                      id="baseUrl"
                      placeholder={getProtocolBaseUrlPlaceholder(apiProtocol)}
                      value={baseUrl}
                      onChange={(e) => setBaseUrl(e.target.value)}
                      className={inputClasses}
                    />
                  </div>
                )}

                {showModelIdField && (
                  <div className="space-y-2.5">
                    <Label htmlFor="modelId" className={labelClasses}>{t('aiProviders.dialog.modelId')}</Label>
                    <Input
                      data-testid="add-provider-model-id-input"
                      id="modelId"
                      placeholder={typeInfo?.modelIdPlaceholder || 'provider/model-id'}
                      value={modelId}
                      onChange={(e) => {
                        const nextModelId = e.target.value;
                        setModelId(nextModelId);
                        if (!modelCapabilitiesTouched) {
                          setModelSupportsImages(inferModelImageInput(nextModelId));
                        }
                        setValidationError(null);
                      }}
                      className={inputClasses}
                    />
                  </div>
                )}
                {showModelIdField && (
                  <div data-testid="add-provider-model-capabilities" className="space-y-2.5">
                    <Label className={labelClasses}>{t('aiProviders.dialog.modelCapabilities')}</Label>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <div className="flex items-center justify-between gap-3 rounded-lg border border-border/75 bg-surface-input/70 px-3 py-2 text-meta">
                        <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
                          <Brain className="h-4 w-4 shrink-0" />
                          <span className="truncate">{t('aiProviders.dialog.supportsThinking')}</span>
                        </span>
                        <Switch
                          data-testid="add-provider-supports-thinking"
                          aria-label={t('aiProviders.dialog.supportsThinking')}
                          checked={modelSupportsReasoning}
                          onCheckedChange={(checked) => {
                            setModelSupportsReasoning(checked);
                            setModelCapabilitiesTouched(true);
                          }}
                        />
                      </div>
                      <div className="flex items-center justify-between gap-3 rounded-lg border border-border/75 bg-surface-input/70 px-3 py-2 text-meta">
                        <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
                          <ImageIcon className="h-4 w-4 shrink-0" />
                          <span className="truncate">{t('aiProviders.dialog.supportsImages')}</span>
                        </span>
                        <Switch
                          data-testid="add-provider-supports-images"
                          aria-label={t('aiProviders.dialog.supportsImages')}
                          checked={modelSupportsImages}
                          onCheckedChange={(checked) => {
                            setModelSupportsImages(checked);
                            setModelCapabilitiesTouched(true);
                          }}
                        />
                      </div>
                    </div>
                  </div>
                )}
                {codePlanPreset && (
                  <div className="space-y-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <Label className={labelClasses}>{t('aiProviders.dialog.codePlanPreset')}</Label>
                      {typeInfo?.codePlanDocsUrl && (
                        <a
                          href={typeInfo.codePlanDocsUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-meta text-blue-500 hover:text-blue-600 font-medium inline-flex items-center gap-1"
                          tabIndex={-1}
                        >
                          {t('aiProviders.dialog.codePlanDoc')}
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </div>
                    <div className="flex gap-2 text-meta">
                      <button
                        type="button"
                        data-testid="add-provider-codeplan-apikey-tab"
                        onClick={() => {
                          setCodePlanMode('apikey');
                          setBaseUrl(typeInfo?.defaultBaseUrl || '');
                          if (modelId.trim() === codePlanPreset.modelId) {
                            const nextModelId = typeInfo?.defaultModelId || '';
                            setModelId(nextModelId);
                            if (!modelCapabilitiesTouched) {
                              setModelSupportsImages(inferModelImageInput(nextModelId));
                            }
                          }
                          setValidationError(null);
                        }}
                        className={cn("flex-1 py-1.5 px-3 rounded-lg border transition-colors", codePlanMode === 'apikey' ? "bg-surface-modal border-black/20 dark:border-white/20 shadow-sm font-medium" : "border-transparent bg-black/5 dark:bg-white/5 text-muted-foreground hover:bg-black/10 dark:hover:bg-white/10")}
                      >
                        {t('aiProviders.authModes.apiKey')}
                      </button>
                      <button
                        type="button"
                        data-testid="add-provider-codeplan-mode-tab"
                        onClick={() => {
                          setCodePlanMode('codeplan');
                          setBaseUrl(codePlanPreset.baseUrl);
                          setModelId(codePlanPreset.modelId);
                          if (!modelCapabilitiesTouched) {
                            setModelSupportsImages(inferModelImageInput(codePlanPreset.modelId));
                          }
                          setValidationError(null);
                        }}
                        className={cn("flex-1 py-1.5 px-3 rounded-lg border transition-colors", codePlanMode === 'codeplan' ? "bg-surface-modal border-black/20 dark:border-white/20 shadow-sm font-medium" : "border-transparent bg-black/5 dark:bg-white/5 text-muted-foreground hover:bg-black/10 dark:hover:bg-white/10")}
                      >
                        {t('aiProviders.dialog.codePlanMode')}
                      </button>
                    </div>
                    {codePlanMode === 'codeplan' && (
                      <p className="text-xs text-muted-foreground">
                        {t('aiProviders.dialog.codePlanPresetDesc', {
                          baseUrl: codePlanPreset.baseUrl,
                          modelId: codePlanPreset.modelId,
                        })}
                      </p>
                    )}
                  </div>
                )}
                {selectedType === 'custom' && (
                <div className="space-y-2.5">
                  <Label className={labelClasses}>{t('aiProviders.dialog.protocol', 'Protocol')}</Label>
                  <div className="flex gap-2 text-meta">
                    <button
                      type="button"
                        onClick={() => setApiProtocol('openai-completions')}
                        className={cn("flex-1 py-1.5 px-3 rounded-lg border transition-colors", apiProtocol === 'openai-completions' ? "bg-surface-modal border-black/20 dark:border-white/20 shadow-sm font-medium" : "border-transparent bg-black/5 dark:bg-white/5 text-muted-foreground hover:bg-black/10 dark:hover:bg-white/10")}
                    >
                      {t('aiProviders.protocols.openaiCompletions', 'OpenAI Completions')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setApiProtocol('openai-responses')}
                      className={cn("flex-1 py-1.5 px-3 rounded-lg border transition-colors", apiProtocol === 'openai-responses' ? "bg-surface-modal border-black/20 dark:border-white/20 shadow-sm font-medium" : "border-transparent bg-black/5 dark:bg-white/5 text-muted-foreground hover:bg-black/10 dark:hover:bg-white/10")}
                    >
                      {t('aiProviders.protocols.openaiResponses', 'OpenAI Responses')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setApiProtocol('anthropic-messages')}
                      className={cn("flex-1 py-1.5 px-3 rounded-lg border transition-colors", apiProtocol === 'anthropic-messages' ? "bg-surface-modal border-black/20 dark:border-white/20 shadow-sm font-medium" : "border-transparent bg-black/5 dark:bg-white/5 text-muted-foreground hover:bg-black/10 dark:hover:bg-white/10")}
                      >
                        {t('aiProviders.protocols.anthropic', 'Anthropic')}
                      </button>
                    </div>
                  </div>
                )}
                {showUserAgentInAddDialog && (
                  <div className="space-y-2.5">
                    <button
                      type="button"
                      onClick={() => setShowAdvancedConfig((value) => !value)}
                      className="flex items-center justify-between w-full text-sm font-bold text-foreground/80 hover:text-foreground transition-colors"
                    >
                      <span>{t('aiProviders.dialog.advancedConfig')}</span>
                      <ChevronDown className={cn("h-4 w-4 transition-transform", showAdvancedConfig && "rotate-180")} />
                    </button>
                    {showAdvancedConfig && (
                      <div className="space-y-2.5 pt-1">
                        <Label htmlFor="userAgent" className={labelClasses}>{t('aiProviders.dialog.userAgent')}</Label>
                        <Input
                          id="userAgent"
                          placeholder={t('aiProviders.dialog.userAgentPlaceholder')}
                          value={userAgent}
                          onChange={(e) => setUserAgent(e.target.value)}
                          className={inputClasses}
                        />
                      </div>
                    )}
                  </div>
                )}
                {/* Device OAuth Trigger — only shown when in OAuth mode */}
                {useOAuthFlow && (
                  <div className="space-y-4 pt-2">
                    <div className="rounded-xl bg-blue-500/10 border border-blue-500/20 p-5 text-center">
                      <p className="text-meta font-medium text-blue-600 dark:text-blue-400 mb-4 block">
                        {t('aiProviders.oauth.loginPrompt')}
                      </p>
                      <Button
                        data-testid="add-provider-oauth-login-button"
                        onClick={handleStartOAuth}
                        disabled={oauthFlowing}
                        className="w-full rounded-full h-[42px] font-semibold bg-brand hover:bg-brand-hover text-white shadow-sm"
                      >
                        {oauthFlowing ? (
                          <><Loader2 className="h-4 w-4 mr-2 animate-spin" />{t('aiProviders.oauth.waiting')}</>
                        ) : (
                          t('aiProviders.oauth.loginButton')
                        )}
                      </Button>
                    </div>

                    {/* OAuth Active State Modal / Inline View */}
                    {oauthFlowing && (
                      <div className="mt-4 p-5 border border-black/10 dark:border-white/10 rounded-2xl bg-surface-modal shadow-sm relative overflow-hidden">
                        {/* Background pulse effect */}
                        <div className="absolute inset-0 bg-blue-500/5 animate-pulse" />

                        <div className="relative z-10 flex flex-col items-center justify-center text-center space-y-5">
                          {oauthError ? (
                            <div className="text-red-500 space-y-3">
                              <XCircle className="h-10 w-10 mx-auto" />
                              <p className="font-semibold text-sm">{t('aiProviders.oauth.authFailed')}</p>
                              <p className="text-meta opacity-80">{oauthError}</p>
                              <Button variant="outline" size="sm" onClick={handleCancelOAuth} className="mt-2 rounded-full px-6 h-9">
                                Try Again
                              </Button>
                            </div>
                          ) : !oauthData ? (
                            <div className="space-y-4 py-6">
                              <Loader2 className="h-10 w-10 animate-spin text-blue-500 mx-auto" />
                              <p className="text-meta font-medium text-muted-foreground animate-pulse">{t('aiProviders.oauth.requestingCode')}</p>
                            </div>
                          ) : oauthData.mode === 'manual' ? (
                            <div className="space-y-4 w-full">
                              <div className="space-y-2">
                                <h3 className="font-semibold text-base text-foreground">Complete OpenAI Login</h3>
                                <p className="text-meta text-muted-foreground text-left bg-black/5 dark:bg-white/5 p-4 rounded-xl">
                                  {oauthData.message || 'Open the authorization page, complete login, then paste the callback URL or code below.'}
                                </p>
                              </div>

                              <Button
                                variant="secondary"
                                className="w-full rounded-full h-[42px] font-semibold"
                                onClick={() => hostApi.shell.openExternal(oauthData.authorizationUrl)}
                              >
                                <ExternalLink className="h-4 w-4 mr-2" />
                                Open Authorization Page
                              </Button>

                              <Input
                                placeholder="Paste callback URL or code"
                                value={manualCodeInput}
                                onChange={(e) => setManualCodeInput(e.target.value)}
                                className={inputClasses}
                              />

                              <Button
                                className="w-full rounded-full h-[42px] font-semibold bg-brand hover:bg-brand-hover text-white"
                                onClick={handleSubmitManualOAuthCode}
                                disabled={!manualCodeInput.trim()}
                              >
                                Submit Code
                              </Button>

                              <Button variant="ghost" className="w-full rounded-full h-[42px] font-semibold text-muted-foreground" onClick={handleCancelOAuth}>
                                Cancel
                              </Button>
                            </div>
                          ) : (
                            <div className="space-y-5 w-full">
                              <div className="space-y-2">
                                <h3 className="font-semibold text-base text-foreground">{t('aiProviders.oauth.approveLogin')}</h3>
                                <div className="text-meta text-muted-foreground text-left mt-2 space-y-1.5 bg-black/5 dark:bg-white/5 p-4 rounded-xl">
                                  <p>1. {t('aiProviders.oauth.step1')}</p>
                                  <p>2. {t('aiProviders.oauth.step2')}</p>
                                  <p>3. {t('aiProviders.oauth.step3')}</p>
                                </div>
                              </div>

                              <div className="flex items-center justify-center gap-3 p-4 bg-transparent border border-black/5 dark:border-white/5 rounded-xl shadow-inner">
                                <code className="text-3xl font-mono tracking-[0.2em] font-bold text-foreground">
                                  {oauthData.userCode}
                                </code>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-10 w-10 rounded-full hover:bg-black/5 dark:hover:bg-white/10"
                                  onClick={() => {
                                    navigator.clipboard.writeText(oauthData.userCode);
                                    toast.success(t('aiProviders.oauth.codeCopied'));
                                  }}
                                >
                                  <Copy className="h-5 w-5" />
                                </Button>
                              </div>

                              <Button
                                variant="secondary"
                                className="w-full rounded-full h-[42px] font-semibold"
                                onClick={() => hostApi.shell.openExternal(oauthData.verificationUri)}
                              >
                                <ExternalLink className="h-4 w-4 mr-2" />
                                {t('aiProviders.oauth.openLoginPage')}
                              </Button>

                              <div className="flex items-center justify-center gap-2 text-meta font-medium text-muted-foreground pt-2">
                                <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
                                <span>{t('aiProviders.oauth.waitingApproval')}</span>
                              </div>

                              <Button variant="ghost" className="w-full rounded-full h-[42px] font-semibold text-muted-foreground" onClick={handleCancelOAuth}>
                                Cancel
                              </Button>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <Separator className="bg-black/10 dark:bg-white/10" />

              <div className="flex justify-end gap-3">
                <Button
                  data-testid="add-provider-submit-button"
                  onClick={handleAdd}
                  className={cn("rounded-full px-8 h-[42px] text-meta font-semibold shadow-sm", useOAuthFlow && "hidden")}
                  disabled={!selectedType || saving || (showModelIdField && modelId.trim().length === 0)}
                >
                  {saving ? (
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  ) : null}
                  {t('aiProviders.dialog.add')}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
      </DialogContent>
    </Dialog>
  );
}
