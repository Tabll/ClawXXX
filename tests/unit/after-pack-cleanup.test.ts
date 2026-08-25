// @vitest-environment node
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const afterPack = require('../../scripts/after-pack.cjs') as {
  default: (context: {
    electronPlatformName: string;
    appOutDir: string;
    packager: { appInfo: { productFilename: string } };
  }) => Promise<void>;
  assertNoOptionalKernelPayload: (resourcesDir: string) => void;
};

describe('base-app afterPack boundary', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('does not contain OpenClaw payload copy or platform-pruning logic', () => {
    const source = readFileSync(join(process.cwd(), 'scripts', 'after-pack.cjs'), 'utf8');
    expect(source).not.toMatch(/resources[\\/]openclaw/iu);
    expect(source).not.toContain('cleanupNativePlatformPackages');
    expect(source).not.toContain('cleanupNodeModulesRuntimeJunk');
    expect(source).toContain('Optional kernel payloads are intentionally absent');
  });

  it('accepts a base package with no optional runtime payload directory', async () => {
    const appOutDir = mkdtempSync(join(tmpdir(), 'clawx-base-after-pack-'));
    roots.push(appOutDir);
    mkdirSync(join(appOutDir, 'resources'), { recursive: true });

    await expect(afterPack.default({
      electronPlatformName: 'linux',
      appOutDir,
      packager: { appInfo: { productFilename: 'ClawX' } },
    })).resolves.toBeUndefined();
  });

  it.each([
    ['runtime directory', join('resources', 'kernels', 'openclaw'), 'package.json'],
    ['plugin mirror', join('resources', 'openclaw-plugins', 'discord'), 'package.json'],
    ['kernel entrypoint', join('unexpected', 'runtime'), 'clawx-openclaw.mjs'],
  ])('fails closed for an accidental %s', (_label, relativeDirectory, fileName) => {
    const resourcesDir = mkdtempSync(join(tmpdir(), 'clawx-base-boundary-'));
    roots.push(resourcesDir);
    const directory = join(resourcesDir, relativeDirectory);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, fileName), '{}');

    expect(() => afterPack.assertNoOptionalKernelPayload(resourcesDir))
      .toThrow(/Base package contains optional kernel payloads/);
  });

  it('allows catalog metadata and trust roots in the base package', () => {
    const resourcesDir = mkdtempSync(join(tmpdir(), 'clawx-base-catalog-'));
    roots.push(resourcesDir);
    const kernelsDir = join(resourcesDir, 'resources', 'kernels', 'trust');
    mkdirSync(kernelsDir, { recursive: true });
    writeFileSync(join(resourcesDir, 'resources', 'kernels', 'distribution.json'), '{}');
    writeFileSync(join(kernelsDir, 'roots.production.json'), '{}');

    expect(() => afterPack.assertNoOptionalKernelPayload(resourcesDir)).not.toThrow();
  });
});
