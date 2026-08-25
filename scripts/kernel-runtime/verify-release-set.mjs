#!/usr/bin/env node
import { createPublicKey, verify } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalJson, readJson, sha256File } from './lib/canonical.mjs';

export function verifyCatalogEnvelope(catalog, trustStore, now = new Date()) {
  if (catalog?.schemaVersion !== 1 || !Array.isArray(catalog.artifacts) || catalog.channel !== 'production'
    || !Number.isSafeInteger(catalog.sequence) || catalog.sequence < 1
    || !Array.isArray(catalog.revokedArtifactIdentities)) {
    throw new Error('Production catalog shape is invalid');
  }
  const validity = validityWindow(catalog.issuedAt, catalog.expiresAt, 'Production catalog');
  const nowMs = validNow(now);
  if (validity.start > nowMs || validity.end <= nowMs) {
    throw new Error('Production catalog is not currently valid');
  }
  verifySignedValue(catalog, 'catalogSignature', trustStore, 'catalog', now);
  for (const descriptor of catalog.artifacts) verifyArtifactDescriptor(descriptor, trustStore, now);
  return catalog;
}

export function verifyArtifactDescriptor(descriptor, trustStore, now = new Date()) {
  if (descriptor?.schemaVersion !== 1 || descriptor.archive?.format !== 'tar.zst'
    || descriptor.storage?.authority !== 'clawx-data-service'
    || descriptor.storage?.nativeDurableHistory !== false) {
    throw new Error('Kernel artifact descriptor shape/storage authority is invalid');
  }
  const validity = validityWindow(descriptor.publishedAt, descriptor.expiresAt, `Kernel artifact ${identity(descriptor)}`);
  const nowMs = validNow(now);
  if (validity.start > nowMs || validity.end <= nowMs) {
    throw new Error(`Kernel artifact is not currently valid: ${identity(descriptor)}`);
  }
  verifySignedValue(descriptor, 'descriptorSignature', trustStore, 'artifact', now);
  return descriptor;
}

export function verifyReleaseSet(input) {
  const catalog = verifyCatalogEnvelope(input.catalog, input.trustStore, input.now);
  const localDescriptors = descriptorFiles(input.artifactRoot).map(readJson);
  if (localDescriptors.length === 0) throw new Error('Release set contains no local artifact descriptors');
  const catalogByIdentity = new Map(catalog.artifacts.map(item => [identity(item), item]));
  for (const descriptor of localDescriptors) {
    verifyArtifactDescriptor(descriptor, input.trustStore, input.now);
    if (input.distribution) assertDescriptorDistributionUrl(descriptor, input.distribution);
    const published = catalogByIdentity.get(identity(descriptor));
    if (!published || canonicalJson(published) !== canonicalJson(descriptor)) {
      throw new Error(`Local descriptor is absent or changed in catalog: ${identity(descriptor)}`);
    }
    const archivePath = archiveFiles(input.artifactRoot)
      .find(path => basename(path) === basename(new URL(descriptor.archive.url).pathname));
    if (!archivePath || sha256File(archivePath) !== descriptor.archive.sha256) {
      throw new Error(`Local archive is absent or has the wrong digest: ${identity(descriptor)}`);
    }
  }
  if (input.requiredTargets) {
    const expected = new Set(input.requiredTargets.map(target => `${target.platform}-${target.arch}`));
    for (const kernelId of input.requiredKernelIds ?? []) {
      const actual = new Set(localDescriptors.filter(item => item.kernelId === kernelId)
        .map(item => `${item.platform}-${item.arch}`));
      const missing = [...expected].filter(target => !actual.has(target));
      if (missing.length > 0) throw new Error(`${kernelId} release set is missing targets: ${missing.join(', ')}`);
    }
  }
  return { ok: true, catalogSequence: catalog.sequence, descriptors: localDescriptors.length };
}

export function assertDescriptorDistributionUrl(descriptor, distribution) {
  const bases = distribution?.mirrorBaseUrls;
  if (!Array.isArray(bases) || bases.length < 2) {
    throw new Error('Kernel distribution must declare at least two artifact mirrors');
  }
  let descriptorUrl;
  try {
    descriptorUrl = new URL(descriptor?.archive?.url);
  } catch {
    throw new Error(`Artifact archive URL is invalid: ${identity(descriptor)}`);
  }
  const filename = basename(descriptorUrl.pathname);
  const allowed = bases.some((value) => {
    let base;
    try {
      base = new URL(value);
    } catch {
      return false;
    }
    if (base.protocol !== 'https:') return false;
    const normalized = base.href.endsWith('/') ? base.href : `${base.href}/`;
    return descriptorUrl.href === new URL(filename, normalized).href;
  });
  if (!allowed) throw new Error(`Artifact archive URL is outside configured immutable mirrors: ${identity(descriptor)}`);
}

function verifySignedValue(value, signatureField, trustStore, purpose, now) {
  const signature = value?.[signatureField];
  if (signature?.algorithm !== 'Ed25519' || typeof signature.keyId !== 'string' || typeof signature.signature !== 'string') {
    throw new Error(`Missing or invalid ${signatureField}`);
  }
  const key = trustStore?.keys?.find(item => item.keyId === signature.keyId);
  const nowMs = validNow(now);
  const keyValidity = key ? validityWindow(key.notBefore, key.notAfter, `Trust key ${signature.keyId}`) : undefined;
  const revokedAt = key?.revokedAt === undefined ? undefined : Date.parse(key.revokedAt);
  if (key?.revokedAt !== undefined && !Number.isFinite(revokedAt)) {
    throw new Error(`Trust key ${signature.keyId} has an invalid revocation time`);
  }
  if (!key || key.algorithm !== 'Ed25519' || !key.purposes.includes(purpose)
    || keyValidity.start > nowMs || keyValidity.end <= nowMs
    || (revokedAt !== undefined && revokedAt <= nowMs)) {
    throw new Error(`${signatureField} key is unavailable, inactive or revoked: ${signature.keyId}`);
  }
  const unsigned = { ...value };
  delete unsigned[signatureField];
  const valid = verify(
    null,
    Buffer.from(canonicalJson(unsigned)),
    createPublicKey(key.publicKeyPem),
    Buffer.from(signature.signature, 'base64url'),
  );
  if (!valid) throw new Error(`${signatureField} verification failed`);
}

function validityWindow(startValue, endValue, label) {
  const start = Date.parse(startValue);
  const end = Date.parse(endValue);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new Error(`${label} has an invalid validity window`);
  }
  return { start, end };
}

function validNow(now) {
  const value = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(value)) throw new Error('Signature verification time is invalid');
  return value;
}

function identity(descriptor) {
  return `${descriptor.kernelId}/${descriptor.artifactVersion}/${descriptor.platform}-${descriptor.arch}`;
}

function descriptorFiles(root) {
  return walk(root).filter(path => path.endsWith('.descriptor.json'));
}

function archiveFiles(root) {
  return walk(root).filter(path => path.endsWith('.tar.zst'));
}

function walk(root) {
  const output = [];
  const visit = directory => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) visit(path);
      else output.push(path);
    }
  };
  visit(resolve(root));
  return output.sort();
}

async function main() {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
  const matrix = readJson(resolve(args.get('--matrix') ?? join(process.cwd(), 'kernels', 'platform-matrix.json')));
  const result = verifyReleaseSet({
    catalog: readJson(resolve(required(args, '--catalog'))),
    trustStore: readJson(resolve(required(args, '--trust-store'))),
    artifactRoot: resolve(required(args, '--artifacts')),
    distribution: args.get('--distribution') ? readJson(resolve(args.get('--distribution'))) : undefined,
    now: args.get('--at') ? new Date(args.get('--at')) : new Date(),
    requiredTargets: matrix.targets.filter(item => item.release === 'required'),
    requiredKernelIds: (args.get('--kernels') ?? 'openclaw,deepseek-harness').split(',').filter(Boolean),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function required(args, name) {
  const value = args.get(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

if (process.argv[1] && existsSync(process.argv[1]) && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
