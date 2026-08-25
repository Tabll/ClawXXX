#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonicalJson, readJson, sha256Bytes, writeCanonicalJson } from './lib/canonical.mjs';
import { readPrivateKeyFromEnvironment, signCanonical } from './lib/signing.mjs';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const target = readJson(resolve(required('--target-catalog')));
const authorization = readJson(resolve(required('--authorization')));
const output = resolve(required('--output'));
if (existsSync(output)) throw new Error(`Emergency catalog output is immutable: ${output}`);
const { catalogSignature: _oldSignature, emergencyRollback: _oldAuthorization, ...targetPayload } = target;
const expectedDigest = sha256Bytes(canonicalJson(targetPayload));
if (authorization.toSequence !== target.sequence
  || authorization.fromSequence !== Number.parseInt(required('--from-sequence'), 10)
  || authorization.catalogSha256 !== expectedDigest
  || Date.parse(authorization.expiresAt) <= Date.now()) {
  throw new Error('Rollback authorization does not exactly scope this target catalog');
}
const unsigned = { ...targetPayload, emergencyRollback: authorization };
const catalog = {
  ...unsigned,
  catalogSignature: signCanonical(
    unsigned,
    readPrivateKeyFromEnvironment('CLAWX_CATALOG_SIGNING_PRIVATE_KEY_B64'),
    process.env.CLAWX_CATALOG_SIGNING_KEY_ID,
  ),
};
writeCanonicalJson(output, catalog);
process.stdout.write(`${JSON.stringify({ ok: true, fromSequence: authorization.fromSequence, toSequence: target.sequence })}\n`);

function required(key) {
  const value = args.get(key);
  if (!value) throw new Error(`Missing ${key}`);
  return value;
}
