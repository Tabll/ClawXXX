import { canonicalJson, sha256Bytes, assertExactKeys } from './canonical.mjs';
import { signCanonical } from './signing.mjs';
import { verifyArtifactDescriptor, verifyCatalogEnvelope, verifySignedValue, assertDescriptorDistributionUrl } from '../verify-release-set.mjs';
import { artifactIdentity, artifactSlot, assertCompleteSet, assertSourceDescriptors, validateReleasePolicy, targetKey } from './release-policy.mjs';

export const HOUR = 60 * 60 * 1000;
export const digestJson = value => sha256Bytes(canonicalJson(value));
export const fingerprint = artifacts => digestJson([...artifacts].sort((a, b) => artifactIdentity(a).localeCompare(artifactIdentity(b))));
export const recordName = sequence => `kernel-release-${positiveSequence(sequence)}.json`;
export const receiptName = retirement => `kernel-retirement-${digestJson({ identity: retirement.identity, sha256: retirement.descriptor.archive.sha256 })}.json`;

export function assetNames(descriptor) {
  const name = `${descriptor.kernelId}-${descriptor.artifactVersion}-${descriptor.platform}-${descriptor.arch}`;
  if (!/^[a-z0-9][a-z0-9-]*-[0-9A-Za-z][0-9A-Za-z._+-]{0,191}-(darwin|linux|win32)-(arm64|x64)$/.test(name)) {
    throw new Error('Unsafe immutable runtime asset name');
  }
  const url = new URL(descriptor.archive.url);
  if (url.search || url.hash || url.pathname.split('/').at(-1) !== `${name}.tar.zst`) {
    throw new Error('Descriptor URL does not use the exact immutable versioned asset name');
  }
  return [`${name}.tar.zst`, `${name}.descriptor.json`, `${name}.tar.zst.sha256`];
}

export function retirementFiles(retirement) {
  const d = retirement.descriptor;
  const [archive, descriptor, checksum] = assetNames(d);
  const descriptorBytes = Buffer.from(`${canonicalJson(d)}\n`);
  const checksumBytes = Buffer.from(`${d.archive.sha256}  ${archive}\n`);
  return [
    { name: archive, sha256: d.archive.sha256, size: d.archive.compressedSize },
    { name: descriptor, sha256: sha256Bytes(descriptorBytes), size: descriptorBytes.length },
    { name: checksum, sha256: sha256Bytes(checksumBytes), size: checksumBytes.length },
  ];
}

export function verifyHistoricalCatalog(catalog, trustStore, now) {
  if (!Number.isFinite(Date.parse(catalog?.issuedAt)) || Date.parse(catalog.issuedAt) > now.getTime()) {
    throw new Error('Catalog has an invalid or future issue time');
  }
  return verifyCatalogEnvelope(catalog, trustStore, new Date(catalog.issuedAt));
}

export function verifyReleaseRecord(record, { policy, trustStore, distribution, now = new Date() }) {
  assertExactKeys(record, ['schemaVersion', 'kind', 'sequence', 'issuedAt', 'previousCatalogSha256', 'catalog',
    'source', 'releaseMatrix', 'artifactsSha256', 'activeCatalogExpiry', 'retirements', 'releaseSignature']);
  if (record.schemaVersion !== 1 || record.kind !== 'clawx-kernel-release' || record.sequence !== record.catalog?.sequence
    || record.issuedAt !== record.catalog.issuedAt || Date.parse(record.issuedAt) > now.getTime()) throw new Error('Invalid release record identity');
  positiveSequence(record.sequence);
  if (record.previousCatalogSha256 !== null && !/^[a-f0-9]{64}$/.test(record.previousCatalogSha256)) throw new Error('Invalid catalog predecessor digest');
  verifySignedValue(record, 'releaseSignature', trustStore, 'catalog', new Date(record.issuedAt));
  assertUnrevokedRecordKey(record.releaseSignature.keyId, trustStore, now);
  verifyHistoricalCatalog(record.catalog, trustStore, now);
  assertExactKeys(record.releaseMatrix, ['kernelIds', 'targets']);
  const historicalPolicy = validateReleasePolicy({ ...policy, ...record.releaseMatrix });
  if (historicalPolicy.kernelIds.some(id => !policy.kernelIds.includes(id))
    || historicalPolicy.targets.some(t => !policy.targets.some(current => targetKey(current) === targetKey(t)))) {
    throw new Error('Removing a published kernel or target requires explicit EOL reconciliation');
  }
  // A future policy may add a kernel/target. Historical records must validate
  // against their own signed complete matrix, not require artifacts from the future.
  assertCompleteSet(record.catalog.artifacts, historicalPolicy);
  if (record.artifactsSha256 !== fingerprint(record.catalog.artifacts)) throw new Error('Release artifact-set fingerprint mismatch');
  if (record.source?.repository !== policy.repository || !/^[a-f0-9]{40}$/.test(record.source?.sourceSha)
    || ['stagingRunId', 'stagingAttempt', 'e2eRunId', 'e2eAttempt'].some(key => !Number.isSafeInteger(record.source?.[key]) || record.source[key] < 1)) {
    throw new Error('Release record has no accepted source provenance');
  }
  assertSourceDescriptors(record.catalog.artifacts, record.source.sources ?? {});
  for (const d of record.catalog.artifacts) { assetNames(d); assertDescriptorDistributionUrl(d, distribution); }
  if (!Array.isArray(record.retirements) || record.retirements.length > 1000) throw new Error('Invalid bounded retirement inventory');
  const active = new Set(record.catalog.artifacts.map(artifactIdentity));
  if (!record.activeCatalogExpiry || Object.keys(record.activeCatalogExpiry).length !== active.size
    || Object.entries(record.activeCatalogExpiry).some(([id, expiry]) => !active.has(id)
      || !Number.isFinite(Date.parse(expiry)) || Date.parse(expiry) < Date.parse(record.catalog.expiresAt))) {
    throw new Error('Invalid maximum active-catalog expiry ledger');
  }
  const pending = new Set();
  for (const item of record.retirements) {
    assertExactKeys(item, ['identity', 'descriptor', 'lastCatalogExpiresAt', 'retiredAt', 'deleteAfter']);
    if (item.identity !== artifactIdentity(item.descriptor) || pending.has(item.identity) || active.has(item.identity)) {
      throw new Error('Retirement contains a duplicate or currently active artifact');
    }
    pending.add(item.identity);
    verifyArtifactDescriptor(item.descriptor, trustStore, new Date(item.descriptor.publishedAt));
    assetNames(item.descriptor);
    assertDescriptorDistributionUrl(item.descriptor, distribution);
    const expiry = Date.parse(item.lastCatalogExpiresAt);
    const retired = Date.parse(item.retiredAt);
    const deletion = Date.parse(item.deleteAfter);
    if (![expiry, retired, deletion].every(Number.isFinite) || retired > now.getTime()
      || deletion < Math.max(expiry, retired) + HOUR) throw new Error('Retirement has an unsafe deletion window');
  }
  return record;
}

export function createReleaseRecord({ descriptors, source, previousRecord, previousCatalog, policy, trustStore,
  signingKey, signingKeyId, distribution, now = new Date() }) {
  assertCompleteSet(descriptors, policy);
  const previous = previousCatalog?.artifacts ?? [];
  for (const d of descriptors) {
    verifyArtifactDescriptor(d, trustStore, now);
    assetNames(d);
    assertDescriptorDistributionUrl(d, distribution);
    for (const old of previous.filter(old => artifactSlot(old) === artifactSlot(d))) {
      if (!Number.isSafeInteger(d.patchRevision) || d.patchRevision < old.patchRevision) throw new Error('Stale artifact revision cannot replace a newer release');
      if (d.patchRevision === old.patchRevision && canonicalJson(d) !== canonicalJson(old)) {
        throw new Error('Published artifact revision/identity cannot be overwritten');
      }
    }
  }
  if (previous.some(d => !policy.kernelIds.includes(d.kernelId))) throw new Error('Removing an enabled kernel requires explicit EOL review');
  const issuedMs = now.getTime();
  if (previousCatalog && issuedMs <= Date.parse(previousCatalog.issuedAt)) throw new Error('Catalog issue clock must advance monotonically');
  const catalogKey = trustStore.keys.find(k => k.keyId === signingKeyId);
  const expiresMs = Math.min(issuedMs + policy.catalogLifetimeHours * HOUR,
    Date.parse(catalogKey?.notAfter), ...descriptors.flatMap(d => [Date.parse(d.expiresAt),
      Date.parse(trustStore.keys.find(k => k.keyId === d.descriptorSignature.keyId)?.notAfter)]));
  if (!Number.isFinite(expiresMs) || expiresMs - issuedMs < HOUR) throw new Error('Artifact/key validity cannot support at least one more catalog hour');
  const unsigned = { schemaVersion: 1, channel: 'production', sequence: (previousCatalog?.sequence ?? 0) + 1,
    issuedAt: new Date(issuedMs).toISOString(), expiresAt: new Date(expiresMs).toISOString(),
    artifacts: [...descriptors].sort((a, b) => artifactIdentity(a).localeCompare(artifactIdentity(b))),
    revokedArtifactIdentities: [...(previousCatalog?.revokedArtifactIdentities ?? [])] };
  if (unsigned.artifacts.some(d => unsigned.revokedArtifactIdentities.includes(artifactIdentity(d)))) {
    throw new Error('A revoked artifact cannot be automatically republished');
  }
  const catalog = { ...unsigned, catalogSignature: signCanonical(unsigned, signingKey, signingKeyId) };
  verifyCatalogEnvelope(catalog, trustStore, new Date(issuedMs));
  verifyCatalogEnvelope(catalog, trustStore, new Date(expiresMs - 1));
  const active = new Set(descriptors.map(artifactIdentity));
  // A policy/key change may shorten a later catalog. Keep the MAXIMUM expiry
  // across every previously issued reference, not just the latest pointer.
  const activeCatalogExpiry = Object.fromEntries([...active].sort().map(id => [id,
    new Date(Math.max(Date.parse(catalog.expiresAt), Date.parse(previousRecord?.activeCatalogExpiry?.[id] ?? catalog.expiresAt))).toISOString()]));
  const pending = new Map((previousRecord?.retirements ?? []).map(item => [item.identity, item]));
  for (const d of previous.filter(d => !active.has(artifactIdentity(d)))) {
    const lastCatalogExpiresAt = previousRecord?.activeCatalogExpiry?.[artifactIdentity(d)] ?? previousCatalog.expiresAt;
    const item = { identity: artifactIdentity(d), descriptor: d, lastCatalogExpiresAt,
      retiredAt: catalog.issuedAt, deleteAfter: new Date(Math.max(issuedMs, Date.parse(lastCatalogExpiresAt))
        + policy.downloadGraceHours * HOUR).toISOString() };
    if (pending.has(item.identity)) throw new Error('Active predecessor was already marked retired');
    pending.set(item.identity, item);
  }
  const content = { schemaVersion: 1, kind: 'clawx-kernel-release', sequence: catalog.sequence,
    issuedAt: catalog.issuedAt, previousCatalogSha256: previousCatalog ? digestJson(previousCatalog) : null,
    catalog, source, releaseMatrix: { kernelIds: [...policy.kernelIds], targets: policy.targets.map(t => ({ ...t })) },
    artifactsSha256: fingerprint(descriptors), activeCatalogExpiry,
    retirements: [...pending.values()].sort((a, b) => a.identity.localeCompare(b.identity)) };
  const record = { ...content, releaseSignature: signCanonical(content, signingKey, signingKeyId) };
  return verifyReleaseRecord(record, { policy, trustStore, distribution, now: new Date(issuedMs) });
}

export function retirementDue(item, policy, now) {
  return now.getTime() >= Math.max(Date.parse(item.deleteAfter),
    Math.max(Date.parse(item.lastCatalogExpiresAt), Date.parse(item.retiredAt)) + policy.downloadGraceHours * HOUR);
}

export function createRetirementReceipt(item, record, { signingKey, signingKeyId, now = new Date() }) {
  const unsigned = { schemaVersion: 1, kind: 'clawx-kernel-retirement', identity: item.identity,
    archiveSha256: item.descriptor.archive.sha256, releaseRecordSha256: digestJson(record),
    catalogSequence: record.sequence, completedAt: now.toISOString() };
  return { ...unsigned, receiptSignature: signCanonical(unsigned, signingKey, signingKeyId) };
}

export function verifyRetirementReceipt(receipt, item, { trustStore, now = new Date() }) {
  assertExactKeys(receipt, ['schemaVersion', 'kind', 'identity', 'archiveSha256', 'releaseRecordSha256',
    'catalogSequence', 'completedAt', 'receiptSignature']);
  if (receipt.schemaVersion !== 1 || receipt.kind !== 'clawx-kernel-retirement' || receipt.identity !== item.identity
    || receipt.archiveSha256 !== item.descriptor.archive.sha256 || !/^[a-f0-9]{64}$/.test(receipt.releaseRecordSha256)
    || !Number.isFinite(Date.parse(receipt.completedAt)) || Date.parse(receipt.completedAt) > now.getTime()
    || Date.parse(receipt.completedAt) < Date.parse(item.deleteAfter)) throw new Error('Invalid retirement completion receipt');
  positiveSequence(receipt.catalogSequence);
  verifySignedValue(receipt, 'receiptSignature', trustStore, 'catalog', new Date(receipt.completedAt));
  assertUnrevokedRecordKey(receipt.receiptSignature.keyId, trustStore, now);
  return receipt;
}

function positiveSequence(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid release sequence');
  return value;
}
function assertUnrevokedRecordKey(id, trustStore, now) {
  const key = trustStore.keys.find(k => k.keyId === id);
  if (!key || (key.revokedAt && Date.parse(key.revokedAt) <= now.getTime())) throw new Error('Release record key is revoked');
}
