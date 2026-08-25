#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalJson, readJson } from './lib/canonical.mjs';
import { verifyCatalogEnvelope } from './verify-release-set.mjs';

export async function drillKernelDistribution(input) {
  const distribution = input.distribution;
  const probeAttempts = input.probeAttempts ?? 6;
  const retryDelayMs = input.retryDelayMs ?? 5_000;
  const { acceptedCatalog, catalogResults } = await retryProbe(
    () => probeCatalogMirrors({ ...input, distribution }),
    probeAttempts,
    retryDelayMs,
  );

  const artifactResults = [];
  for (const kernelId of input.kernelIds) {
    const candidates = acceptedCatalog.artifacts.filter(item => (
      item.kernelId === kernelId && item.platform === input.platform && item.arch === input.arch
    )).sort((left, right) => right.publishedAt.localeCompare(left.publishedAt));
    const descriptor = candidates[0];
    if (!descriptor) throw new Error(`Catalog has no ${kernelId} artifact for ${input.platform}-${input.arch}`);
    const filename = basename(new URL(descriptor.archive.url).pathname);
    const urls = [...new Set([
      descriptor.archive.url,
      ...distribution.mirrorBaseUrls.map(base => `${base.replace(/\/$/, '')}/${filename}`),
    ])];
    const successes = [];
    for (const url of urls) {
      assertProductionUrl(url, input.allowHttp);
      try {
        const probe = await retryProbe(async () => {
          const first = await range(input.fetcher, url, 0, 1023);
          const second = await range(input.fetcher, url, 1024, 2047, first.etag);
          return { first, second };
        }, probeAttempts, retryDelayMs);
        successes.push({ url, ...probe });
      } catch (error) {
        successes.push({ url, error: error instanceof Error ? error.message : String(error) });
      }
    }
    const liveHosts = new Set(successes.filter(item => !item.error).map(item => new URL(item.url).host));
    if (liveHosts.size < 2) throw new Error(`${kernelId} does not have two live range-capable distribution hosts`);
    artifactResults.push({ kernelId, artifactVersion: descriptor.artifactVersion, probes: successes });
  }
  return { schemaVersion: 1, ok: true, catalogSequence: acceptedCatalog.sequence, catalogs: catalogResults, artifacts: artifactResults };
}

async function probeCatalogMirrors(input) {
  const catalogResults = [];
  let acceptedCatalog;
  for (const url of input.distribution.catalogUrls) {
    assertProductionUrl(url, input.allowHttp);
    const response = await input.fetcher(url, { headers: { 'cache-control': 'no-cache' }, redirect: 'follow' });
    if (!response.ok) throw new Error(`Catalog probe failed ${response.status}: ${url}`);
    const catalog = verifyCatalogEnvelope(await response.json(), input.trustStore, input.now);
    if (acceptedCatalog && (catalog.sequence !== acceptedCatalog.sequence || canonicalJson(catalog) !== canonicalJson(acceptedCatalog))) {
      throw new Error('Catalog mirrors do not serve the exact same signed sequence');
    }
    acceptedCatalog = catalog;
    const validator = response.headers.get('etag') ?? response.headers.get('last-modified');
    if (!validator) throw new Error(`Catalog does not expose ETag or Last-Modified: ${url}`);
    const conditional = await input.fetcher(url, {
      headers: response.headers.get('etag')
        ? { 'if-none-match': response.headers.get('etag') }
        : { 'if-modified-since': response.headers.get('last-modified') },
      redirect: 'follow',
    });
    if (conditional.status !== 304 && !conditional.ok) throw new Error(`Catalog conditional probe failed: ${url}`);
    catalogResults.push({ url, status: response.status, validator, conditionalStatus: conditional.status });
  }
  if (!acceptedCatalog) throw new Error('No production catalog was available');
  return { acceptedCatalog, catalogResults };
}

async function retryProbe(operation, attempts, delayMs) {
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 20) throw new Error('Invalid distribution probe attempt count');
  if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 60_000) throw new Error('Invalid distribution probe delay');
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

async function range(fetcher, url, start, end, etag) {
  const headers = { range: `bytes=${start}-${end}`, ...(etag ? { 'if-range': etag } : {}) };
  const response = await fetcher(url, { headers, redirect: 'follow' });
  if (response.status !== 206 || !response.headers.get('content-range')) {
    throw new Error(`Range ${start}-${end} was not honored (${response.status})`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== end - start + 1) throw new Error(`Range returned ${bytes.byteLength} bytes`);
  return { status: response.status, bytes: bytes.byteLength, etag: response.headers.get('etag') ?? undefined };
}

function assertProductionUrl(url, allowHttp) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && !(allowHttp && parsed.protocol === 'http:')) {
    throw new Error(`Distribution drill requires HTTPS: ${url}`);
  }
}

async function main() {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
  const distribution = readJson(resolve(required(args, '--distribution')));
  const result = await drillKernelDistribution({
    distribution,
    trustStore: readJson(resolve(required(args, '--trust-store'))),
    kernelIds: (args.get('--kernels') ?? 'openclaw,deepseek-harness').split(',').filter(Boolean),
    platform: args.get('--platform') ?? process.platform,
    arch: args.get('--arch') ?? process.arch,
    now: args.get('--at') ? new Date(args.get('--at')) : new Date(),
    fetcher: fetch,
    allowHttp: false,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function required(args, name) {
  const value = args.get(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

if (process.argv[1] && existsSync(process.argv[1]) && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
