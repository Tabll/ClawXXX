import { generateKeyPairSync } from 'node:crypto';
import { loadReleasePolicy, artifactIdentity } from '../../../scripts/kernel-runtime/lib/release-policy.mjs';
import { canonicalJson, sha256Bytes } from '../../../scripts/kernel-runtime/lib/canonical.mjs';
import { signCanonical } from '../../../scripts/kernel-runtime/lib/signing.mjs';
import { assetNames } from '../../../scripts/kernel-runtime/lib/release-record.mjs';

export function releaseFixture() {
  const policy = loadReleasePolicy();
  const now = new Date('2026-09-08T00:00:00.000Z');
  const pairs = Object.fromEntries(['artifact', 'catalog'].map(purpose => [purpose, generateKeyPairSync('ed25519')]));
  const privateKeys = Object.fromEntries(Object.entries(pairs).map(([id, pair]) => [id, pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()]));
  const trustStore = { schemaVersion: 1, keys: Object.entries(pairs).map(([id, pair]) => ({
    keyId: id, algorithm: 'Ed25519', purposes: [id], publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    notBefore: '2026-01-01T00:00:00.000Z', notAfter: '2028-01-01T00:00:00.000Z',
  })) };
  const cosBase = `https://${policy.cos.bucket}.cos.${policy.cos.region}.tencentcos.cn/${policy.cos.rootPrefix}/${policy.cos.kernelPrefix}/`;
  const githubBase = `https://github.com/${policy.repository}/releases/download/${policy.githubReleaseTag}/`;
  const distribution = { schemaVersion: 1, channel: 'production', mirrorBaseUrls: [cosBase, githubBase],
    catalogUrls: [`${cosBase}catalog.production.json`, `${githubBase}kernel-catalog.production.json`] };
  const signed = (value, field = 'descriptorSignature', purpose = 'artifact') => ({ ...value,
    [field]: signCanonical(value, privateKeys[purpose], purpose) });
  const candidate = (revision = 1) => ({ schemaVersion: 1, repository: policy.repository,
    sourceSha: String(revision).padStart(40, 'a'), stagingRunId: 100 + revision, stagingAttempt: 1,
    e2eRunId: 200 + revision, e2eAttempt: 1,
    sources: Object.fromEntries(policy.kernelIds.map(id => [id, { sha256: sha256Bytes(`${id}/${revision}`),
      artifactVersion: `1.0.0+clawx.${revision}`, upstreamCommit: 'b'.repeat(40), patchRevision: revision }])), artifacts: [] });
  const archiveBytes = (kernelId, target, revision = 1) => Buffer.from(`${kernelId}/${target.platform}/${target.arch}/${revision}`.padEnd(4096, 'x'));
  const descriptors = (revision = 1) => policy.kernelIds.flatMap(kernelId => policy.targets.map(target => {
    const source = candidate(revision).sources[kernelId];
    return signed({ schemaVersion: 1, kernelId, ...target, artifactVersion: source.artifactVersion,
      patchRevision: revision, upstreamCommit: source.upstreamCommit, supplyChain: { sourceSha256: source.sha256 },
      storage: { authority: 'clawx-data-service', nativeDurableHistory: false },
      publishedAt: '2026-09-01T00:00:00.000Z', expiresAt: '2027-03-01T00:00:00.000Z',
      archive: { format: 'tar.zst', url: `${cosBase}${kernelId}-${source.artifactVersion}-${target.platform}-${target.arch}.tar.zst`,
        sha256: sha256Bytes(archiveBytes(kernelId, target, revision)), compressedSize: 4096 },
    });
  }));
  const io = memoryReleaseIO();
  const input = (revision = 1, time = now) => ({ io, policy, trustStore, distribution, candidate: candidate(revision),
    descriptors: descriptors(revision), signingKey: privateKeys.catalog, signingKeyId: 'catalog', now: time });
  return { policy, trustStore, distribution, now, signed, candidate, descriptors, archiveBytes, io, input, privateKeys };
}

export function memoryReleaseIO() {
  return {
    catalogs: [undefined, undefined], records: new Map(), receipts: new Map(), events: [], deleted: [],
    async readCatalogs() { return structuredClone(this.catalogs); },
    async readRecord(n) { return this.records.get(n); },
    async readReceipt(item) { return this.receipts.get(item.identity); },
    async writeRecord(record) {
      this.events.push(`record:${record.sequence}`);
      if (this.records.has(record.sequence) && canonicalJson(this.records.get(record.sequence)) !== canonicalJson(record)) throw new Error('Immutable record conflict');
      this.records.set(record.sequence, structuredClone(record));
    },
    async uploadAssets(catalog) { this.events.push(`upload:${catalog.sequence}`); },
    async verifyOnline(catalog, pointers) { this.events.push(`${pointers ? 'live' : 'assets'}:${catalog.sequence}`); },
    async writeCatalog(catalog) { this.events.push(`catalog:${catalog.sequence}`); this.catalogs = [structuredClone(catalog), structuredClone(catalog)]; },
    async deleteRetirement(item, catalog) {
      if (catalog.artifacts.some(d => artifactIdentity(d) === item.identity)) throw new Error('Active artifact deletion');
      this.events.push(`delete:${item.identity}`);
      this.deleted.push(...assetNames(item.descriptor));
    },
    async writeReceipt(item, receipt) { this.events.push(`receipt:${item.identity}`); this.receipts.set(item.identity, receipt); },
  };
}
