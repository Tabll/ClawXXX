// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { releaseFixture } from '../fixtures/kernels/release-fixture.mjs';
import { canonicalJson } from '../../scripts/kernel-runtime/lib/canonical.mjs';
import { retirementFiles, createReleaseRecord, HOUR } from '../../scripts/kernel-runtime/lib/release-record.mjs';
import { loadReleaseAssets, GitHubReleaseMirror, ProductionReleaseIO, assertReleaseDistribution } from '../../scripts/kernel-runtime/lib/release-backend.mjs';
import { TencentCosPublisher } from '../../scripts/kernel-runtime/lib/tencent-cos.mjs';

const roots: string[] = [];
function tempRoot() { const root = mkdtempSync(join(tmpdir(), 'clawx-release-test-')); roots.push(root); return root; }
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function writeAssets(f: ReturnType<typeof releaseFixture>) {
  const root = tempRoot();
  for (const d of f.descriptors()) {
    const files = retirementFiles({ descriptor: d });
    const directory = join(root, `${d.kernelId}-${d.platform}-${d.arch}`);
    mkdirSync(directory);
    writeFileSync(join(directory, files[0].name), f.archiveBytes(d.kernelId, d));
    writeFileSync(join(directory, files[1].name), `${canonicalJson(d)}\n`);
    writeFileSync(join(directory, files[2].name), `${d.archive.sha256}  ${files[0].name}\n`);
    writeFileSync(join(directory, 'staging-artifact-trust.json'), '{}');
  }
  return root;
}

describe('exact signed runtime upload set', () => {
  it('verifies all immutable bytes and excludes staging trust without rebuilding or resigning', async () => {
    const f = releaseFixture();
    const root = writeAssets(f);
    const result = await loadReleaseAssets(root, { ...f.input() });
    expect(result.descriptors).toHaveLength(10);
    expect(result.assets.size).toBe(30);
    expect([...result.assets.keys()].every(name => !name.includes('trust'))).toBe(true);
    for (const file of result.assets.values()) expect(readFileSync(file.path).length).toBe(file.size);
  });

  it.each(['changed archive', 'extra file', 'duplicate name', 'symbolic link', 'missing signature', 'changed checksum'])('rejects %s', async failure => {
    const f = releaseFixture();
    const root = writeAssets(f);
    const d = f.descriptors()[0];
    const files = retirementFiles({ descriptor: d });
    const directory = join(root, `${d.kernelId}-${d.platform}-${d.arch}`);
    if (failure === 'changed archive') writeFileSync(join(directory, files[0].name), 'corrupt bytes');
    if (failure === 'extra file') writeFileSync(join(root, 'unreviewed.txt'), 'unknown');
    if (failure === 'duplicate name') writeFileSync(join(root, files[0].name), f.archiveBytes(d.kernelId, d));
    if (failure === 'symbolic link') symlinkSync(join(directory, files[0].name), join(root, 'link'));
    if (failure === 'missing signature') { const { descriptorSignature: _sig, ...unsigned } = d; writeFileSync(join(directory, files[1].name), JSON.stringify(unsigned)); }
    if (failure === 'changed checksum') writeFileSync(join(directory, files[2].name), 'wrong');
    await expect(loadReleaseAssets(root, f.input())).rejects.toThrow();
  });

  it('binds both publication destinations to the reviewed policy', () => {
    const f = releaseFixture();
    expect(() => assertReleaseDistribution(f.policy, f.distribution)).not.toThrow();
    expect(() => assertReleaseDistribution(f.policy, { ...f.distribution,
      mirrorBaseUrls: ['https://other.invalid/', f.distribution.mirrorBaseUrls[1]] })).toThrow(/differs/);
    expect(() => assertReleaseDistribution({ ...f.policy, githubReleaseTag: 'host-app' }, f.distribution)).toThrow();
  });
});

describe('scoped Tencent COS retirement', () => {
  function cos(client: object) {
    return new TencentCosPublisher({ client, bucket: 'aq-pub-1252262977', region: 'ap-shanghai', rootPrefix: 'clawxxx' });
  }
  const expected = { sha256: 'a'.repeat(64), size: 123 };
  const name = 'openclaw-2026.9.2+clawx.13-linux-x64.tar.zst';
  it('requires exact size and SHA metadata, deletes only the resolved key and verifies absence', async () => {
    const client = { headObject: vi.fn().mockResolvedValueOnce({ headers: { 'x-cos-meta-clawx-sha256': expected.sha256, 'content-length': '123' } })
      .mockRejectedValue({ statusCode: 404 }), deleteObject: vi.fn().mockResolvedValue({}) };
    const publisher = cos(client);
    expect(await publisher.deleteKernelArtifact(`kernels/${name}`, expected)).toMatchObject({ action: 'deleted' });
    expect(client.deleteObject).toHaveBeenCalledExactlyOnceWith({ Bucket: 'aq-pub-1252262977', Region: 'ap-shanghai', Key: `clawxxx/kernels/${name}` });
    expect(await publisher.deleteKernelArtifact(`kernels/${name}`, expected)).toMatchObject({ action: 'absent' });
    expect(client.deleteObject).toHaveBeenCalledTimes(1);
  });

  it.each(['catalog.production.json', 'metadata/kernel-release-1.json', '../other.tar.zst', 'openclaw-latest.tar.zst', 'ClawX-0.5.4.dmg'])('cannot delete %s', async key => {
    const client = { headObject: vi.fn(), deleteObject: vi.fn() };
    await expect(cos(client).deleteKernelArtifact(`kernels/${key}`, expected)).rejects.toThrow();
    expect(client.headObject).not.toHaveBeenCalled();
    expect(client.deleteObject).not.toHaveBeenCalled();
  });

  it.each(['changed hash', 'changed size', 'missing hash', 'permission error'])('does not delete for %s', async failure => {
    const headers = { 'x-cos-meta-clawx-sha256': expected.sha256, 'content-length': '123' };
    if (failure === 'changed hash') headers['x-cos-meta-clawx-sha256'] = 'b'.repeat(64);
    if (failure === 'changed size') headers['content-length'] = '124';
    if (failure === 'missing hash') headers['x-cos-meta-clawx-sha256'] = '';
    const client = { headObject: vi.fn().mockResolvedValue({ headers }), deleteObject: vi.fn() };
    if (failure === 'permission error') client.headObject.mockRejectedValue({ statusCode: 403 });
    await expect(cos(client).deleteKernelArtifact(`kernels/${name}`, expected)).rejects.toBeDefined();
    expect(client.deleteObject).not.toHaveBeenCalled();
  });

  it.each(['Enabled', 'Suspended'])('does not pretend versioned bucket %s deletes remove historical bytes', async status => {
    const client = { getBucketLocation: vi.fn().mockResolvedValue({ LocationConstraint: 'ap-shanghai' }),
      getBucketVersioning: vi.fn().mockResolvedValue({ VersioningConfiguration: { Status: status } }) };
    await expect(cos(client).verifyBucket({ requireUnversioned: true })).rejects.toThrow(/versioning|never-versioned/);
  });
});

describe('scoped GitHub release mirror', () => {
  it('uses immutable digest checks, refuses changed bytes, and never retires metadata or host assets', async () => {
    const f = releaseFixture();
    const expected = retirementFiles({ descriptor: f.descriptors()[0] })[0];
    const asset = { ...expected, id: 300, state: 'uploaded', digest: `sha256:${expected.sha256}` };
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      if (url.includes('/releases/tags/')) return Response.json({ id: 1, tag_name: 'kernel-runtimes', draft: false });
      return Response.json([asset]);
    });
    const mirror = new GitHubReleaseMirror(f.policy, { token: 'test-token', fetcher });
    expect(await mirror.putImmutable(expected)).toMatchObject({ action: 'unchanged' });
    await expect(mirror.putImmutable({ ...expected, sha256: '0'.repeat(64) })).rejects.toThrow(/identity differs/);
    await expect(mirror.deleteImmutable({ ...expected, name: 'kernel-catalog.production.json' })).rejects.toThrow(/Only exact versioned/);
    await expect(mirror.deleteImmutable({ ...expected, name: 'ClawX.dmg' })).rejects.toThrow(/Only exact versioned/);
    expect(fetcher.mock.calls.some(([, init]) => init?.method)).toBe(false);
  });

  it('creates a separate kernel release without stealing the host latest-release pointer', async () => {
    const f = releaseFixture();
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'POST'
      ? Response.json({ id: 9, tag_name: 'kernel-runtimes', draft: false }) : new Response(null, { status: 404 }));
    const mirror = new GitHubReleaseMirror(f.policy, { token: 'test-token', fetcher });
    await mirror.ensureRelease();
    const payload = JSON.parse(String(fetcher.mock.calls[1][1]?.body));
    expect(payload).toMatchObject({ tag_name: 'kernel-runtimes', target_commitish: 'main', make_latest: 'false' });
  });

  it('deletes only an exact matched runtime asset ID and handles a retry as absent', async () => {
    const f = releaseFixture();
    const expected = retirementFiles({ descriptor: f.descriptors()[0] })[0];
    let present = true;
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') { present = false; return new Response(null, { status: 204 }); }
      if (url.includes('/releases/tags/')) return Response.json({ id: 1, tag_name: 'kernel-runtimes', draft: false });
      return Response.json(present ? [{ ...expected, id: 301, state: 'uploaded', digest: `sha256:${expected.sha256}` }] : []);
    });
    const mirror = new GitHubReleaseMirror(f.policy, { token: 'test-token', fetcher });
    expect(await mirror.deleteImmutable(expected)).toMatchObject({ action: 'deleted' });
    expect(fetcher.mock.calls.find(([, init]) => init?.method === 'DELETE')?.[0]).toBe('https://api.github.com/repos/Tabll/ClawXXX/releases/assets/301');
    expect(await mirror.deleteImmutable(expected)).toMatchObject({ action: 'absent' });
  });

  it('recovers only an empty GitHub starter asset and streams the original upload bytes', async () => {
    const f = releaseFixture();
    const expected = retirementFiles({ descriptor: f.descriptors()[0] })[0];
    const path = join(tempRoot(), expected.name);
    writeFileSync(path, f.archiveBytes(f.descriptors()[0].kernelId, f.descriptors()[0]));
    const methods: string[] = [];
    let uploadedBytes = Buffer.alloc(0);
    const fetcher = async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') { methods.push(`DELETE:${url}`); return new Response(null, { status: 204 }); }
      if (init?.method === 'POST') {
        methods.push(`POST:${url}`);
        const chunks: Buffer[] = [];
        for await (const chunk of init.body as unknown as AsyncIterable<Buffer>) chunks.push(chunk);
        uploadedBytes = Buffer.concat(chunks);
        return Response.json({ ...expected, state: 'uploaded', digest: `sha256:${expected.sha256}` });
      }
      if (url.includes('/releases/tags/')) return Response.json({ id: 1, tag_name: 'kernel-runtimes', draft: false });
      return Response.json([{ id: 301, name: expected.name, size: 0, state: 'starter', digest: null }]);
    };
    const mirror = new GitHubReleaseMirror(f.policy, { token: 'test-token', fetcher });
    expect(await mirror.putImmutable({ ...expected, path })).toMatchObject({ action: 'uploaded' });
    expect(methods[0]).toBe('DELETE:https://api.github.com/repos/Tabll/ClawXXX/releases/assets/301');
    expect(methods[1]).toContain('POST:https://uploads.github.com/repos/Tabll/ClawXXX/releases/1/assets?name=');
    expect(uploadedBytes).toEqual(readFileSync(path));
  });

  it('overwrites only the catalog pointer and fails closed on an interrupted re-upload', async () => {
    const f = releaseFixture();
    const path = join(tempRoot(), 'kernel-catalog.production.json');
    writeFileSync(path, '{}');
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      if (init?.method === 'POST') return new Response(null, { status: 502 });
      if (url.includes('/releases/tags/')) return Response.json({ id: 1, tag_name: 'kernel-runtimes', draft: false });
      return Response.json([{ id: 301, name: 'kernel-catalog.production.json', digest: 'sha256:old', size: 2 },
        { id: 302, name: 'unrelated.zip', size: 2 }]);
    });
    const mirror = new GitHubReleaseMirror(f.policy, { token: 'test-token', fetcher });
    await expect(mirror.putCatalog({ name: 'kernel-catalog.production.json', path, size: 2, sha256: 'a'.repeat(64) })).rejects.toThrow(/upload failed \(502\)/);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'DELETE').map(([url]) => url)).toEqual([
      'https://api.github.com/repos/Tabll/ClawXXX/releases/assets/301',
    ]);
  });
});

describe('production backend catalog and cleanup ordering', () => {
  it('rechecks both live pointers before every retired file and stops on a changed catalog', async () => {
    const f = releaseFixture();
    const first = createReleaseRecord({ ...f.input(), source: f.candidate() });
    const second = createReleaseRecord({ ...f.input(2, new Date(f.now.getTime() + HOUR)), source: f.candidate(2),
      previousCatalog: first.catalog, previousRecord: first });
    const cos = { verifyBucket: vi.fn(), deleteKernelArtifact: vi.fn() };
    const github = { deleteImmutable: vi.fn() };
    const io = new ProductionReleaseIO({ ...f.input(), cos, github, evidenceDir: tempRoot() });
    vi.spyOn(io, 'readCatalogs').mockResolvedValueOnce([second.catalog, second.catalog]).mockResolvedValue([first.catalog, first.catalog]);
    await expect(io.deleteRetirement(second.retirements[0], second.catalog)).rejects.toThrow(/Catalog changed/);
    expect(cos.deleteKernelArtifact).toHaveBeenCalledTimes(1);
    expect(github.deleteImmutable).toHaveBeenCalledTimes(1);
    expect(cos.verifyBucket).toHaveBeenCalledWith({ requireUnversioned: true });
  });

  it('refuses active-object deletion before contacting either storage provider', async () => {
    const f = releaseFixture();
    const first = createReleaseRecord({ ...f.input(), source: f.candidate() });
    const d = first.catalog.artifacts[0];
    const cos = { verifyBucket: vi.fn(), deleteKernelArtifact: vi.fn() };
    const github = { deleteImmutable: vi.fn() };
    const io = new ProductionReleaseIO({ ...f.input(), cos, github, evidenceDir: tempRoot() });
    await expect(io.deleteRetirement({ descriptor: d, identity: `${d.kernelId}/${d.artifactVersion}/${d.platform}-${d.arch}` }, first.catalog)).rejects.toThrow(/active artifact/);
    expect(cos.verifyBucket).not.toHaveBeenCalled();
    expect(github.deleteImmutable).not.toHaveBeenCalled();
  });
});
