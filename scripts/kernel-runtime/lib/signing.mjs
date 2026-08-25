import { createPrivateKey, sign } from 'node:crypto';
import { canonicalJson } from './canonical.mjs';

export function signCanonical(value, privateKeyPem, keyId) {
  if (typeof keyId !== 'string' || keyId.length === 0) throw new TypeError('A non-empty signing key ID is required');
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('Kernel metadata must use an Ed25519 private key');
  return {
    algorithm: 'Ed25519',
    keyId,
    signature: sign(null, Buffer.from(canonicalJson(value)), key).toString('base64url'),
  };
}

export function readPrivateKeyFromEnvironment(name) {
  const encoded = process.env[name];
  if (!encoded) throw new Error(`${name} is required; private signing keys are never read from the repository`);
  const pem = Buffer.from(encoded, 'base64').toString('utf8');
  createPrivateKey(pem);
  return pem;
}
