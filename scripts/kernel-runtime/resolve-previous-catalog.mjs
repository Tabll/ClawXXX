#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalJson, readJson, sha256Bytes } from './lib/canonical.mjs';
import { verifyCatalogEnvelope } from './verify-release-set.mjs';

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 2_000;

/**
 * Resolve the exact signed production catalog that a monotonic promotion must
 * extend. Both configured mirrors are authoritative: a mismatch or partial
 * outage fails closed instead of letting an operator reset or fork sequence.
 *
 * Historical catalogs are verified at their own issue instant. This preserves
 * signature continuity after normal expiry while still proving that every key
 * and artifact was valid when the catalog became authoritative.
 */
export async function resolvePreviousProductionCatalog(input) {
  const nextSequence = Number(input.nextSequence);
  if (!Number.isSafeInteger(nextSequence) || nextSequence < 1) {
    throw new Error('Next production catalog sequence must be a positive integer');
  }
  const urls = input.distribution?.catalogUrls;
  if (!Array.isArray(urls) || urls.length < 2 || new Set(urls).size !== urls.length) {
    throw new Error('Production catalog continuity requires at least two distinct catalog mirrors');
  }
  if (input.expectedGitHubRepository || input.githubReleaseTag) {
    assertGitHubDistributionTarget(input.distribution, input.expectedGitHubRepository, input.githubReleaseTag);
  }
  for (const url of urls) assertHttps(url);
  const fetcher = input.fetcher ?? fetch;
  const attempts = input.attempts ?? DEFAULT_ATTEMPTS;
  const retryDelayMs = input.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 10) {
    throw new Error('Catalog continuity attempts must be between 1 and 10');
  }
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 30_000) {
    throw new Error('Catalog continuity retry delay must be between 0 and 30000 ms');
  }

  if (nextSequence === 1 && input.bootstrap !== true) {
    throw new Error('Sequence 1 requires explicit protected bootstrap authorization');
  }
  const expectedSequence = nextSequence - 1;
  const observedAt = input.now ?? new Date();
  if (!Number.isFinite(observedAt.getTime())) throw new Error('Catalog continuity observation time is invalid');
  const probes = [];
  for (const url of urls) {
    const probe = await retry(async () => {
      const response = await fetcher(url, noCacheRequest());
      if (nextSequence === 1 && (response.status === 404 || response.status === 410)) {
        return { url, status: response.status, state: 'absent' };
      }
      if (!response.ok) throw new Error(`Catalog mirror returned ${response.status}: ${url}`);
      const catalog = await response.json();
      const issuedAtMs = Date.parse(catalog?.issuedAt);
      if (!Number.isFinite(issuedAtMs) || issuedAtMs > observedAt.getTime()) {
        throw new Error(`Previous catalog has an invalid or future issuedAt: ${url}`);
      }
      verifyCatalogEnvelope(catalog, input.trustStore, new Date(issuedAtMs));
      const acceptedSequences = nextSequence === 1 ? [1] : [expectedSequence, nextSequence];
      if (!acceptedSequences.includes(catalog.sequence)) {
        throw new Error(`Expected catalog sequence ${acceptedSequences.join(' or ')}, found ${catalog.sequence}: ${url}`);
      }
      return {
        url,
        catalog,
        status: response.status,
        state: catalog.sequence === nextSequence ? 'published' : 'previous',
        validator: response.headers.get('etag') ?? response.headers.get('last-modified') ?? undefined,
      };
    }, attempts, retryDelayMs);
    probes.push(probe);
  }

  const previous = exactCatalogGroup(probes.filter(probe => probe.state === 'previous'), 'previous');
  const published = exactCatalogGroup(probes.filter(probe => probe.state === 'published'), 'already-published');
  if (published) assertPublishedIntent(published.catalog, input);
  const absent = probes.filter(probe => probe.state === 'absent');
  let mode;
  if (nextSequence === 1) {
    if (absent.length === probes.length) mode = 'bootstrap';
    else if (published && absent.length > 0) mode = 'resume-bootstrap-publication';
    else if (published && absent.length === 0) mode = 'already-published';
    else throw new Error('Sequence 1 mirrors are in an unsupported bootstrap state');
  } else if (previous && !published && previous.count === probes.length) {
    mode = 'continuation';
  } else if (previous && published && previous.count + published.count === probes.length) {
    mode = 'resume-publication';
  } else if (!previous && published && published.count === probes.length) {
    mode = 'already-published';
  } else {
    throw new Error('Production catalog mirrors are in an unsupported sequence state');
  }
  const mirrors = probes.map(probe => {
    if (!probe.catalog) return { url: probe.url, status: probe.status, state: probe.state };
    const serialized = canonicalJson(probe.catalog);
    return {
      url: probe.url,
      status: probe.status,
      state: probe.state,
      sequence: probe.catalog.sequence,
      ...(probe.validator ? { validator: probe.validator } : {}),
      sha256: sha256Bytes(serialized),
    };
  });
  return {
    previousCatalog: previous?.catalog,
    publishedCatalog: published?.catalog,
    evidence: {
      schemaVersion: 1,
      ok: true,
      mode,
      ...(previous ? { previousSequence: expectedSequence, previousCatalogSha256: previous.sha256 } : {}),
      ...(published ? { publishedSequence: nextSequence, publishedCatalogSha256: published.sha256 } : {}),
      nextSequence,
      mirrors,
    },
  };
}

function assertPublishedIntent(catalog, input) {
  if (input.expectedIssuedAt !== undefined
    && new Date(input.expectedIssuedAt).toISOString() !== catalog.issuedAt) {
    throw new Error('Already-published catalog issuedAt does not match this promotion request');
  }
  if (input.expectedExpiresAt !== undefined
    && new Date(input.expectedExpiresAt).toISOString() !== catalog.expiresAt) {
    throw new Error('Already-published catalog expiresAt does not match this promotion request');
  }
  const requiredRevocations = input.requiredRevocations ?? [];
  if (!Array.isArray(requiredRevocations)) throw new Error('Required catalog revocations must be an array');
  const actual = new Set(catalog.revokedArtifactIdentities);
  const missing = requiredRevocations.filter(identity => !actual.has(identity));
  if (missing.length > 0) {
    throw new Error(`Already-published catalog is missing requested revocations: ${missing.join(', ')}`);
  }
}

function exactCatalogGroup(probes, label) {
  if (probes.length === 0) return undefined;
  const canonical = canonicalJson(probes[0].catalog);
  for (const probe of probes.slice(1)) {
    if (canonicalJson(probe.catalog) !== canonical) {
      throw new Error(`Production catalog mirrors expose different signed ${label} catalogs`);
    }
  }
  return { catalog: probes[0].catalog, canonical, sha256: sha256Bytes(canonical), count: probes.length };
}

export function assertGitHubDistributionTarget(distribution, repository, releaseTag) {
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error('Expected GitHub repository must use owner/name form');
  }
  if (typeof releaseTag !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(releaseTag)) {
    throw new Error('Kernel runtime GitHub release tag is invalid');
  }
  const expectedCatalogPath = `/${repository}/releases/download/${releaseTag}/kernel-catalog.production.json`.toLowerCase();
  const expectedBasePath = `/${repository}/releases/download/${releaseTag}/`.toLowerCase();
  const catalogUrls = distribution?.catalogUrls;
  const mirrorBaseUrls = distribution?.mirrorBaseUrls;
  if (!Array.isArray(catalogUrls) || !Array.isArray(mirrorBaseUrls)) {
    throw new Error('Kernel distribution is missing catalog or artifact mirror URLs');
  }
  const githubCatalogs = catalogUrls.map(value => new URL(value)).filter(url => url.hostname.toLowerCase() === 'github.com');
  const githubMirrors = mirrorBaseUrls.map(value => new URL(value)).filter(url => url.hostname.toLowerCase() === 'github.com');
  if (githubCatalogs.length !== 1 || githubCatalogs[0].pathname.toLowerCase() !== expectedCatalogPath) {
    throw new Error(`Production catalog GitHub mirror is not bound to ${repository}@${releaseTag}`);
  }
  if (githubMirrors.length !== 1 || normalizedDirectoryPath(githubMirrors[0].pathname).toLowerCase() !== expectedBasePath) {
    throw new Error(`Production artifact GitHub mirror is not bound to ${repository}@${releaseTag}`);
  }
}

function noCacheRequest() {
  return { headers: { 'cache-control': 'no-cache, no-store' }, redirect: 'follow' };
}

async function retry(operation, attempts, delayMs) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts && delayMs > 0) await new Promise(resolveDelay => setTimeout(resolveDelay, delayMs));
    }
  }
  throw lastError;
}

function assertHttps(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid production catalog URL: ${String(value)}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`Production catalog continuity requires HTTPS: ${value}`);
}

function normalizedDirectoryPath(value) {
  return value.endsWith('/') ? value : `${value}/`;
}

function writeImmutableCanonical(path, value) {
  if (existsSync(path)) throw new Error(`Catalog continuity output is immutable: ${path}`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${canonicalJson(value)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
}

function writeImmutableChecksum(path, value) {
  const checksumPath = `${path}.sha256`;
  if (existsSync(checksumPath)) throw new Error(`Catalog checksum output is immutable: ${checksumPath}`);
  const bytes = `${canonicalJson(value)}\n`;
  writeFileSync(checksumPath, `${sha256Bytes(bytes)}  ${basename(path)}\n`, {
    encoding: 'utf8', mode: 0o600, flag: 'wx',
  });
}

function required(args, name) {
  const value = args.get(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function main() {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
  const output = resolve(required(args, '--output'));
  const publishedOutput = resolve(required(args, '--published-output'));
  const evidence = resolve(required(args, '--evidence'));
  const result = await resolvePreviousProductionCatalog({
    distribution: readJson(resolve(required(args, '--distribution'))),
    trustStore: readJson(resolve(required(args, '--trust-store'))),
    nextSequence: Number.parseInt(required(args, '--sequence'), 10),
    bootstrap: args.get('--bootstrap') === 'true',
    attempts: args.get('--attempts') ? Number.parseInt(args.get('--attempts'), 10) : undefined,
    retryDelayMs: args.get('--retry-delay-ms') ? Number.parseInt(args.get('--retry-delay-ms'), 10) : undefined,
    expectedGitHubRepository: args.get('--github-repository'),
    githubReleaseTag: args.get('--github-release-tag'),
    expectedIssuedAt: args.get('--expected-issued-at'),
    expectedExpiresAt: args.get('--expected-expires-at'),
    requiredRevocations: (args.get('--required-revocations') ?? '').split(',').map(value => value.trim()).filter(Boolean),
  });
  if (result.previousCatalog) writeImmutableCanonical(output, result.previousCatalog);
  if (result.publishedCatalog) {
    writeImmutableCanonical(publishedOutput, result.publishedCatalog);
    writeImmutableChecksum(publishedOutput, result.publishedCatalog);
  }
  writeImmutableCanonical(evidence, result.evidence);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    mode: result.evidence.mode,
    previousSequence: result.previousCatalog?.sequence,
    publishedSequence: result.publishedCatalog?.sequence,
    output: result.previousCatalog ? output : undefined,
    publishedOutput: result.publishedCatalog ? publishedOutput : undefined,
    evidence,
  })}\n`);
}

if (process.argv[1] && existsSync(process.argv[1]) && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
