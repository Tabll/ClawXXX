import type { AsrConfig } from '@shared/host-api/contract';
import type { CompleteHostServiceRegistry } from '../main/ipc/host-contract';
import type { CredentialStagingVault } from '../security/credential-staging-vault';
import { serializeAsrError } from '@shared/asr/errors';
import { AsrClientError, transcribeWav, validateAsrConfig } from './asr/asr-client';
import { getAsrApiKey, getAsrConfig, resolveAsrReadiness, setAsrApiKey, setAsrConfig } from './asr/config-store';
import { isRecord } from './payload-utils';
import { getMicrophoneAccess, openMicrophoneSettings } from './asr/microphone-access';

const MAX_WAV_BYTES = 44 + 181 * 16_000 * 2; // allow the final capture/timer frame

function safeAsrError(error: unknown): AsrClientError {
  // Provider bodies and network errors may echo credentials. Only a stable code
  // crosses to the Renderer; localized UI copy supplies the explanation.
  return serializeAsrError(new AsrClientError(error instanceof AsrClientError ? error.code : 'REQUEST'));
}

function validateWav(wav: unknown): asserts wav is Uint8Array {
  if (!(wav instanceof Uint8Array) || wav.byteLength < 44 || wav.byteLength > MAX_WAV_BYTES) {
    throw new AsrClientError('INVALID_INPUT');
  }
  const header = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const tag = (offset: number, value: string) => [...value].every((char, i) => wav[offset + i] === char.charCodeAt(0));
  if (!tag(0, 'RIFF') || !tag(8, 'WAVE') || !tag(12, 'fmt ') || !tag(36, 'data')
    || header.getUint32(16, true) !== 16 || header.getUint16(20, true) !== 1
    || header.getUint16(22, true) !== 1 || header.getUint32(24, true) !== 16_000
    || header.getUint32(28, true) !== 32_000 || header.getUint16(32, true) !== 2
    || header.getUint16(34, true) !== 16 || header.getUint32(4, true) !== wav.byteLength - 8
    || header.getUint32(40, true) !== wav.byteLength - 44 || (wav.byteLength - 44) % 2 !== 0) {
    throw new AsrClientError('INVALID_INPUT');
  }
}

export function createAsrApi(ctx: { credentialVault?: CredentialStagingVault } = {}): CompleteHostServiceRegistry['asr'] {
  let tail = Promise.resolve();
  const serial = <T>(action: () => Promise<T>): Promise<T> => {
    const result = tail.then(action);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
  return {
    getMicrophoneAccess: async () => getMicrophoneAccess(),
    openMicrophoneSettings: async () => openMicrophoneSettings(),
    getConfig: () => serial(resolveAsrReadiness),
    saveConfig: payload => serial(async () => {
      try {
        if (!isRecord(payload) || !isRecord(payload.config) || 'apiKey' in payload
          || ('credentialHandle' in payload && typeof payload.credentialHandle !== 'string')
          || (payload.clearApiKey !== undefined && typeof payload.clearApiKey !== 'boolean')
          || (payload.clearApiKey && payload.credentialHandle)) throw new AsrClientError('INVALID_INPUT');
        const config = payload.config as AsrConfig;
        validateAsrConfig(config);
        const credential = payload.credentialHandle === undefined ? undefined
          : ctx.credentialVault?.consume(payload.credentialHandle)?.trim();
        if (payload.credentialHandle !== undefined && !credential) throw new AsrClientError('INVALID_INPUT');
        const oldKey = await getAsrApiKey();
        const previous = await getAsrConfig();
        // Never carry a saved credential to a different endpoint implicitly.
        const endpointChanged = previous && previous.baseUrl !== config.baseUrl;
        const nextKey = payload.clearApiKey || (endpointChanged && credential === undefined) ? '' : credential;
        if (nextKey !== undefined) await setAsrApiKey(nextKey);
        try {
          await setAsrConfig(config);
        } catch (error) {
          if (nextKey !== undefined) await setAsrApiKey(oldKey ?? '');
          throw error;
        }
        return await resolveAsrReadiness();
      } catch (error) { throw safeAsrError(error); }
    }),
    transcribe: async payload => {
      try {
        const wav = isRecord(payload) ? payload.wav : undefined;
        validateWav(wav);
        const { config, apiKey } = await serial(async () => ({ config: await getAsrConfig(), apiKey: await getAsrApiKey() }));
        if (!config || !apiKey) throw new AsrClientError('NOT_CONFIGURED');
        validateAsrConfig(config);
        return { text: await transcribeWav({ wav, config, apiKey }) };
      } catch (error) { throw safeAsrError(error); }
    },
  };
}
