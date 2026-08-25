#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { canonicalJson, readJson, sha256Bytes, writeCanonicalJson } from './lib/canonical.mjs';
import { readPrivateKeyFromEnvironment, signCanonical } from './lib/signing.mjs';
import { verifyCatalogEnvelope } from './verify-release-set.mjs';

const options = parseArgs(process.argv.slice(2));
const descriptorPaths = [
  ...(options.get('--descriptor') ?? []),
  ...(options.get('--descriptor-dir') ?? []).flatMap((directory) => findDescriptors(resolve(directory))),
];
const outputPath = requiredOne(options, '--output');
const sequence = Number.parseInt(requiredOne(options, '--sequence'), 10);
const channel = requiredOne(options, '--channel');
const issuedAt = requiredOne(options, '--issued-at');
const expiresAt = requiredOne(options, '--expires-at');
if (!Number.isInteger(sequence) || sequence < 1) throw new Error('Catalog sequence must be a positive integer');
if (channel !== 'staging' && channel !== 'production') throw new Error('Catalog channel must be staging or production');
if (Date.parse(expiresAt) <= Date.parse(issuedAt)) throw new Error('Catalog expiry must be after issue time');
const trustStorePath = first(options, '--trust-store');
if (!trustStorePath) throw new Error('Catalog promotion requires --trust-store');
const trustStore = readJson(resolve(trustStorePath));
const output = resolve(outputPath);
if (existsSync(output)) throw new Error(`Catalog outputs are immutable: ${output}`);

const previousPath = first(options, '--previous');
const previous = previousPath ? readJson(resolve(previousPath)) : undefined;
const bootstrap = first(options, '--bootstrap') === 'true';
if (previous) {
  verifyCatalogEnvelope(previous, trustStore, new Date(previous.issuedAt));
  if (previous.channel !== channel) throw new Error('Catalog promotion cannot change channel');
  if (bootstrap) throw new Error('Bootstrap authorization cannot be combined with a previous catalog');
  if (Date.parse(issuedAt) <= Date.parse(previous.issuedAt)) {
    throw new Error('Catalog issuedAt must advance monotonically');
  }
}
if (previous && sequence !== previous.sequence + 1) throw new Error('Normal promotion sequence must increment exactly once');
if (!previous && sequence !== 1) throw new Error('A non-bootstrap promotion requires the signed previous catalog');
if (!previous && !bootstrap) throw new Error('The first catalog sequence requires explicit bootstrap authorization');

const artifacts = new Map();
for (const descriptor of previous?.artifacts ?? []) artifacts.set(identity(descriptor), descriptor);
for (const path of descriptorPaths) {
  const descriptor = readJson(resolve(path));
  validateDescriptorShape(descriptor, path);
  const artifactIdentity = identity(descriptor);
  const existing = artifacts.get(artifactIdentity);
  if (existing && canonicalJson(existing) !== canonicalJson(descriptor)) {
    throw new Error(`Published artifact identity cannot be overwritten: ${artifactIdentity}`);
  }
  artifacts.set(artifactIdentity, descriptor);
}
const revoked = new Set(previous?.revokedArtifactIdentities ?? []);
for (const value of options.get('--revoke') ?? []) {
  if (!artifacts.has(value) && !revoked.has(value)) throw new Error(`Cannot revoke unknown artifact identity: ${value}`);
  revoked.add(value);
}
const unsignedCatalog = {
  schemaVersion: 1,
  channel,
  sequence,
  issuedAt: new Date(issuedAt).toISOString(),
  expiresAt: new Date(expiresAt).toISOString(),
  artifacts: [...artifacts.values()].filter((artifact) => !revoked.has(identity(artifact)))
    .sort((left, right) => identity(left).localeCompare(identity(right))),
  revokedArtifactIdentities: [...revoked].sort(),
};
const privateKey = readPrivateKeyFromEnvironment('CLAWX_CATALOG_SIGNING_PRIVATE_KEY_B64');
const keyId = process.env.CLAWX_CATALOG_SIGNING_KEY_ID;
const catalog = { ...unsignedCatalog, catalogSignature: signCanonical(unsignedCatalog, privateKey, keyId) };
verifyCatalogEnvelope(catalog, trustStore, new Date(catalog.issuedAt));
verifyCatalogEnvelope(catalog, trustStore, new Date(Date.parse(catalog.expiresAt) - 1));
writeCanonicalJson(output, catalog);
writeFileSync(`${output}.sha256`, `${sha256Bytes(readFileSync(output))}  ${basename(output)}\n`, { mode: 0o600, flag: 'wx' });
process.stdout.write(`${JSON.stringify({ ok: true, channel, sequence, artifacts: catalog.artifacts.length, revoked: revoked.size })}\n`);

function parseArgs(args) {
  const result = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error(`Invalid argument at ${key ?? '<end>'}`);
    result.set(key, [...(result.get(key) ?? []), value]);
  }
  return result;
}

function first(optionsMap, key) {
  return optionsMap.get(key)?.[0];
}

function requiredOne(optionsMap, key) {
  const value = first(optionsMap, key);
  if (!value) throw new Error(`Missing ${key}`);
  return value;
}

function identity(descriptor) {
  return `${descriptor.kernelId}/${descriptor.artifactVersion}/${descriptor.platform}-${descriptor.arch}`;
}

function validateDescriptorShape(descriptor, path) {
  const required = ['kernelId', 'artifactVersion', 'platform', 'arch', 'archive', 'descriptorSignature', 'supplyChain', 'storage'];
  for (const field of required) if (!descriptor?.[field]) throw new Error(`Descriptor ${path} is missing ${field}`);
  if (!/^.+\+clawx\.[1-9][0-9]*$/.test(descriptor.artifactVersion)) throw new Error(`Descriptor ${path} has a mutable version identity`);
  if (descriptor.storage.authority !== 'clawx-data-service' || descriptor.storage.nativeDurableHistory !== false) {
    throw new Error(`Descriptor ${path} fails the canonical storage contract`);
  }
}

function findDescriptors(root) {
  const output = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) output.push(...findDescriptors(path));
    else if (path.endsWith('.descriptor.json')) output.push(path);
  }
  return output;
}
