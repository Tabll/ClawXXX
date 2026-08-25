#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonicalJson, readJson, sha256Bytes, writeCanonicalJson } from './lib/canonical.mjs';
import { readPrivateKeyFromEnvironment, signCanonical } from './lib/signing.mjs';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const catalogPath = required('--catalog');
const outputPath = resolve(required('--output'));
const fromSequence = Number.parseInt(required('--from-sequence'), 10);
const reason = required('--reason');
const issuedAt = new Date(required('--issued-at')).toISOString();
const expiresAt = new Date(required('--expires-at')).toISOString();
if (existsSync(outputPath)) throw new Error(`Rollback authorization is immutable: ${outputPath}`);
if (reason.length < 16 || Date.parse(expiresAt) <= Date.parse(issuedAt)) throw new Error('Rollback authorization reason/time window is invalid');
const catalog = readJson(resolve(catalogPath));
if (!Number.isInteger(fromSequence) || fromSequence <= catalog.sequence) throw new Error('Rollback must move from a higher accepted sequence');
const { catalogSignature: _catalogSignature, emergencyRollback: _oldAuthorization, ...rollbackTarget } = catalog;
const unsigned = {
  schemaVersion: 1,
  authorizationId: required('--authorization-id'),
  fromSequence,
  toSequence: catalog.sequence,
  catalogSha256: sha256Bytes(canonicalJson(rollbackTarget)),
  reason,
  issuedAt,
  expiresAt,
};
const authorization = {
  ...unsigned,
  signing: signCanonical(
    unsigned,
    readPrivateKeyFromEnvironment('CLAWX_ROLLBACK_SIGNING_PRIVATE_KEY_B64'),
    process.env.CLAWX_ROLLBACK_SIGNING_KEY_ID,
  ),
};
writeCanonicalJson(outputPath, authorization);
process.stdout.write(`${JSON.stringify({ ok: true, fromSequence, toSequence: catalog.sequence, authorizationId: unsigned.authorizationId })}\n`);

function required(key) {
  const value = args.get(key);
  if (!value) throw new Error(`Missing ${key}`);
  return value;
}
