#!/usr/bin/env node
/** Import public roots from independently authenticated release evidence. No TOFU/download. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from './lib/canonical.mjs';
import { buildTrustStoreFromBundle } from './lib/trust-store.mjs';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const source = args.get('--source');
const expected = args.get('--sha256');
if (!source || !/^[0-9a-f]{64}$/.test(expected ?? '')) throw new Error('Usage: import-local-trust --source VERIFIED_PUBLIC_ROOTS --sha256 INDEPENDENTLY_VERIFIED_SHA256');
const bytes = readFileSync(resolve(source));
if (bytes.length > 256 * 1024 || bytes.includes('PRIVATE KEY')) throw new Error('Only bounded public trust roots may be imported');
if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Public trust roots SHA-256 mismatch');
const bundle = JSON.parse(bytes.toString('utf8'));
for (const key of Array.isArray(bundle?.keys) ? bundle.keys : []) {
  // createPublicKey also accepts private keys. Reject them explicitly, including
  // the base64 bundle form, before the shared public-store normalizer runs.
  for (const pem of [key?.publicKeyPem, typeof key?.publicKeyB64 === 'string'
    ? Buffer.from(key.publicKeyB64, 'base64').toString('utf8') : undefined]) {
    if (pem !== undefined && (typeof pem !== 'string'
      || !pem.trim().startsWith('-----BEGIN PUBLIC KEY-----') || pem.includes('PRIVATE KEY'))) {
      throw new Error('Only public key PEM material may be imported');
    }
  }
}
const store = buildTrustStoreFromBundle(bytes.toString('base64'), { channel: 'production' });
const repository = resolve(args.get('--repository') ?? fileURLToPath(new URL('../..', import.meta.url)));
const output = join(repository, 'resources/kernels/trust/roots.production.json');
if (existsSync(output)) {
  if (canonicalJson(JSON.parse(readFileSync(output, 'utf8'))) !== canonicalJson(store)) {
    throw new Error('Different local trust roots already exist; deliberate reviewed rotation is required');
  }
} else {
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  writeFileSync(output, `${canonicalJson(store)}\n`, { flag: 'wx', mode: 0o600 });
}
console.log(JSON.stringify({ ok: true, output, keys: store.keys.map(key => key.keyId) }));
