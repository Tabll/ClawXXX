// @vitest-environment node
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import JSZip from 'jszip';
import tar from 'tar';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
type DownloadKind = 'npm' | 'node';
type DownloadFixture = Awaited<ReturnType<typeof createFixture>>;
type Audit = {
  stagingRoots: string[];
  renames: { source: string; destination: string; crossVolume: boolean }[];
  requests: string[];
};

describe.each(['npm', 'node'] as const)('%s runtime download CLI staging', (kind) => {
  let fixture: DownloadFixture;
  beforeEach(async () => { fixture = await createFixture(kind); });
  afterEach(() => { rmSync(fixture.root, { recursive: true, force: true, maxRetries: 3 }); });

  it('verifies and atomically publishes on the destination volume even when system temp is elsewhere', async () => {
    const { stdout } = await runDownload(fixture);
    expect(JSON.parse(stdout)).toMatchObject({ ok: true });
    expect(existsSync(fixture.destination)).toBe(true);
    const audit = readAudit(fixture);
    expect(audit.stagingRoots).toHaveLength(1);
    expect(dirname(audit.stagingRoots[0])).toBe(dirname(fixture.destination));
    expect(audit.renames.at(-1)).toMatchObject({ destination: fixture.destination, crossVolume: false });
    expect(audit.renames.every((entry) => !entry.crossVolume)).toBe(true);
    expect(audit.requests.length).toBe(kind === 'npm' ? 2 : 1);
    if (kind === 'npm') {
      expect(JSON.parse(readFileSync(join(fixture.destination, '.clawx-source.json'), 'utf8'))).toMatchObject({
        kernelId: 'openclaw', packageName: 'clawx-ci-source-fixture', version: '1.0.0', integrity: fixture.integrity,
      });
      const { stdout: status } = await execFileAsync('git', ['status', '--porcelain'], { cwd: fixture.destination });
      expect(status).toBe('');
      const { stdout: subject } = await execFileAsync('git', ['log', '-1', '--format=%s'], { cwd: fixture.destination });
      expect(subject.trim()).toBe('verified npm patch base');
    } else {
      expect(readFileSync(join(fixture.destination, 'node.exe'), 'utf8')).toBe('foreign-target fixture executable');
      expect(readFileSync(join(fixture.destination, 'LICENSE'), 'utf8')).toBe('fixture license');
      expect(JSON.parse(readFileSync(join(fixture.destination, 'CLAWX_NODE_RUNTIME.json'), 'utf8'))).toMatchObject({
        platform: 'win32', arch: fixture.arch, sourceSha256: fixture.integrity,
      });
    }
    expectCleanStaging(fixture, true);
  }, 45_000);

  it('rejects a corrupt archive without publishing or retaining partial files', async () => {
    writeFileSync(fixture.archivePath, Buffer.concat([readFileSync(fixture.archivePath), Buffer.from('corrupt')]));
    await expect(runDownload(fixture)).rejects.toThrow(kind === 'npm' ? 'NPM tarball integrity mismatch' : 'Node archive SHA-256 mismatch');
    expectCleanStaging(fixture, false);
  }, 45_000);

  it('cleans staging when the archive download fails', async () => {
    const config = JSON.parse(readFileSync(fixture.configPath, 'utf8'));
    config.responses.at(-1).status = 503;
    writeFileSync(fixture.configPath, JSON.stringify(config));
    await expect(runDownload(fixture)).rejects.toThrow(kind === 'npm' ? 'NPM tarball download failed: 503' : 'Node download failed: 503');
    expectCleanStaging(fixture, false);
  }, 45_000);

  it.each([false, true])('refuses an existing destination before any download (nonempty=%s)', async (nonempty) => {
    mkdirSync(fixture.destination);
    if (nonempty) writeFileSync(join(fixture.destination, 'keep.txt'), 'existing user-owned data');
    await expect(runDownload(fixture)).rejects.toThrow('destination already exists');
    expect(readdirSync(fixture.destination)).toEqual(nonempty ? ['keep.txt'] : []);
    if (nonempty) expect(readFileSync(join(fixture.destination, 'keep.txt'), 'utf8')).toBe('existing user-owned data');
    expect(readAudit(fixture)).toEqual({ stagingRoots: [], renames: [], requests: [] });
    expectCleanStaging(fixture, true);
  }, 45_000);
});

describe('npm source verification before atomic publication', () => {
  const fixtures: DownloadFixture[] = [];
  afterEach(() => {
    for (const fixture of fixtures.splice(0)) rmSync(fixture.root, { recursive: true, force: true, maxRetries: 3 });
  });

  it.each([
    ['wrong-identity', 'Extracted package identity mismatch'],
    ['unsafe-entries', 'Unsafe NPM archive entries'],
  ] as const)('rejects verified bytes with %s and cleans staging', async (fault, message) => {
    const fixture = await createFixture('npm', fault);
    fixtures.push(fixture);
    await expect(runDownload(fixture)).rejects.toThrow(message);
    expectCleanStaging(fixture, false);
  }, 45_000);
});

async function createFixture(kind: DownloadKind, fault?: 'wrong-identity' | 'unsafe-entries') {
  const root = mkdtempSync(join(tmpdir(), 'clawx-runtime-download-test-'));
  try {
    const workspace = join(root, 'checkout with spaces');
    const systemTemp = join(root, 'system-temp');
    const repository = join(workspace, 'repository');
    const destination = join(workspace, 'output', 'runtime');
    mkdirSync(join(repository, 'kernels', 'openclaw'), { recursive: true });
    mkdirSync(dirname(destination), { recursive: true });
    mkdirSync(systemTemp);
    const archivePath = join(root, kind === 'npm' ? 'package.tgz' : 'node.zip');
    // Never execute a fixture binary, including on Windows CI. Native identity
    // probes still run unchanged in the production downloader for host targets.
    const arch = process.arch === 'x64' ? 'arm64' : 'x64';
    let integrity: string;
    const responses: { url: string; path: string }[] = [];
    if (kind === 'npm') {
      const packageName = 'clawx-ci-source-fixture';
      mkdirSync(join(root, 'package'));
      writeFileSync(join(root, 'package', 'package.json'), JSON.stringify({
        name: packageName, version: fault === 'wrong-identity' ? '0.0.0' : '1.0.0',
      }));
      writeFileSync(join(root, 'unexpected.txt'), 'outside package prefix');
      await tar.c({ file: archivePath, cwd: root, gzip: true, portable: true },
        fault === 'unsafe-entries' ? ['unexpected.txt'] : ['package']);
      integrity = `sha512-${createHash('sha512').update(readFileSync(archivePath)).digest('base64')}`;
      const source = JSON.parse(readFileSync('kernels/openclaw/source.json', 'utf8'));
      Object.assign(source, {
        version: '1.0.0', artifactVersion: '1.0.0+clawx.1', patchRevision: 1,
        npm: { ...source.npm, package: `${packageName}@1.0.0`, integrity },
      });
      writeFileSync(join(repository, 'kernels', 'openclaw', 'source.json'), JSON.stringify(source));
      const tarball = `https://registry.npmjs.org/${packageName}/-/source-1.0.0.tgz`;
      const metadataPath = join(root, 'metadata.json');
      writeFileSync(metadataPath, JSON.stringify({ version: '1.0.0', dist: { integrity, tarball } }));
      responses.push({ url: `https://registry.npmjs.org/${packageName}/1.0.0`, path: metadataPath }, { url: tarball, path: archivePath });
    } else {
      const archiveRoot = `node-v1.0.0-win-${arch}`;
      const filename = `${archiveRoot}.zip`;
      const zip = new JSZip();
      zip.file(`${archiveRoot}/node.exe`, 'foreign-target fixture executable');
      zip.file(`${archiveRoot}/LICENSE`, 'fixture license');
      writeFileSync(archivePath, await zip.generateAsync({ type: 'nodebuffer' }));
      integrity = createHash('sha256').update(readFileSync(archivePath)).digest('hex');
      const source = 'https://nodejs.org/dist/v1.0.0/';
      writeFileSync(join(repository, 'kernels', 'node-runtime.json'), JSON.stringify({
        version: '1.0.0', moduleAbi: 0, source,
        assets: [{ platform: 'win32', arch, archiveRoot, filename, sha256: integrity }],
      }));
      responses.push({ url: `${source}${filename}`, path: archivePath });
    }
    const configPath = join(root, 'fixture.json');
    const auditPath = join(root, 'audit.json');
    writeFileSync(configPath, JSON.stringify({ workspace, systemTemp, auditPath, responses }));
    return { root, kind, repository, destination, systemTemp, archivePath, configPath, auditPath, arch, integrity };
  } catch (error) {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    throw error;
  }
}

function runDownload(fixture: DownloadFixture) {
  return execFileAsync(process.execPath, [
    '--import', pathToFileURL(resolve('tests/fixtures/kernels/runtime-download-loader.mjs')).href,
    resolve(`scripts/kernel-runtime/download-${fixture.kind === 'npm' ? 'npm-source' : 'node-runtime'}.mjs`),
    ...(fixture.kind === 'npm' ? ['--kernel', 'openclaw'] : ['--platform', 'win32', '--arch', fixture.arch]),
    '--repository', fixture.repository, '--destination', fixture.destination,
  ], {
    env: { ...process.env, CLAWX_RUNTIME_DOWNLOAD_FIXTURE: fixture.configPath },
    encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, windowsHide: true,
  });
}

function readAudit(fixture: DownloadFixture): Audit {
  return JSON.parse(readFileSync(fixture.auditPath, 'utf8'));
}

function expectCleanStaging(fixture: DownloadFixture, published: boolean) {
  expect(existsSync(fixture.destination)).toBe(published);
  expect(readdirSync(dirname(fixture.destination))).toEqual(published ? ['runtime'] : []);
  expect(readdirSync(fixture.systemTemp)).toEqual([]);
  for (const root of readAudit(fixture).stagingRoots) expect(existsSync(root)).toBe(false);
}
