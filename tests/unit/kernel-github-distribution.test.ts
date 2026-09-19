// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KernelArtifactDescriptorV1 } from '../../shared/kernels/catalog';
import { artifactDownloadUrls } from '../../electron/kernels/package-manager/downloader';
import { releaseFixture } from '../fixtures/kernels/release-fixture.mjs';
import { publishRuntimeRelease } from '../../scripts/kernel-runtime/lib/release-publication.mjs';
import { createReleaseRecord, digestJson, HOUR, verifyReleaseRecord } from '../../scripts/kernel-runtime/lib/release-record.mjs';
import { assertPublisherEnvironment } from '../../scripts/kernel-runtime/publish-runtimes.mjs';
import { GitHubReleaseMirror, ProductionReleaseIO, assertReleaseDistribution } from '../../scripts/kernel-runtime/lib/release-backend.mjs';
import { maintenanceHint } from '../../scripts/kernel-runtime/lib/release-maintenance.mjs';

afterEach(() => vi.restoreAllMocks());

describe('GitHub-only kernel transport', () => {
  it('uses configured sources exclusively, handles encoded version names and refuses an empty allowlist', () => {
    const f = releaseFixture();
    const d = f.descriptors()[0] as KernelArtifactDescriptorV1;
    const old = { ...d, archive: { ...d.archive, url: d.archive.url.replace(f.distribution.mirrorBaseUrls[0], f.policy.historicalArtifactBaseUrls[0]) } };
    const urls = artifactDownloadUrls(old, f.distribution.mirrorBaseUrls);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/^https:\/\/github.com\/Tabll\/ClawXXX\/releases\/download\/kernel-runtimes\//);
    expect(urls[0]).toContain('%2Bclawx.1');
    expect(artifactDownloadUrls({ ...old, archive: { ...old.archive, url: old.archive.url.replace('+', '%2B') } }, f.distribution.mirrorBaseUrls)).toEqual(urls);
    expect(() => artifactDownloadUrls(old, [])).toThrow(/No runtime artifact/);
    expect(artifactDownloadUrls(d)).toEqual([d.archive.url]);
    expect(() => artifactDownloadUrls({ ...d, archive: { ...d.archive, url: 'https://example.invalid/a%2Fb.tar.zst' } }, f.distribution.mirrorBaseUrls)).toThrow(/safe filename/);
  });

  it('checks production configuration and CI cannot silently re-enable COS for kernels', () => {
    const f = releaseFixture();
    const config = JSON.parse(readFileSync('resources/kernels/distribution.json', 'utf8'));
    expect(config).toEqual(f.distribution);
    expect(() => assertReleaseDistribution(f.policy, { ...config, mirrorBaseUrls: [...config.mirrorBaseUrls, ...f.policy.historicalArtifactBaseUrls] })).toThrow(/differs/);
    for (const path of ['.github/workflows/kernel-runtime-promote.yml', 'scripts/kernel-runtime/publish-runtimes.mjs', 'scripts/kernel-runtime/lib/release-backend.mjs']) {
      expect(readFileSync(path, 'utf8')).not.toMatch(/TENCENTCLOUD_|TencentCosPublisher|cos-nodejs-sdk/);
    }
    expect(readFileSync('.github/workflows/kernel-runtime-build.yml', 'utf8')).toContain('default: https://github.com/Tabll/ClawXXX/releases/download/kernel-runtimes');
  });

  it('routes journal, catalog, receipt and asset operations only through GitHub', async () => {
    const f = releaseFixture();
    const root = mkdtempSync(join(tmpdir(), 'clawx-github-only-'));
    try {
      const record = createReleaseRecord({ ...f.input(), source: f.candidate() });
      const github = { putImmutable: vi.fn(), putCatalog: vi.fn(), recordSequences: vi.fn().mockResolvedValue([1]) };
      const fetcher = vi.fn(async (url: string) => {
        expect(url.startsWith(f.distribution.mirrorBaseUrls[0])).toBe(true);
        return Response.json(url.endsWith('kernel-catalog.production.json') ? record.catalog : record);
      });
      const io = new ProductionReleaseIO({ ...f.input(), github, evidenceDir: root, fetcher });
      expect(await io.readRecordSequences()).toEqual([1]);
      expect(await io.readCatalogs()).toEqual([record.catalog]);
      expect(await io.readRecord(1)).toEqual(record);
      await io.writeRecord(record);
      await io.writeCatalog(record.catalog);
      expect(github.putImmutable).toHaveBeenCalledTimes(1);
      expect(github.putCatalog).toHaveBeenCalledTimes(1);
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('does not create a release while discovering a missing journal', async () => {
    const f = releaseFixture();
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBeUndefined();
      return new Response(null, { status: 404 });
    });
    expect(await new GitHubReleaseMirror(f.policy, { token: 'fixture-token', fetcher }).recordSequences()).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('queues missing-pointer recovery rather than bootstrap when a GitHub journal exists', async () => {
    const f = releaseFixture();
    const fetcher = vi.fn(async (url: string) => {
      expect(url.startsWith(f.distribution.mirrorBaseUrls[0])).toBe(true);
      return url.endsWith('kernel-release-1.json') ? Response.json({ sequence: 1 }) : new Response(null, { status: 404 });
    });
    expect(await maintenanceHint({ ...f, fetcher })).toMatchObject({ eligible: true, reason: expect.stringMatching(/journal recovery/) });
  });
});

describe('single-source journal recovery and migration', () => {
  async function interrupted() {
    const f = releaseFixture();
    await publishRuntimeRelease({ ...f.input(), bootstrap: true });
    vi.spyOn(f.io, 'writeCatalog').mockImplementationOnce(async () => {
      f.io.catalogs = [undefined];
      throw new Error('delete/upload interruption');
    });
    await expect(publishRuntimeRelease(f.input(2, new Date(f.now.getTime() + HOUR)))).rejects.toThrow(/interruption/);
    return f;
  }

  it('recovers a sole missing pointer with the original accepted candidate and unchanged signed bytes', async () => {
    const f = await interrupted();
    const record = structuredClone(f.io.records.get(2));
    await expect(publishRuntimeRelease(f.input(3, new Date(f.now.getTime() + 2 * HOUR)))).rejects.toThrow(/Retry candidate differs/);
    await expect(publishRuntimeRelease({ ...f.input(2, new Date(f.now.getTime() + 2 * HOUR)), candidate: undefined, descriptors: undefined })).rejects.toThrow(/original accepted candidate/);
    await expect(publishRuntimeRelease(f.input(2, new Date(f.now.getTime() + 2 * HOUR)))).resolves.toMatchObject({ sequence: 2, mode: 'resumed-publication' });
    expect(f.io.catalogs).toEqual([record.catalog]);
    expect(f.io.records.get(2)).toEqual(record);
    expect(f.io.records.size).toBe(2);
    expect(f.io.deleted).toEqual([]);
  });

  it('recovers interrupted metadata-only renewal without requiring runtime re-upload', async () => {
    const f = releaseFixture();
    await publishRuntimeRelease({ ...f.input(), bootstrap: true });
    const input = { ...f.input(1, new Date(f.now.getTime() + 6 * 24 * HOUR)), candidate: undefined, descriptors: undefined };
    vi.spyOn(f.io, 'writeCatalog').mockImplementationOnce(async () => { f.io.catalogs = [undefined]; throw new Error('interrupted'); });
    await expect(publishRuntimeRelease(input)).rejects.toThrow(/interrupted/);
    f.io.events = [];
    await expect(publishRuntimeRelease(input)).resolves.toMatchObject({ sequence: 2 });
    expect(f.io.events.some(e => e.startsWith('upload:'))).toBe(false);
  });

  it.each(['gap', 'duplicate', 'changed record', 'wrong predecessor', 'wrong filename'])('refuses %s before any write or deletion', async failure => {
    const f = await interrupted();
    f.io.events = [];
    if (failure === 'gap') f.io.records.delete(1);
    if (failure === 'duplicate') vi.spyOn(f.io, 'readRecordSequences').mockResolvedValue([1, 2, 2]);
    if (failure === 'changed record') f.io.records.get(2).source.sourceSha = '0'.repeat(40);
    if (failure === 'wrong filename') f.io.records.set(2, f.io.records.get(1));
    if (failure === 'wrong predecessor') {
      const { releaseSignature: _sig, ...unsigned } = f.io.records.get(2);
      f.io.records.set(2, f.signed({ ...unsigned, previousCatalogSha256: '0'.repeat(64) }, 'releaseSignature', 'catalog'));
    }
    await expect(publishRuntimeRelease(f.input(2, new Date(f.now.getTime() + 2 * HOUR)))).rejects.toThrow();
    expect(f.io.events).toEqual([]);
    expect(f.io.deleted).toEqual([]);
  });

  it('requires exact explicit supersession for expired reservations and resumes its successor idempotently', async () => {
    const f = await interrupted();
    const old = structuredClone(f.io.records.get(2));
    const now = new Date(f.now.getTime() + 10 * 24 * HOUR);
    await expect(publishRuntimeRelease(f.input(2, now))).rejects.toThrow(/not currently valid/);
    await expect(publishRuntimeRelease(f.input(3, now))).rejects.toThrow(/Retry candidate differs/);
    await expect(publishRuntimeRelease({ ...f.input(3, now), supersedePendingSha256: '0'.repeat(64) })).rejects.toThrow(/digest differs/);
    const input = { ...f.input(3, now), supersedePendingSha256: digestJson(old) };
    vi.spyOn(f.io, 'uploadAssets').mockRejectedValueOnce(new Error('upload interrupted'));
    await expect(publishRuntimeRelease(input)).rejects.toThrow(/upload interrupted/);
    const successor = structuredClone(f.io.records.get(3));
    expect(successor.previousCatalogSha256).toBe(digestJson(old.catalog));
    expect(successor.retirements).toHaveLength(20);
    expect(f.io.deleted).toEqual([]);
    await expect(publishRuntimeRelease(input)).resolves.toMatchObject({ sequence: 3 });
    expect(f.io.records.get(2)).toEqual(old);
    expect(f.io.records.get(3)).toEqual(successor);
    await expect(publishRuntimeRelease(input)).resolves.toMatchObject({ sequence: 3, mode: 'already-published' });
    expect(f.io.records.size).toBe(3);
    expect(f.io.deleted.every(name => name.includes('+clawx.1-'))).toBe(true);
    await expect(publishRuntimeRelease({ ...input, now: new Date(now.getTime() + 6 * 24 * HOUR) })).rejects.toThrow(/normal protected maintenance/);
    expect(f.io.records.size).toBe(3);
  });

  it('migrates historical COS identities without rewriting them or contacting COS', async () => {
    const f = releaseFixture();
    const legacyInput = (revision: number, now: Date) => {
      const input = f.input(revision, now);
      return { ...input, distribution: { ...f.distribution, mirrorBaseUrls: f.policy.historicalArtifactBaseUrls },
        descriptors: input.descriptors.map(({ descriptorSignature: _sig, ...d }) => f.signed({ ...d,
          archive: { ...d.archive, url: d.archive.url.replace(f.distribution.mirrorBaseUrls[0], f.policy.historicalArtifactBaseUrls[0]) } })) };
    };
    const one = createReleaseRecord({ ...legacyInput(1, f.now), source: f.candidate() });
    const two = createReleaseRecord({ ...legacyInput(2, new Date(f.now.getTime() + HOUR)), source: f.candidate(2), previousCatalog: one.catalog, previousRecord: one });
    f.io.catalogs = [one.catalog]; f.io.records.set(1, one); f.io.records.set(2, two);
    expect(() => verifyReleaseRecord(two, f.input(2, new Date(f.now.getTime() + HOUR)))).not.toThrow();
    const result = await publishRuntimeRelease({ ...f.input(3, new Date(f.now.getTime() + 2 * HOUR)), supersedePendingSha256: digestJson(two) });
    expect(result.sequence).toBe(3);
    expect(f.io.catalogs[0].artifacts.every(d => new URL(d.archive.url).host === 'github.com')).toBe(true);
    expect(f.io.records.get(2)).toEqual(two);
    expect(f.io.records.get(3).retirements).toHaveLength(20);
    expect(f.io.deleted).toEqual([]);
    expect(() => createReleaseRecord({ ...legacyInput(4, new Date(f.now.getTime() + 3 * HOUR)), distribution: f.distribution, source: f.candidate(4) })).toThrow(/outside configured/);
  });

  it('forbids cleanup when a sole live pointer is absent after online verification', async () => {
    const f = releaseFixture();
    await publishRuntimeRelease({ ...f.input(), bootstrap: true });
    vi.spyOn(f.io, 'verifyOnline').mockImplementation(async (_catalog, pointers) => { if (pointers) f.io.catalogs = [undefined]; });
    await expect(publishRuntimeRelease(f.input(2, new Date(f.now.getTime() + 10 * 24 * HOUR)))).rejects.toThrow(/exact same live catalog/);
    expect(f.io.deleted).toEqual([]); expect(f.io.receipts.size).toBe(0);
  });

  it('allows supersession only as a protected manual publish, never via schedule or workflow_run', () => {
    const f = releaseFixture();
    const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: f.policy.repository, GITHUB_REF: 'refs/heads/main',
      GITHUB_WORKFLOW_REF: `${f.policy.repository}/.github/workflows/kernel-runtime-promote.yml@refs/heads/main`,
      GITHUB_EVENT_NAME: 'workflow_dispatch', RELEASE_MODE: 'publish', SUPERSEDE_PENDING_SHA256: 'a'.repeat(64) };
    expect(() => assertPublisherEnvironment(env, f.policy)).not.toThrow();
    for (const event of ['schedule', 'workflow_run']) expect(() => assertPublisherEnvironment({ ...env, GITHUB_EVENT_NAME: event }, f.policy)).toThrow(/manual publish/);
    expect(() => assertPublisherEnvironment({ ...env, RELEASE_MODE: 'maintain' }, f.policy)).toThrow(/manual publish/);
  });
});
