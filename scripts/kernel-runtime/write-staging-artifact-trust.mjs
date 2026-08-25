#!/usr/bin/env node
import { createPublicKey, verify } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalJson, readJson, writeCanonicalJson } from './lib/canonical.mjs';
import { readPrivateKeyFromEnvironment } from './lib/signing.mjs';

/**
 * Derive the public artifact key used by one protected staging build. This is
 * test-only trust material for the next clean-machine job; it is never a
 * production trust store and cannot sign catalogs or rollback authorizations.
 */
export function buildStagingArtifactTrust(descriptors, privateKeyPem, expectedKeyId) {
  if (!Array.isArray(descriptors) || descriptors.length === 0) {
    throw new Error('At least one signed artifact descriptor is required');
  }
  const publicKey = createPublicKey(privateKeyPem);
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('Staging artifact trust requires Ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const published = [];
  const expires = [];
  for (const descriptor of descriptors) {
    const signature = descriptor?.descriptorSignature;
    if (signature?.algorithm !== 'Ed25519' || signature.keyId !== expectedKeyId) {
      throw new Error(`Descriptor signing key does not match the staging artifact key: ${signature?.keyId ?? 'missing'}`);
    }
    const unsigned = { ...descriptor };
    delete unsigned.descriptorSignature;
    if (!verify(null, Buffer.from(canonicalJson(unsigned)), publicKey, Buffer.from(signature.signature, 'base64url'))) {
      throw new Error(`Descriptor signature does not match the staging artifact private key: ${descriptor.kernelId ?? 'unknown'}`);
    }
    const publishedAt = Date.parse(descriptor.publishedAt);
    const expiresAt = Date.parse(descriptor.expiresAt);
    if (!Number.isFinite(publishedAt) || !Number.isFinite(expiresAt) || expiresAt <= publishedAt) {
      throw new Error('Descriptor time window is invalid');
    }
    published.push(publishedAt);
    expires.push(expiresAt);
  }
  return {
    schemaVersion: 1,
    keys: [{
      keyId: expectedKeyId,
      algorithm: 'Ed25519',
      purposes: ['artifact'],
      publicKeyPem,
      notBefore: new Date(Math.min(...published)).toISOString(),
      notAfter: new Date(Math.max(...expires)).toISOString(),
    }],
  };
}

function descriptorFiles(root) {
  return readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.descriptor.json'))
    .map(entry => join(root, entry.name))
    .sort();
}

function required(args, name) {
  const value = args.get(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function main() {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
  const artifactDir = resolve(required(args, '--artifact-dir'));
  const output = resolve(required(args, '--output'));
  const keyId = process.env.CLAWX_ARTIFACT_SIGNING_KEY_ID;
  if (!keyId) throw new Error('CLAWX_ARTIFACT_SIGNING_KEY_ID is required');
  const privateKey = readPrivateKeyFromEnvironment('CLAWX_ARTIFACT_SIGNING_PRIVATE_KEY_B64');
  const descriptors = descriptorFiles(artifactDir).map(readJson);
  writeCanonicalJson(output, buildStagingArtifactTrust(descriptors, privateKey, keyId));
  process.stdout.write(`${JSON.stringify({ ok: true, descriptors: descriptors.length, output })}\n`);
}

if (process.argv[1] && existsSync(process.argv[1]) && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
