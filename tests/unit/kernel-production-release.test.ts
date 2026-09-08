// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { releaseFixture } from '../fixtures/kernels/release-fixture.mjs';
import { publishRuntimeRelease, cleanRetiredRuntimes } from '../../scripts/kernel-runtime/lib/release-publication.mjs';
import { createReleaseRecord, digestJson, HOUR, verifyReleaseRecord } from '../../scripts/kernel-runtime/lib/release-record.mjs';

describe('protected latest-only runtime release transaction', () => {
  it('requires explicit bootstrap, then journals and uploads before switching both catalogs', async () => {
    const f = releaseFixture();
    await expect(publishRuntimeRelease(f.input())).rejects.toThrow(/explicitly approved bootstrap/);
    expect(f.io.events).toEqual([]);
    await expect(publishRuntimeRelease({ ...f.input(), bootstrap: true })).resolves.toMatchObject({ mode: 'published', sequence: 1 });
    expect(f.io.events.slice(0, 5)).toEqual(['record:1', 'upload:1', 'assets:1', 'catalog:1', 'live:1']);
    expect(f.io.catalogs[0]).toEqual(f.io.catalogs[1]);
    expect(f.io.catalogs[0].artifacts).toHaveLength(10);
    expect(f.io.deleted).toEqual([]);
  });

  it.each(['missing target', 'mixed version', 'source mismatch', 'bad signature'])('fails before all writes for %s', async failure => {
    const f = releaseFixture();
    const input = { ...f.input(), bootstrap: true };
    if (failure === 'missing target') input.descriptors.pop();
    if (failure === 'mixed version') input.descriptors[0] = f.descriptors(2)[0];
    if (failure === 'source mismatch') input.candidate.sources.openclaw.sha256 = 'f'.repeat(64);
    if (failure === 'bad signature') input.descriptors[0].archive.sha256 = 'f'.repeat(64);
    await expect(publishRuntimeRelease(input)).rejects.toThrow();
    expect(f.io.events).toEqual([]);
  });

  it('duplicate completion verifies without minting another sequence or uploading bytes', async () => {
    const f = releaseFixture();
    await publishRuntimeRelease({ ...f.input(), bootstrap: true });
    f.io.events = [];
    await expect(publishRuntimeRelease(f.input())).resolves.toMatchObject({ mode: 'already-published', sequence: 1 });
    expect(f.io.events).toEqual(['record:1', 'live:1', 'live:1']);
  });

  it('replaces only the latest set and preserves old packages through catalog expiry plus download grace', async () => {
    const f = releaseFixture();
    await publishRuntimeRelease({ ...f.input(), bootstrap: true });
    const old = f.io.catalogs[0];
    const later = new Date(f.now.getTime() + 24 * HOUR);
    const result = await publishRuntimeRelease(f.input(2, later));
    expect(result.cleanup.deferred).toHaveLength(10);
    expect(f.io.catalogs[0].artifacts).toHaveLength(10);
    expect(f.io.catalogs[0].artifacts.every(d => d.patchRevision === 2)).toBe(true);
    expect(f.io.catalogs[0].revokedArtifactIdentities).toEqual([]);
    expect(f.io.records.get(2).previousCatalogSha256).toBe(digestJson(old));
    expect(f.io.records.get(2).retirements[0].deleteAfter).toBe(new Date(Date.parse(old.expiresAt) + 24 * HOUR).toISOString());
    expect(f.io.deleted).toEqual([]);
  });

  it('rejects an out-of-order revision or changed bytes under the same published revision', async () => {
    const f = releaseFixture();
    await publishRuntimeRelease({ ...f.input(2), bootstrap: true });
    await expect(publishRuntimeRelease(f.input(1, new Date(f.now.getTime() + HOUR)))).rejects.toThrow(/Stale artifact revision/);
    const input = f.input(2, new Date(f.now.getTime() + HOUR));
    const { descriptorSignature: _sig, ...unsigned } = input.descriptors[0];
    input.descriptors[0] = f.signed({ ...unsigned, expiresAt: '2027-02-01T00:00:00.000Z' });
    await expect(publishRuntimeRelease(input)).rejects.toThrow(/cannot be overwritten/);
  });

  it.each(['record', 'upload', 'preflight'])('recovers a crash at %s using exact reserved bytes', async phase => {
    const f = releaseFixture();
    const key = phase === 'record' ? 'writeRecord' : phase === 'upload' ? 'uploadAssets' : 'verifyOnline';
    const original = f.io[key].bind(f.io);
    vi.spyOn(f.io, key).mockImplementationOnce(async (...args) => {
      if (phase === 'record') await original(...args);
      throw new Error('injected crash');
    });
    await expect(publishRuntimeRelease({ ...f.input(), bootstrap: true })).rejects.toThrow(/injected crash/);
    const reserved = structuredClone(f.io.records.get(1));
    expect(f.io.catalogs).toEqual([undefined, undefined]);
    expect(f.io.deleted).toEqual([]);
    await publishRuntimeRelease({ ...f.input(1, new Date(f.now.getTime() + HOUR)), bootstrap: true });
    expect(f.io.catalogs[0]).toEqual(reserved.catalog);
    expect(f.io.records.size).toBe(1);
  });

  it.each(['N/N-1', 'N/404'])('recovers %s after a non-bootstrap catalog switch', async state => {
    const f = releaseFixture();
    await publishRuntimeRelease({ ...f.input(), bootstrap: true });
    vi.spyOn(f.io, 'writeCatalog').mockImplementationOnce(async catalog => {
      f.io.catalogs[0] = structuredClone(catalog);
      if (state === 'N/404') f.io.catalogs[1] = undefined;
      throw new Error('interrupted catalog upload');
    });
    const time = new Date(f.now.getTime() + HOUR);
    await expect(publishRuntimeRelease(f.input(2, time))).rejects.toThrow(/interrupted/);
    const reserved = structuredClone(f.io.records.get(2));
    await expect(publishRuntimeRelease(f.input(3, time))).rejects.toThrow(/Retry candidate differs/);
    await expect(publishRuntimeRelease({ ...f.input(2, time), candidate: undefined, descriptors: undefined })).rejects.toThrow(/original accepted candidate/);
    await expect(publishRuntimeRelease(f.input(2, time))).resolves.toMatchObject({ mode: 'resumed-publication', sequence: 2 });
    expect(f.io.catalogs).toEqual([reserved.catalog, reserved.catalog]);
    expect(f.io.deleted).toEqual([]);
  });

  it('cannot change a reserved candidate before the first pointer has switched', async () => {
    const f = releaseFixture();
    vi.spyOn(f.io, 'uploadAssets').mockRejectedValueOnce(new Error('upload interrupted'));
    await expect(publishRuntimeRelease({ ...f.input(), bootstrap: true })).rejects.toThrow();
    await expect(publishRuntimeRelease({ ...f.input(2), bootstrap: true })).rejects.toThrow(/Retry candidate differs/);
    const changedE2E = { ...f.input(), bootstrap: true };
    changedE2E.candidate.e2eAttempt += 1;
    await expect(publishRuntimeRelease(changedE2E)).rejects.toThrow(/Retry candidate differs/);
  });

  it('refuses same-sequence forks and unknown legacy catalogs without signed journals', async () => {
    const f = releaseFixture();
    await publishRuntimeRelease({ ...f.input(), bootstrap: true });
    const { catalogSignature: _sig, ...unsigned } = f.io.catalogs[1];
    f.io.catalogs[1] = f.signed({ ...unsigned, revokedArtifactIdentities: ['old/version/linux-x64'] }, 'catalogSignature', 'catalog');
    await expect(publishRuntimeRelease(f.input())).rejects.toThrow(/same-sequence fork/);
    f.io.catalogs[1] = f.io.catalogs[0];
    f.io.records.clear();
    await expect(publishRuntimeRelease(f.input())).rejects.toThrow(/manual reconciliation/);
  });

  it('aborts before switching when a concurrent publisher changes the observed catalog', async () => {
    const f = releaseFixture();
    await publishRuntimeRelease({ ...f.input(), bootstrap: true });
    vi.spyOn(f.io, 'uploadAssets').mockImplementationOnce(async () => {
      const other = createReleaseRecord({ ...f.input(3, new Date(f.now.getTime() + HOUR)), source: f.candidate(3),
        previousCatalog: f.io.catalogs[0], previousRecord: f.io.records.get(1) });
      f.io.catalogs = [other.catalog, other.catalog];
    });
    await expect(publishRuntimeRelease(f.input(2, new Date(f.now.getTime() + HOUR)))).rejects.toThrow(/Catalog changed/);
    expect(f.io.deleted).toEqual([]);
  });

  it('does not clean anything if online verification after switching fails', async () => {
    const f = releaseFixture();
    await publishRuntimeRelease({ ...f.input(), bootstrap: true });
    vi.spyOn(f.io, 'verifyOnline').mockImplementation(async (_catalog, pointers) => {
      if (pointers) throw new Error('live mirror unavailable');
    });
    await expect(publishRuntimeRelease(f.input(2, new Date(f.now.getTime() + 9 * 24 * HOUR)))).rejects.toThrow(/unavailable/);
    expect(f.io.deleted).toEqual([]);
  });

  it('renews only metadata and idempotently resumes due cleanup after deletion interruption', async () => {
    const f = releaseFixture();
    await publishRuntimeRelease({ ...f.input(), bootstrap: true });
    await publishRuntimeRelease(f.input(2, new Date(f.now.getTime() + HOUR)));
    const due = new Date(f.now.getTime() + 8 * 24 * HOUR);
    const maintain = { ...f.input(2, due), candidate: undefined, descriptors: undefined };
    vi.spyOn(f.io, 'writeReceipt').mockRejectedValueOnce(new Error('receipt interrupted'));
    f.io.events = [];
    await expect(publishRuntimeRelease(maintain)).rejects.toThrow(/receipt interrupted/);
    expect(f.io.records.size).toBe(3);
    expect(f.io.events.some(e => e.startsWith('upload:'))).toBe(false);
    const result = await publishRuntimeRelease(maintain);
    expect(result.sequence).toBe(3);
    expect(result.cleanup.deleted).toHaveLength(10);
    expect(f.io.receipts.size).toBe(10);
    expect(f.io.deleted.every(name => name.includes('+clawx.1-'))).toBe(true);
    const before = f.io.deleted.length;
    await publishRuntimeRelease(maintain);
    expect(f.io.deleted.length).toBe(before);
    f.io.events = [];
    await publishRuntimeRelease({ ...maintain, now: new Date(due.getTime() + 6 * 24 * HOUR) });
    expect(f.io.records.get(4).retirements).toEqual([]);
    expect(f.io.events.slice(0, 10).every(e => e.startsWith('receipt:'))).toBe(true);
  });

  it('never cleans current objects even with an otherwise valid signer', async () => {
    const f = releaseFixture();
    await publishRuntimeRelease({ ...f.input(), bootstrap: true });
    await publishRuntimeRelease(f.input(2, new Date(f.now.getTime() + HOUR)));
    const { releaseSignature: _sig, ...unsigned } = f.io.records.get(2);
    const active = f.io.catalogs[0].artifacts[0];
    const bad = f.signed({ ...unsigned, retirements: [{ ...unsigned.retirements[0], descriptor: active,
      identity: `${active.kernelId}/${active.artifactVersion}/${active.platform}-${active.arch}` }] }, 'releaseSignature', 'catalog');
    await expect(cleanRetiredRuntimes({ ...f.input(2, new Date(f.now.getTime() + HOUR)), record: bad })).rejects.toThrow(/currently active/);
    expect(f.io.deleted).toEqual([]);
  });

  it('preserves revocations through latest-only replacement and caps metadata by artifact expiry', () => {
    const f = releaseFixture();
    const first = createReleaseRecord({ ...f.input(), source: f.candidate() });
    const { catalogSignature: _sig, ...unsigned } = first.catalog;
    const previous = f.signed({ ...unsigned, revokedArtifactIdentities: ['retired/1+clawx.1/linux-x64'] }, 'catalogSignature', 'catalog');
    const time = new Date('2027-02-28T20:00:00.000Z');
    const next = createReleaseRecord({ ...f.input(2, time), source: f.candidate(2), previousCatalog: previous, previousRecord: first });
    expect(next.catalog.expiresAt).toBe('2027-03-01T00:00:00.000Z');
    expect(next.catalog.revokedArtifactIdentities).toEqual(previous.revokedArtifactIdentities);
    expect(() => createReleaseRecord({ ...f.input(2, new Date('2027-02-28T23:30:00Z')), source: f.candidate(2) })).toThrow(/at least one more catalog hour/);
    expect(() => verifyReleaseRecord({ ...next, artifactsSha256: '0'.repeat(64) }, { ...f.input(2, time) })).toThrow(/verification failed/);
  });

  it('never shortens retention when a later catalog has a shorter validity window', () => {
    const f = releaseFixture();
    const first = createReleaseRecord({ ...f.input(), source: f.candidate() });
    const policy = { ...f.policy, catalogLifetimeHours: 48, renewBeforeHours: 24 };
    const renewed = createReleaseRecord({ ...f.input(1, new Date(f.now.getTime() + 24 * HOUR)), policy,
      source: f.candidate(), previousCatalog: first.catalog, previousRecord: first });
    expect(Date.parse(renewed.catalog.expiresAt)).toBeLessThan(Date.parse(first.catalog.expiresAt));
    const next = createReleaseRecord({ ...f.input(2, new Date(f.now.getTime() + 48 * HOUR)), policy,
      source: f.candidate(2), previousCatalog: renewed.catalog, previousRecord: renewed });
    expect(next.retirements.every(item => item.lastCatalogExpiresAt === first.catalog.expiresAt)).toBe(true);
    expect(next.retirements[0].deleteAfter).toBe(new Date(Date.parse(first.catalog.expiresAt) + 24 * HOUR).toISOString());
  });

  it('validates historical matrix snapshots when a future release adds a third kernel', async () => {
    const f = releaseFixture();
    await publishRuntimeRelease({ ...f.input(), bootstrap: true });
    const policy = { ...f.policy, kernelIds: [...f.policy.kernelIds, 'future-engine'] };
    const input = f.input(2, new Date(f.now.getTime() + HOUR));
    input.candidate.sources['future-engine'] = input.candidate.sources.openclaw;
    input.descriptors.push(...input.descriptors.filter(d => d.kernelId === 'openclaw').map(d => {
      const { descriptorSignature: _sig, ...unsigned } = d;
      return f.signed({ ...unsigned, kernelId: 'future-engine', archive: { ...d.archive,
        url: d.archive.url.replace('/openclaw-', '/future-engine-') } });
    }));
    const result = await publishRuntimeRelease({ ...input, policy });
    expect(result.sequence).toBe(2);
    expect(f.io.catalogs[0].artifacts).toHaveLength(15);
    expect(f.io.records.get(1).releaseMatrix.kernelIds).toHaveLength(2);
    expect(f.io.records.get(2).releaseMatrix.kernelIds).toHaveLength(3);
  });
});
