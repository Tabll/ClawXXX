// @vitest-environment node
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { verifySourceInputs } from '../../scripts/kernel-runtime/lib/source-manifest.mjs';

type SourceManifest = {
  schemaVersion: number;
  kernelId: string;
  upstream: string;
  version: string;
  patchBase: 'git-checkout' | 'npm-tarball';
  artifactVersion: string;
  patchRevision: number;
  license: string;
  lockfile: { descriptor: string; descriptorSha256: string; contentPath: string; contentSha256: string };
  patchSeries: { path: string; sha256: string };
  runtime: { path: string; sha256: string };
  nodeRuntime: { path: string; sha256: string };
  overlay?: { root: string; manifest: string; manifestSha256: string };
  patches: Array<{ path: string; sha256: string }>;
};

const root = process.cwd();

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(join(root, path), 'utf8')) as T;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(join(root, path))).digest('hex');
}

describe('frozen kernel sources', () => {
  it('uses the prepared lock hash only after strict patch application, and rejects cross-stage bytes', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'clawx-lock-stage-'));
    try {
      const repositoryRoot = join(fixture, 'repo');
      const sourceCheckout = join(fixture, 'checkout');
      const kernelRoot = join(repositoryRoot, 'kernels', 'deepseek-harness');
      mkdirSync(sourceCheckout, { recursive: true });
      cpSync(join(root, 'kernels', 'deepseek-harness'), kernelRoot, { recursive: true });
      cpSync(join(root, 'kernels', 'node-runtime.json'), join(repositoryRoot, 'kernels', 'node-runtime.json'));
      const sourcePath = join(kernelRoot, 'source.json');
      const manifest = JSON.parse(readFileSync(sourcePath, 'utf8'));
      const descriptorPath = join(kernelRoot, 'lock.json');
      const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'));
      const digest = (value: string) => createHash('sha256').update(value).digest('hex');
      descriptor.upstreamSha256 = digest('upstream\n');
      descriptor.sha256 = digest('prepared\n');
      writeFileSync(descriptorPath, JSON.stringify(descriptor));
      manifest.lockfile.contentSha256 = descriptor.sha256;
      manifest.lockfile.descriptorSha256 = digest(JSON.stringify(descriptor));
      writeFileSync(sourcePath, JSON.stringify(manifest));
      const input = { repositoryRoot, sourceCheckout, kernelId: 'deepseek-harness' };
      const lockPath = join(sourceCheckout, 'pnpm-lock.yaml');
      writeFileSync(lockPath, 'upstream\n');
      expect(() => verifySourceInputs(input)).not.toThrow();
      expect(() => verifySourceInputs({ ...input, sourceCheckoutState: 'prepared' })).toThrow(/prepared frozen lockfile hash mismatch/);
      writeFileSync(lockPath, 'prepared\n');
      expect(() => verifySourceInputs(input)).toThrow(/upstream frozen lockfile hash mismatch/);
      expect(() => verifySourceInputs({ ...input, sourceCheckoutState: 'prepared' })).not.toThrow();
      writeFileSync(lockPath, 'prepared\r\n');
      expect(() => verifySourceInputs({ ...input, sourceCheckoutState: 'prepared' })).toThrow(/hash mismatch/);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it.each([
    ['openclaw', '2026.9.2'],
    ['deepseek-harness', '0.1.3-alpha.1'],
  ] as const)('pins %s to an exact reviewed source', (kernelId, version) => {
    const manifest = readJson<SourceManifest>(`kernels/${kernelId}/source.json`);
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      kernelId,
      version,
      license: 'MIT',
    });
    expect(manifest.upstream).toMatch(/^https:\/\/github\.com\//);
    expect(manifest.artifactVersion).toBe(`${version}+clawx.${manifest.patchRevision}`);
    expect(JSON.stringify(manifest)).not.toMatch(/\^|~|latest|\*|HEAD/);
  });

  it('verifies every declared source patch by content hash', () => {
    const manifests = [
      readJson<SourceManifest>('kernels/openclaw/source.json'),
      readJson<SourceManifest>('kernels/deepseek-harness/source.json'),
    ];
    for (const manifest of manifests) {
      for (const patch of manifest.patches) {
        expect(sha256(patch.path), `${manifest.kernelId}:${patch.path}`).toBe(patch.sha256);
      }
    }
  });

  it('pins lock descriptors, ordered patch series, runtime config, overlays, and Node inputs by hash', () => {
    for (const kernelId of ['openclaw', 'deepseek-harness']) {
      const manifest = readJson<SourceManifest>(`kernels/${kernelId}/source.json`);
      expect(sha256(manifest.lockfile.descriptor)).toBe(manifest.lockfile.descriptorSha256);
      expect(sha256(manifest.patchSeries.path)).toBe(manifest.patchSeries.sha256);
      expect(sha256(manifest.runtime.path)).toBe(manifest.runtime.sha256);
      expect(sha256(manifest.nodeRuntime.path)).toBe(manifest.nodeRuntime.sha256);
      const series = readFileSync(join(root, manifest.patchSeries.path), 'utf8').split(/\r?\n/)
        .map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#'));
      expect(series).toEqual(manifest.patches.map((patch) => patch.path));
      if (manifest.overlay) {
        expect(sha256(manifest.overlay.manifest)).toBe(manifest.overlay.manifestSha256);
        const overlay = readJson<{ root: string; files: Array<{ path: string; sha256: string }> }>(manifest.overlay.manifest);
        expect(overlay.root).toBe(manifest.overlay.root);
        for (const file of overlay.files) expect(sha256(join(overlay.root, file.path))).toBe(file.sha256);
      }
    }
  });

  it('freezes the Windows TCP-connect repair in Node 24.20.0 without changing the module ABI', () => {
    const runtime = readJson<{
      version: string;
      moduleAbi: number;
      source: string;
      signedChecksums: { url: string; signatureUrl: string };
      assets: Array<{ platform: string; arch: string; filename: string; archiveRoot: string; sha256: string }>;
    }>('kernels/node-runtime.json');
    expect(runtime).toMatchObject({ version: '24.20.0', moduleAbi: 137 });
    expect(runtime.source).toBe('https://nodejs.org/download/release/v24.20.0/');
    expect(runtime.signedChecksums).toEqual({ url: `${runtime.source}SHASUMS256.txt`, signatureUrl: `${runtime.source}SHASUMS256.txt.sig` });
    expect(runtime.assets.map((asset) => `${asset.platform}-${asset.arch}`).sort()).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'linux-arm64',
      'linux-x64',
      'win32-x64',
    ]);
    // Official release checksums, not arbitrary hash-shaped strings. Both
    // kernels must ship the same fixed native runtime, not only a newer CI Node.
    expect(Object.fromEntries(runtime.assets.map(asset => [asset.filename, asset.sha256]))).toEqual({
      'node-v24.20.0-darwin-arm64.tar.xz': 'b7bf7707070b950ba1ec5f1af3bb6de0f2b1962c5033973d94068ab021ef3014',
      'node-v24.20.0-darwin-x64.tar.xz': '26fc30891004603d094eed11de5efcd03bbd2efbc35c177fc72648d5d7a7701b',
      'node-v24.20.0-linux-arm64.tar.xz': '5f4ddab610c1ab2016b3c227cebdbf6d9495161487e4739c7b90090595f465f7',
      'node-v24.20.0-linux-x64.tar.xz': '2f2c0da162318f0de47665410c7c8c2ed3d36c8f3105de4bbc61176c70a7cbf2',
      'node-v24.20.0-win-x64.zip': '6cac9ffbca8f6a47091e4b5c772e0606049c3871cb67d900c0cedde630e545ba',
    });
    for (const asset of runtime.assets) expect(asset.archiveRoot).toBe(asset.filename.replace(/(?:\.tar\.xz|\.zip)$/, ''));
    for (const kernel of ['openclaw', 'deepseek-harness']) {
      const manifest = readJson<SourceManifest>(`kernels/${kernel}/source.json`);
      expect(manifest.patchRevision).toBe(13);
      expect(manifest.nodeRuntime.sha256).toBe(sha256('kernels/node-runtime.json'));
    }
  });

  it.each(['\n', '\r\n'])('keeps all runtime CI Node installations aligned with the shared pin under %j', eol => {
    const { version } = readJson<{ version: string }>('kernels/node-runtime.json');
    for (const [file, count] of [
      ['kernel-runtime-build.yml', 3], ['kernel-runtime-promote.yml', 2], ['multi-kernel-runtime-smoke.yml', 1],
    ] as const) {
      const workflow = readFileSync(join(root, '.github/workflows', file), 'utf8').replace(/\r?\n/g, eol);
      const pins = [...workflow.matchAll(/node-version:\s*['"]?([0-9.]+)['"]?/g)].map(match => match[1]);
      expect(pins).toEqual(Array(count).fill(version));
    }
  });

  it('freezes the required five runtime targets and only defers arm64 RPM packaging', () => {
    const matrix = readJson<{
      version: number;
      targets: Array<{ platform: string; arch: string; release: string }>;
      deferred: Array<{ platform: string; arch: string; format: string }>;
    }>('kernels/platform-matrix.json');
    expect(matrix.version).toBe(1);
    expect(matrix.targets.map(({ platform, arch }) => `${platform}-${arch}`).sort()).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'linux-arm64',
      'linux-x64',
      'win32-x64',
    ]);
    expect(matrix.targets.every((target) => target.release === 'required')).toBe(true);
    expect(matrix.deferred).toEqual([
      expect.objectContaining({ platform: 'linux', arch: 'arm64', format: 'rpm' }),
    ]);
  });
});
