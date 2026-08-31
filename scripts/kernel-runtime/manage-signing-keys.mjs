#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import {
  buildGitHubEnvironmentSecrets,
  buildPublicTrustBundle,
  decryptKernelSigningKeyPayload,
  encryptKernelSigningKeyPayload,
  generateKernelSigningKeyPayload,
  summarizeKernelSigningKeyPayload,
} from './lib/key-backup.mjs';
import { canonicalJson } from './lib/canonical.mjs';

const command = process.argv[2];
const args = new Map();
for (let index = 3; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);

if (command === 'generate') {
  const output = secretPath(required('--output'));
  refuseOverwrite(output);
  const payload = generateKernelSigningKeyPayload({
    createdAt: args.get('--created-at'),
    notBefore: required('--not-before'),
    notAfter: required('--not-after'),
    keyIdSuffix: args.get('--key-id-suffix'),
  });
  const envelope = encryptKernelSigningKeyPayload(payload, readPassphrase());
  writeOwnerOnly(output, `${canonicalJson(envelope)}\n`);
  safePrint({ ok: true, command, output: relative(process.cwd(), output), backupSha256: fileSha256(output), ...summarizeKernelSigningKeyPayload(payload) });
} else if (command === 'verify') {
  const input = secretPath(required('--input'));
  const payload = decryptKernelSigningKeyPayload(readJson(input), readPassphrase());
  safePrint({ ok: true, command, input: relative(process.cwd(), input), backupSha256: fileSha256(input), ...summarizeKernelSigningKeyPayload(payload) });
} else if (command === 'export-ci') {
  const input = secretPath(required('--input'));
  const output = secretPath(required('--output'));
  refuseOverwrite(output);
  const payload = decryptKernelSigningKeyPayload(readJson(input), readPassphrase());
  writeOwnerOnly(output, `${canonicalJson({ schemaVersion: 1, environments: buildGitHubEnvironmentSecrets(payload) })}\n`);
  safePrint({ ok: true, command, output: relative(process.cwd(), output), environmentNames: ['kernel-staging', 'kernel-production'] });
} else if (command === 'export-public') {
  const input = secretPath(required('--input'));
  const output = resolve(required('--output'));
  refuseOverwrite(output);
  const payload = decryptKernelSigningKeyPayload(readJson(input), readPassphrase());
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${canonicalJson(buildPublicTrustBundle(payload))}\n`, { flag: 'wx', mode: 0o644 });
  safePrint({ ok: true, command, output: relative(process.cwd(), output), ...summarizeKernelSigningKeyPayload(payload) });
} else {
  throw new Error('Usage: manage-signing-keys.mjs <generate|verify|export-ci|export-public> [options]');
}

function readPassphrase() {
  const variable = args.get('--passphrase-env') ?? 'CLAWX_KEY_BACKUP_PASSPHRASE';
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(variable)) throw new Error('Invalid passphrase environment variable name');
  const value = process.env[variable];
  if (!value) throw new Error(`${variable} is required; passphrases are never accepted as command arguments`);
  return value;
}

function secretPath(value) {
  const path = resolve(value);
  const root = resolve('.clawx-secrets');
  if (path !== root && !path.startsWith(`${root}/`)) throw new Error('Secret inputs and outputs must stay under the git-ignored .clawx-secrets directory');
  return path;
}

function refuseOverwrite(path) {
  if (existsSync(path)) throw new Error(`Refusing to overwrite existing key material: ${path}`);
}

function writeOwnerOnly(path, contents) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  writeFileSync(path, contents, { flag: 'wx', mode: 0o600 });
  chmodSync(path, 0o600);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function fileSha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function required(key) {
  const value = args.get(key);
  if (!value) throw new Error(`Missing ${key}`);
  return value;
}

function safePrint(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
