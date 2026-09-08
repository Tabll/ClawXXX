import { createReadStream, lstatSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { finished } from 'node:stream/promises';
import { canonicalJson, readJson, sha256Bytes } from './canonical.mjs';
import { sha256File } from './tencent-cos.mjs';
import { assertGitHubDistributionTarget } from '../resolve-previous-catalog.mjs';
import { verifyArtifactDescriptor, assertDescriptorDistributionUrl } from '../verify-release-set.mjs';
import { assertCompleteSet, assertSourceDescriptors, artifactIdentity } from './release-policy.mjs';
import { assetNames, recordName, receiptName, retirementFiles, digestJson } from './release-record.mjs';
import { createGitHubReader, githubPages } from './release-gate.mjs';
import { fetchBoundedJson, readBoundedBody } from './release-http.mjs';
import { drillKernelDistribution, probeArtifactMirrors } from '../distribution-drill.mjs';

export function assertReleaseDistribution(policy, distribution) {
  const cosBase = `https://${policy.cos.bucket}.cos.${policy.cos.region}.tencentcos.cn/${policy.cos.rootPrefix}/${policy.cos.kernelPrefix}/`;
  const githubBase = `https://github.com/${policy.repository}/releases/download/${policy.githubReleaseTag}/`;
  assertGitHubDistributionTarget(distribution, policy.repository, policy.githubReleaseTag);
  if (canonicalJson(distribution.mirrorBaseUrls) !== canonicalJson([cosBase, githubBase])
    || canonicalJson(distribution.catalogUrls) !== canonicalJson([`${cosBase}catalog.production.json`, `${githubBase}kernel-catalog.production.json`])) {
    throw new Error('Release distribution differs from the protected COS/GitHub policy');
  }
  return { cosBase, githubBase };
}

export async function loadReleaseAssets(root, { policy, trustStore, distribution, candidate, now = new Date() }) {
  const files = new Map();
  let entryCount = 0;
  const rootStat = lstatSync(resolve(root));
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('Release root must be a private real directory');
  const visit = (directory, depth = 0) => {
    if (depth > 4) throw new Error('Unexpected nested release artifact layout');
    for (const name of readdirSync(directory).sort()) {
      if (++entryCount > 4000) throw new Error('Excessive release artifact entries');
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error('Release artifacts cannot contain links');
      if (stat.isDirectory()) visit(path, depth + 1);
      else if (stat.isFile() && stat.nlink === 1) {
        if (name === 'staging-artifact-trust.json') continue; // Never publish CI-only trust.
        if (files.has(name) || files.size >= 4000) throw new Error('Duplicate or excessive release artifact files');
        files.set(name, { path, size: stat.size });
      } else throw new Error('Release artifacts must be private regular files');
    }
  };
  visit(resolve(root));
  const descriptors = [...files.entries()].filter(([name]) => name.endsWith('.descriptor.json')).map(([, f]) => {
    if (f.size > 256 * 1024) throw new Error('Descriptor exceeds its size budget');
    return readJson(f.path);
  });
  assertCompleteSet(descriptors, policy);
  assertSourceDescriptors(descriptors, candidate.sources);
  const expectedNames = new Set();
  const assets = new Map();
  for (const descriptor of descriptors) {
    verifyArtifactDescriptor(descriptor, trustStore, now);
    assertDescriptorDistributionUrl(descriptor, distribution);
    const expected = retirementFiles({ descriptor });
    for (const item of expected) {
      const file = files.get(item.name);
      if (!file || expectedNames.has(item.name) || file.size !== item.size || await sha256File(file.path) !== item.sha256) {
        throw new Error(`Release asset does not match its signed descriptor: ${item.name}`);
      }
      expectedNames.add(item.name);
      assets.set(item.name, { ...item, path: file.path });
    }
  }
  if (files.size !== expectedNames.size) throw new Error('Release contains unreviewed extra assets');
  return { descriptors, assets };
}

export class GitHubReleaseMirror {
  constructor(policy, { token = process.env.GH_TOKEN, fetcher = fetch } = {}) {
    if (!token) throw new Error('Protected GitHub publishing token is required');
    this.policy = policy;
    this.token = token;
    this.fetcher = fetcher;
    this.api = createGitHubReader(policy, { token, fetcher });
  }

  async ensureRelease() {
    let release = await this.api(`/releases/tags/${encodeURIComponent(this.policy.githubReleaseTag)}`, { allowMissing: true });
    if (!release) release = await this.request('POST', '/releases', {
      tag_name: this.policy.githubReleaseTag, target_commitish: this.policy.branch,
      name: 'ClawX Kernel Runtimes', body: 'Verified immutable optional kernel runtimes and signed publication records.',
      draft: false, prerelease: false, make_latest: 'false',
    });
    if (!Number.isSafeInteger(release.id) || release.tag_name !== this.policy.githubReleaseTag || release.draft || release.immutable === true) {
      throw new Error('GitHub kernel release identity is invalid');
    }
    this.releaseId = release.id;
    return release;
  }

  async assets() {
    if (!this.releaseId) await this.ensureRelease();
    return githubPages(this.api, `/releases/${this.releaseId}/assets`);
  }

  async putImmutable(asset) {
    const existing = (await this.assets()).filter(item => item.name === asset.name);
    if (existing.length > 1) throw new Error('Duplicate immutable GitHub asset identity');
    if (existing.length) {
      if (existing[0].state === 'starter' && existing[0].size === 0 && !existing[0].digest) {
        // GitHub documents an empty starter asset after a failed 502 upload.
        // Only that exact empty reservation is recoverable; never clobber bytes.
        await this.request('DELETE', `/releases/assets/${existing[0].id}`);
      } else {
        this.assertAsset(existing[0], asset);
        return { action: 'unchanged', name: asset.name };
      }
    }
    const uploaded = await this.upload(asset);
    this.assertAsset(uploaded, asset);
    return { action: 'uploaded', name: asset.name };
  }

  async putCatalog(asset) {
    if (asset.name !== 'kernel-catalog.production.json') throw new Error('Only the signed catalog pointer is mutable');
    const existing = (await this.assets()).filter(item => item.name === asset.name);
    if (existing.length > 1) throw new Error('Duplicate GitHub catalog pointer');
    if (existing[0]?.digest === `sha256:${asset.sha256}` && existing[0].size === asset.size) return;
    // GitHub release assets have no overwrite operation. COS has already switched
    // to the complete release; a failed re-upload is resumed from its signed record.
    if (existing[0]) await this.request('DELETE', `/releases/assets/${existing[0].id}`);
    this.assertAsset(await this.upload(asset), asset);
  }

  async deleteImmutable(expected) {
    if (!/^[a-z0-9][a-z0-9-]*-[0-9A-Za-z][0-9A-Za-z._+-]*\+clawx\.[1-9][0-9]*-(darwin|linux|win32)-(arm64|x64)\.(?:tar\.zst(?:\.sha256)?|descriptor\.json)$/.test(expected.name)) {
      throw new Error('Only exact versioned kernel assets may be retired from GitHub');
    }
    const existing = (await this.assets()).filter(item => item.name === expected.name);
    if (existing.length > 1) throw new Error('Ambiguous GitHub retirement asset');
    if (!existing.length) return { action: 'absent', name: expected.name };
    this.assertAsset(existing[0], expected);
    await this.request('DELETE', `/releases/assets/${existing[0].id}`);
    if ((await this.assets()).some(item => item.name === expected.name)) throw new Error('GitHub retirement object still exists');
    return { action: 'deleted', name: expected.name };
  }

  assertAsset(actual, expected) {
    if (actual.name !== expected.name || actual.size !== expected.size || actual.digest !== `sha256:${expected.sha256}`
      || actual.state !== 'uploaded') throw new Error(`Immutable GitHub asset identity differs: ${expected.name}`);
  }

  async upload(asset) {
    if (!this.releaseId) await this.ensureRelease();
    if (basename(asset.name) !== asset.name || !/^[A-Za-z0-9][A-Za-z0-9._+-]+$/.test(asset.name)) throw new Error('Unsafe GitHub upload asset name');
    const stream = createReadStream(asset.path);
    const streamClosed = finished(stream).catch(() => {});
    try {
      const response = await this.fetcher(`https://uploads.github.com/repos/${this.policy.repository}/releases/${this.releaseId}/assets?name=${encodeURIComponent(asset.name)}`, {
        method: 'POST', headers: { ...this.headers(), 'Content-Type': 'application/octet-stream', 'Content-Length': String(asset.size) },
        body: stream, duplex: 'half', redirect: 'error', signal: AbortSignal.timeout(15 * 60_000),
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`GitHub asset upload failed (${response.status}): ${asset.name}`); }
      return JSON.parse((await readBoundedBody(response, 1024 * 1024)).toString('utf8'));
    } finally { stream.destroy(); await streamClosed; }
  }

  async request(method, path, body) {
    if (!/^\/(?:releases(?:\/assets\/[1-9][0-9]*)?)$/.test(path)) throw new Error('Unsafe GitHub release mutation endpoint');
    const response = await this.fetcher(`https://api.github.com/repos/${this.policy.repository}${path}`, {
      method, headers: { ...this.headers(), 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`GitHub release operation failed (${response.status})`); }
    if (response.status === 204) { await response.body?.cancel(); return undefined; }
    return JSON.parse((await readBoundedBody(response, 1024 * 1024)).toString('utf8'));
  }
  headers() { return { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }; }
}

export class ProductionReleaseIO {
  constructor({ policy, distribution, trustStore, cos, github, assets = new Map(), evidenceDir, fetcher = fetch }) {
    Object.assign(this, { policy, distribution, trustStore, cos, github, assets, evidenceDir, fetcher });
    Object.assign(this, assertReleaseDistribution(policy, distribution));
    mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  }
  async readCatalogs() { return Promise.all(this.distribution.catalogUrls.map(url => this.publicJson(url))); }
  async readRecord(sequence) { return this.readMirroredMetadata(recordName(sequence)); }
  async readReceipt(item) { return this.readMirroredMetadata(receiptName(item)); }
  async readMirroredMetadata(name) {
    const values = await Promise.all([`${this.cosBase}metadata/${name}`, `${this.githubBase}${name}`].map(url => this.publicJson(url)));
    const found = values.filter(Boolean);
    if (found.length === 2 && canonicalJson(found[0]) !== canonicalJson(found[1])) throw new Error('Immutable publication metadata mirrors diverged');
    return found[0];
  }
  publicJson(url) {
    return fetchBoundedJson(url, { fetcher: this.fetcher, allowMissing: true, redirect: 'follow', maxBytes: 8 * 1024 * 1024,
      headers: { 'Cache-Control': 'no-cache, no-store' } });
  }
  async writeRecord(record) { await this.writeMirroredMetadata(recordName(record.sequence), record); }
  async writeReceipt(item, receipt) { await this.writeMirroredMetadata(receiptName(item), receipt); }
  async writeMirroredMetadata(name, value) {
    const asset = this.jsonAsset(name, value);
    await this.cosOperation(() => this.cos.putImmutable(asset.path, `${this.policy.cos.kernelPrefix}/metadata/${name}`));
    await this.github.putImmutable(asset);
  }
  async uploadAssets(catalog) {
    for (const descriptor of catalog.artifacts) for (const name of assetNames(descriptor)) {
      const asset = this.assets.get(name);
      if (!asset) throw new Error(`Missing exact approved upload asset: ${name}`);
      await this.cosOperation(() => this.cos.putImmutable(asset.path, `${this.policy.cos.kernelPrefix}/${name}`));
      await this.github.putImmutable(asset);
    }
  }
  async writeCatalog(catalog) {
    const asset = this.jsonAsset('kernel-catalog.production.json', catalog);
    await this.cosOperation(() => this.cos.putMutable(asset.path, `${this.policy.cos.kernelPrefix}/catalog.production.json`));
    await this.github.putCatalog(asset);
  }
  async verifyOnline(catalog, checkCatalogs) {
    const input = { distribution: this.distribution, trustStore: this.trustStore, kernelIds: this.policy.kernelIds,
      targets: this.policy.targets, fetcher: this.fetcher, now: new Date(), catalog, expectedCatalog: catalog };
    const result = checkCatalogs ? await drillKernelDistribution(input) : { artifacts: await probeArtifactMirrors(input) };
    this.jsonAsset(`online-${catalog.sequence}-${checkCatalogs ? 'catalog' : 'assets'}.json`, result);
    return result;
  }
  async deleteRetirement(item, currentCatalog) {
    if (currentCatalog.artifacts.some(d => artifactIdentity(d) === item.identity)) throw new Error('Cannot delete an active artifact');
    const activeNames = new Set(currentCatalog.artifacts.flatMap(assetNames));
    await this.cosOperation(() => this.cos.verifyBucket({ requireUnversioned: true }));
    for (const file of retirementFiles(item)) {
      if (activeNames.has(file.name)) throw new Error('Retirement collides with a current object');
      const live = await this.readCatalogs();
      if (live.some(c => !c || digestJson(c) !== digestJson(currentCatalog))) throw new Error('Catalog changed before retirement deletion');
      await this.cosOperation(() => this.cos.deleteKernelArtifact(`${this.policy.cos.kernelPrefix}/${file.name}`, file, this.policy.cos.kernelPrefix));
      await this.github.deleteImmutable(file);
    }
  }
  jsonAsset(name, value) {
    if (basename(name) !== name) throw new Error('Unsafe publication evidence filename');
    const bytes = Buffer.from(`${canonicalJson(value)}\n`);
    const path = join(this.evidenceDir, name);
    writeFileSync(path, bytes, { mode: 0o600 });
    return { name, path, size: bytes.length, sha256: sha256Bytes(bytes) };
  }
  async cosOperation(operation) {
    try { return await operation(); }
    catch (error) {
      // SDK error objects can include signed request headers. Never serialize them.
      if (error?.statusCode || error?.code) throw new Error(`Tencent COS operation failed (${String(error.statusCode ?? '')}/${String(error.code ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0,64)})`);
      throw new Error(error instanceof Error ? error.message : 'Tencent COS operation failed');
    }
  }
}
