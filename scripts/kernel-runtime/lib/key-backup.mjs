import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  scryptSync,
} from 'node:crypto';
import { canonicalJson } from './canonical.mjs';

const BACKUP_FORMAT = 'clawx-kernel-signing-key-backup';
const BACKUP_SCHEMA_VERSION = 1;
const KDF = Object.freeze({ name: 'scrypt', N: 32768, r: 8, p: 1, keyLength: 32 });
const CIPHER = 'aes-256-gcm';
const ROLES = Object.freeze(['artifact', 'catalog', 'rollback']);

export function generateKernelSigningKeyPayload(options = {}) {
  const createdAt = validIso(options.createdAt ?? new Date(), 'createdAt');
  const notBefore = validIso(options.notBefore ?? createdAt, 'notBefore');
  const notAfter = validIso(options.notAfter, 'notAfter');
  if (Date.parse(notAfter) <= Date.parse(notBefore)) {
    throw new Error('Kernel signing key validity window must be non-empty');
  }
  const keyIdSuffix = options.keyIdSuffix ?? createdAt.slice(0, 7);
  if (!/^\d{4}-\d{2}(?:-[A-Za-z0-9][A-Za-z0-9._-]{0,31})?$/.test(keyIdSuffix)) {
    throw new Error('keyIdSuffix must begin with YYYY-MM');
  }

  const keys = ROLES.map((role) => {
    const pair = generateKeyPairSync('ed25519');
    return {
      role,
      keyId: `clawx-${role}-${keyIdSuffix}`,
      algorithm: 'Ed25519',
      publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      notBefore,
      notAfter,
    };
  });
  return validateKernelSigningKeyPayload({
    schemaVersion: 1,
    createdAt,
    keys,
  });
}

export function validateKernelSigningKeyPayload(payload) {
  if (!payload || payload.schemaVersion !== 1 || !Array.isArray(payload.keys)) {
    throw new Error('Kernel signing key payload must be a v1 key set');
  }
  const createdAt = validIso(payload.createdAt, 'createdAt');
  if (payload.keys.length !== ROLES.length) throw new Error('Kernel signing key payload must contain exactly three roles');
  const seenRoles = new Set();
  const seenIds = new Set();
  const keys = payload.keys.map((input) => {
    const role = String(input?.role ?? '');
    const keyId = String(input?.keyId ?? '');
    if (!ROLES.includes(role) || seenRoles.has(role)) throw new Error(`Invalid or duplicate kernel signing role: ${role || '<empty>'}`);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(keyId) || seenIds.has(keyId)) {
      throw new Error(`Invalid or duplicate kernel signing key ID: ${keyId || '<empty>'}`);
    }
    if (input.algorithm !== 'Ed25519') throw new Error(`${keyId} must use Ed25519`);
    const privateKey = createPrivateKey(input.privateKeyPem);
    const publicKey = createPublicKey(input.publicKeyPem);
    if (privateKey.asymmetricKeyType !== 'ed25519' || publicKey.asymmetricKeyType !== 'ed25519') {
      throw new Error(`${keyId} must contain an Ed25519 key pair`);
    }
    const derivedPublicKeyPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
    const normalizedPublicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    if (derivedPublicKeyPem !== normalizedPublicKeyPem) throw new Error(`${keyId} public/private key mismatch`);
    const notBefore = validIso(input.notBefore, `${keyId}.notBefore`);
    const notAfter = validIso(input.notAfter, `${keyId}.notAfter`);
    if (Date.parse(notAfter) <= Date.parse(notBefore)) throw new Error(`${keyId} has an empty validity window`);
    seenRoles.add(role);
    seenIds.add(keyId);
    return {
      role,
      keyId,
      algorithm: 'Ed25519',
      publicKeyPem: normalizedPublicKeyPem,
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      notBefore,
      notAfter,
    };
  }).sort((left, right) => ROLES.indexOf(left.role) - ROLES.indexOf(right.role));
  for (const role of ROLES) {
    if (!seenRoles.has(role)) throw new Error(`Kernel signing key payload is missing ${role}`);
  }
  return { schemaVersion: 1, createdAt, keys };
}

export function buildPublicTrustBundle(payload) {
  const validated = validateKernelSigningKeyPayload(payload);
  return {
    schemaVersion: 1,
    keys: validated.keys.map(key => ({
      keyId: key.keyId,
      purposes: [key.role],
      publicKeyPem: key.publicKeyPem,
      notBefore: key.notBefore,
      notAfter: key.notAfter,
    })),
  };
}

export function buildGitHubEnvironmentSecrets(payload) {
  const validated = validateKernelSigningKeyPayload(payload);
  const byRole = Object.fromEntries(validated.keys.map(key => [key.role, key]));
  return {
    'kernel-staging': {
      CLAWX_ARTIFACT_SIGNING_KEY_ID: byRole.artifact.keyId,
      CLAWX_ARTIFACT_SIGNING_PRIVATE_KEY_B64: Buffer.from(byRole.artifact.privateKeyPem).toString('base64'),
    },
    'kernel-production': {
      CLAWX_CATALOG_SIGNING_KEY_ID: byRole.catalog.keyId,
      CLAWX_CATALOG_SIGNING_PRIVATE_KEY_B64: Buffer.from(byRole.catalog.privateKeyPem).toString('base64'),
      CLAWX_KERNEL_TRUST_KEYS_B64: Buffer.from(canonicalJson(buildPublicTrustBundle(validated))).toString('base64'),
    },
  };
}

export function encryptKernelSigningKeyPayload(payload, passphrase, options = {}) {
  const validated = validateKernelSigningKeyPayload(payload);
  assertPassphrase(passphrase);
  const salt = options.salt ?? randomBytes(32);
  const nonce = options.nonce ?? randomBytes(12);
  if (!Buffer.isBuffer(salt) || salt.length !== 32) throw new Error('Backup salt must be 32 bytes');
  if (!Buffer.isBuffer(nonce) || nonce.length !== 12) throw new Error('Backup nonce must be 12 bytes');
  const header = {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    format: BACKUP_FORMAT,
    cipher: { name: CIPHER, nonce: nonce.toString('base64url') },
    kdf: { ...KDF, salt: salt.toString('base64url') },
  };
  const plaintext = Buffer.from(canonicalJson(validated));
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv(CIPHER, key, nonce);
  cipher.setAAD(Buffer.from(canonicalJson(header)));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    ...header,
    ciphertext: ciphertext.toString('base64url'),
    authTag: cipher.getAuthTag().toString('base64url'),
    plaintextSha256: sha256(plaintext),
  };
}

export function decryptKernelSigningKeyPayload(envelope, passphrase) {
  assertPassphrase(passphrase);
  validateEnvelope(envelope);
  const header = {
    schemaVersion: envelope.schemaVersion,
    format: envelope.format,
    cipher: envelope.cipher,
    kdf: envelope.kdf,
  };
  const salt = decodeFixed(envelope.kdf.salt, 32, 'backup salt');
  const nonce = decodeFixed(envelope.cipher.nonce, 12, 'backup nonce');
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64url');
  const decipher = createDecipheriv(CIPHER, deriveKey(passphrase, salt), nonce);
  decipher.setAAD(Buffer.from(canonicalJson(header)));
  decipher.setAuthTag(decodeFixed(envelope.authTag, 16, 'backup authentication tag'));
  let plaintext;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error('Kernel signing key backup authentication failed');
  }
  if (sha256(plaintext) !== envelope.plaintextSha256) throw new Error('Kernel signing key backup digest mismatch');
  let payload;
  try {
    payload = JSON.parse(plaintext.toString('utf8'));
  } catch {
    throw new Error('Kernel signing key backup plaintext is not valid JSON');
  }
  return validateKernelSigningKeyPayload(payload);
}

export function summarizeKernelSigningKeyPayload(payload) {
  const validated = validateKernelSigningKeyPayload(payload);
  return {
    schemaVersion: validated.schemaVersion,
    createdAt: validated.createdAt,
    keys: validated.keys.map(({ role, keyId, notBefore, notAfter }) => ({ role, keyId, notBefore, notAfter })),
    publicTrustBundleSha256: sha256(Buffer.from(canonicalJson(buildPublicTrustBundle(validated)))),
  };
}

function validateEnvelope(envelope) {
  if (!envelope || envelope.schemaVersion !== BACKUP_SCHEMA_VERSION || envelope.format !== BACKUP_FORMAT) {
    throw new Error('Kernel signing key backup has an unsupported format');
  }
  if (envelope.cipher?.name !== CIPHER || envelope.kdf?.name !== KDF.name
    || envelope.kdf.N !== KDF.N || envelope.kdf.r !== KDF.r || envelope.kdf.p !== KDF.p
    || envelope.kdf.keyLength !== KDF.keyLength) {
    throw new Error('Kernel signing key backup uses unsupported cryptographic parameters');
  }
  decodeFixed(envelope.kdf.salt, 32, 'backup salt');
  decodeFixed(envelope.cipher.nonce, 12, 'backup nonce');
  decodeFixed(envelope.authTag, 16, 'backup authentication tag');
  if (typeof envelope.ciphertext !== 'string' || envelope.ciphertext.length < 64) throw new Error('Backup ciphertext is invalid');
  if (!/^[a-f0-9]{64}$/.test(envelope.plaintextSha256 ?? '')) throw new Error('Backup plaintext digest is invalid');
}

function deriveKey(passphrase, salt) {
  return scryptSync(passphrase, salt, KDF.keyLength, {
    N: KDF.N,
    r: KDF.r,
    p: KDF.p,
    maxmem: 128 * 1024 * 1024,
  });
}

function assertPassphrase(passphrase) {
  if (typeof passphrase !== 'string' || Buffer.byteLength(passphrase) < 24) {
    throw new Error('Kernel signing key backup passphrase must be at least 24 bytes');
  }
}

function decodeFixed(value, length, label) {
  if (typeof value !== 'string') throw new Error(`${label} is invalid`);
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== length || bytes.toString('base64url') !== value) throw new Error(`${label} is invalid`);
  return bytes;
}

function validIso(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} must be ISO-8601`);
  return date.toISOString();
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
