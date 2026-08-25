import { createPublicKey } from 'node:crypto';

const PURPOSES = new Set(['artifact', 'catalog', 'rollback']);

export function buildTrustStoreFromBundle(encoded, options = {}) {
  if (typeof encoded !== 'string' || encoded.trim() === '') {
    throw new Error('CLAWX_KERNEL_TRUST_KEYS_B64 is required');
  }
  let bundle;
  try {
    bundle = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  } catch (error) {
    throw new Error(`Kernel trust-key bundle is not valid base64 JSON: ${String(error)}`);
  }
  if (bundle?.schemaVersion !== 1 || !Array.isArray(bundle.keys) || bundle.keys.length === 0 || bundle.keys.length > 64) {
    throw new Error('Kernel trust-key bundle must contain 1-64 v1 keys');
  }
  const channel = options.channel ?? 'production';
  const nowMs = (options.now ?? new Date()).getTime();
  const seen = new Set();
  const keys = bundle.keys.map((input) => {
    if (!input || typeof input !== 'object') throw new Error('Kernel trust key must be an object');
    const keyId = String(input.keyId ?? '');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(keyId) || seen.has(keyId)) {
      throw new Error(`Invalid or duplicate kernel trust key ID: ${keyId || '<empty>'}`);
    }
    if (channel === 'production' && /(?:dev|test|fixture|example)/i.test(keyId)) {
      throw new Error(`Production key ID is not release-safe: ${keyId}`);
    }
    seen.add(keyId);
    const purposes = Array.isArray(input.purposes) ? [...new Set(input.purposes)] : [];
    if (purposes.length === 0 || purposes.some(purpose => !PURPOSES.has(purpose))) {
      throw new Error(`Kernel trust key ${keyId} has invalid purposes`);
    }
    const publicKeyPem = typeof input.publicKeyPem === 'string'
      ? input.publicKeyPem
      : Buffer.from(String(input.publicKeyB64 ?? ''), 'base64').toString('utf8');
    const publicKey = createPublicKey(publicKeyPem);
    if (publicKey.asymmetricKeyType !== 'ed25519') {
      throw new Error(`Kernel trust key ${keyId} must be Ed25519`);
    }
    const notBefore = validIso(input.notBefore, `${keyId}.notBefore`);
    const notAfter = validIso(input.notAfter, `${keyId}.notAfter`);
    if (Date.parse(notAfter) <= Date.parse(notBefore)) throw new Error(`Kernel trust key ${keyId} has an empty validity window`);
    const revokedAt = input.revokedAt === undefined ? undefined : validIso(input.revokedAt, `${keyId}.revokedAt`);
    return {
      keyId,
      algorithm: 'Ed25519',
      purposes: purposes.sort(),
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      notBefore,
      notAfter,
      ...(revokedAt ? { revokedAt } : {}),
    };
  }).sort((left, right) => left.keyId.localeCompare(right.keyId));

  const activePurposes = new Set(keys.flatMap(key => (
    Date.parse(key.notBefore) <= nowMs
    && Date.parse(key.notAfter) > nowMs
    && (!key.revokedAt || Date.parse(key.revokedAt) > nowMs)
      ? key.purposes
      : []
  )));
  for (const purpose of PURPOSES) {
    if (!activePurposes.has(purpose)) throw new Error(`Trust bundle has no active ${purpose} key`);
  }
  return { schemaVersion: 1, keys };
}

function validIso(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(`${label} must be ISO-8601`);
  return new Date(value).toISOString();
}
