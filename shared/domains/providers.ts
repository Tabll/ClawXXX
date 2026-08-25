import type { KernelId } from '../kernels/contracts';
import type { KernelEntityProjection, ProviderAccountId } from './identity';

export type CredentialReference = string & { readonly __credentialReference: true };

export type CanonicalProviderAuthMode = 'api_key' | 'oauth_device' | 'oauth_browser' | 'local';

export type CanonicalProviderProtocol =
  | 'openai-completions'
  | 'openai-responses'
  | 'openai-chatgpt-responses'
  | 'anthropic-messages'
  | 'google-generative-ai'
  | 'github-copilot'
  | 'bedrock-converse-stream'
  | 'ollama'
  | 'azure-openai-responses'
  | (string & {});

export type CanonicalProviderModel = {
  providerId: string;
  modelId: string;
  displayName: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  modalities: Array<'text' | 'image' | 'audio'>;
  supportsTools?: boolean;
  supportedKernels: KernelId[];
};

export type CanonicalProviderMetadata = {
  region?: string;
  email?: string;
  resourceUrl?: string;
  customModels?: string[];
  reasoning?: boolean;
  imageInput?: boolean;
};

export type CanonicalProviderAccount = {
  id: ProviderAccountId;
  providerId: string;
  displayName: string;
  authMode?: CanonicalProviderAuthMode;
  protocol?: CanonicalProviderProtocol;
  baseUrl?: string;
  /** Non-secret request headers only. Authorization/cookie headers are rejected by DataService. */
  headers?: Record<string, string>;
  credentialRef?: CredentialReference;
  metadata: CanonicalProviderMetadata;
  models: CanonicalProviderModel[];
  selectedModelId?: string;
  fallbackModelIds?: string[];
  fallbackAccountIds?: ProviderAccountId[];
  enabled?: boolean;
  projections: KernelEntityProjection[];
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type KernelProviderDefault = {
  kernelId: KernelId;
  accountId: ProviderAccountId;
  modelId?: string;
  updatedAt: string;
};

export type ProviderValidationResult = {
  accountId: ProviderAccountId;
  kernelId: KernelId;
  ok: boolean;
  checkedAt: string;
  models?: CanonicalProviderModel[];
  error?: { code: string; message: string };
};

const CREDENTIAL_REFERENCE_PATTERN = /^keychain:\/\/provider\/[A-Za-z0-9._~!$&'()*+,;=:@%-]+$/;

export function asCredentialReference(value: string): CredentialReference {
  if (!CREDENTIAL_REFERENCE_PATTERN.test(value)) {
    throw new Error('Provider credential reference must be an opaque keychain://provider reference');
  }
  return value as CredentialReference;
}

export function providerCredentialReference(accountId: string): CredentialReference {
  const normalized = accountId.trim();
  if (!normalized) throw new Error('Provider account id is required for a credential reference');
  return asCredentialReference(`keychain://provider/${encodeURIComponent(normalized)}`);
}
