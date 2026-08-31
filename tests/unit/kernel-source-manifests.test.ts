import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

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
  it.each([
    ['openclaw', '2026.7.1-2'],
    ['deepseek-harness', '0.1.2-alpha.2'],
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

  it('freezes Node 24.15.0 and all five official distributions', () => {
    const runtime = readJson<{
      version: string;
      moduleAbi: number;
      assets: Array<{ platform: string; arch: string; sha256: string }>;
    }>('kernels/node-runtime.json');
    expect(runtime).toMatchObject({ version: '24.15.0', moduleAbi: 137 });
    expect(runtime.assets.map((asset) => `${asset.platform}-${asset.arch}`).sort()).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'linux-arm64',
      'linux-x64',
      'win32-x64',
    ]);
    expect(runtime.assets.every((asset) => /^[a-f0-9]{64}$/.test(asset.sha256))).toBe(true);
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
