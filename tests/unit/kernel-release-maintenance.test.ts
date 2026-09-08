// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { releaseFixture } from '../fixtures/kernels/release-fixture.mjs';
import { createReleaseRecord, createRetirementReceipt, recordName, receiptName, HOUR } from '../../scripts/kernel-runtime/lib/release-record.mjs';
import { maintenanceHint } from '../../scripts/kernel-runtime/lib/release-maintenance.mjs';
import { fetchBoundedJson, readBoundedBody } from '../../scripts/kernel-runtime/lib/release-http.mjs';
import { probeArtifactMirrors, drillKernelDistribution } from '../../scripts/kernel-runtime/distribution-drill.mjs';

describe('read-only maintenance selection', () => {
  function fixture() {
    const f = releaseFixture();
    const one = createReleaseRecord({ ...f.input(), source: f.candidate() });
    const two = createReleaseRecord({ ...f.input(2, new Date(f.now.getTime() + HOUR)), source: f.candidate(2), previousCatalog: one.catalog, previousRecord: one });
    const files = new Map<string, unknown>();
    const install = (record: typeof one) => {
      for (const url of f.distribution.catalogUrls) files.set(url, record.catalog);
      files.set(`${f.distribution.mirrorBaseUrls[0]}metadata/${recordName(record.sequence)}`, record);
      files.set(`${f.distribution.mirrorBaseUrls[1]}${recordName(record.sequence)}`, record);
    };
    const fetcher = async (url: string, init?: RequestInit) => {
      expect(init?.method).toBeUndefined();
      return files.has(url) ? Response.json(files.get(url)) : new Response(null, { status: 404 });
    };
    return { ...f, one, two, files, install, fetcher };
  }

  it('does not create production automatically when both catalog pointers are absent', async () => {
    const f = fixture();
    expect(await maintenanceHint(f)).toMatchObject({ eligible: false, reason: expect.stringMatching(/bootstrap/) });
  });

  it('stays quiet when no renewal or safe cleanup is due, and queues renewal before expiry', async () => {
    const f = fixture();
    f.install(f.one);
    expect(await maintenanceHint(f)).toMatchObject({ eligible: false });
    expect(await maintenanceHint({ ...f, now: new Date(f.now.getTime() + 6 * 24 * HOUR) })).toMatchObject({ eligible: true, reason: 'Catalog renewal due' });
  });

  it('queues due cleanup but skips it after identical receipts exist on both mirrors', async () => {
    const f = fixture();
    const now = new Date(f.now.getTime() + 8 * 24 * HOUR);
    const renewed = createReleaseRecord({ ...f.input(2, now), source: f.candidate(2), previousCatalog: f.two.catalog, previousRecord: f.two });
    f.install(renewed);
    expect(await maintenanceHint({ ...f, now })).toMatchObject({ eligible: true, reason: 'Safe retirement or receipt repair due' });
    for (const item of renewed.retirements) {
      const receipt = createRetirementReceipt(item, renewed, f.input(2, now));
      f.files.set(`${f.distribution.mirrorBaseUrls[0]}metadata/${receiptName(item)}`, receipt);
      f.files.set(`${f.distribution.mirrorBaseUrls[1]}${receiptName(item)}`, receipt);
    }
    expect(await maintenanceHint({ ...f, now })).toMatchObject({ eligible: false });
    f.files.delete(`${f.distribution.mirrorBaseUrls[1]}${receiptName(renewed.retirements[0])}`);
    expect(await maintenanceHint({ ...f, now })).toMatchObject({ eligible: true });
  });

  it('never treats 403, server failure or invalid JSON as bootstrap absence', async () => {
    const f = fixture();
    for (const status of [403, 500, 503]) {
      await expect(maintenanceHint({ ...f, fetcher: async () => new Response(null, { status }) })).rejects.toThrow(/Metadata request failed/);
    }
    await expect(maintenanceHint({ ...f, fetcher: async () => new Response('bad json') })).rejects.toThrow();
  });
});

describe('strict all-target mirrored Range acceptance', () => {
  function probeFixture() {
    const f = releaseFixture();
    const record = createReleaseRecord({ ...f.input(), source: f.candidate() });
    const fetcher = async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (url.includes('catalog.production.json')) {
        if (headers.has('if-none-match')) return new Response(null, { status: 304 });
        return new Response(JSON.stringify(record.catalog), { headers: { etag: '"catalog"' } });
      }
      const [start, end] = headers.get('range')!.slice(6).split('-').map(Number);
      if (start) expect(headers.get('if-range')).toBe('"archive"');
      return new Response(new Uint8Array(end - start + 1), {
        status: 206, headers: { etag: '"archive"', 'content-range': `bytes ${start}-${end}/4096` },
      });
    };
    const input = { ...f, catalog: record.catalog, expectedCatalog: record.catalog,
      kernelIds: f.policy.kernelIds, targets: f.policy.targets, fetcher, probeAttempts: 1, retryDelayMs: 0 };
    return { f, input, fetcher };
  }

  it('checks every kernel and platform on both hosts, not only Linux x64', async () => {
    const { input } = probeFixture();
    const result = await drillKernelDistribution(input);
    expect(result.artifacts).toHaveLength(10);
    expect(result.artifacts.every(a => a.probes.length === 2 && a.probes.every(p => p.first.status === 206 && p.second.status === 206))).toBe(true);
  });

  it.each(['missing ETag', 'weak ETag', 'unquoted ETag', 'changed ETag', 'wrong total', 'encoded body', 'oversized body', 'ignored Range'])('rejects %s on either mirror', async failure => {
    const { input, fetcher } = probeFixture();
    input.fetcher = async (url: string, init?: RequestInit) => {
      const original = await fetcher(url, init);
      if (!url.includes('github.com')) return original;
      const headers = new Headers(original.headers);
      const resumed = new Headers(init?.headers).has('if-range');
      if (failure === 'missing ETag') headers.delete('etag');
      if (failure === 'weak ETag') headers.set('etag', 'W/"archive"');
      if (failure === 'unquoted ETag') headers.set('etag', 'archive');
      if (failure === 'changed ETag' && resumed) headers.set('etag', '"changed"');
      if (failure === 'wrong total') headers.set('content-range', headers.get('content-range')!.replace('/4096', '/8192'));
      if (failure === 'encoded body') headers.set('content-encoding', 'gzip');
      return new Response(new Uint8Array(failure === 'oversized body' ? 1025 : 1024), {
        status: failure === 'ignored Range' ? 200 : 206, headers,
      });
    };
    await expect(probeArtifactMirrors(input)).rejects.toThrow(/two live range-capable/);
  });

  it('does not accept two matching but wrong live catalogs as release success', async () => {
    const { input, f } = probeFixture();
    input.expectedCatalog = createReleaseRecord({ ...f.input(2), source: f.candidate(2) }).catalog;
    await expect(drillKernelDistribution(input)).rejects.toThrow(/exact expected release/);
  });

  it('bounds streamed bodies even without a Content-Length header and refuses HTTP metadata', async () => {
    await expect(readBoundedBody(new Response(new Uint8Array(2048)), 1024)).rejects.toThrow(/bounded byte budget/);
    await expect(fetchBoundedJson('http://example.invalid/catalog')).rejects.toThrow(/requires HTTPS/);
    const response = new Response('{}');
    Object.defineProperty(response, 'url', { value: 'http://example.invalid/redirected' });
    await expect(fetchBoundedJson('https://example.invalid/catalog', { fetcher: async () => response })).rejects.toThrow(/left HTTPS/);
  });
});
