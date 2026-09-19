import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pickKernelNodeElectronHostEnvironment } from './fixtures/kernel-node-environment';

test('real Electron downloads and resumes both kernels only through configured GitHub sources', async ({ browserName: _browserName }, testInfo) => {
  const root = await mkdtemp(join(tmpdir(), 'clawx-electron-github-'));
  let app: ElectronApplication | undefined;
  try {
    const entry = testInfo.outputPath('main.cjs');
    await build({ entryPoints: [resolve('tests/e2e/fixtures/kernel-github-electron.ts')], outfile: entry,
      bundle: true, platform: 'node', format: 'cjs', packages: 'external',
      alias: { '@shared': resolve('shared'), '@electron': resolve('electron') } });
    app = await electron.launch({ executablePath: createRequire(resolve('package.json'))('electron'), args: [entry], cwd: resolve('.'),
      env: { ...pickKernelNodeElectronHostEnvironment(process.env), HOME: root, USERPROFILE: root,
        APPDATA: join(root, 'appdata'), LOCALAPPDATA: join(root, 'localappdata'),
        CLAWX_GITHUB_TEST_ROOT: root, CLAWX_GITHUB_TEST_REPOSITORY: resolve('.') }, timeout: 30_000 });
    const result = await app.evaluate(async () => (globalThis as unknown as { kernelGithubRegression(): Promise<{
      electron: string; config: { catalogUrls: string[]; mirrorBaseUrls: string[] };
      requests: Array<{ url: string; range: string | null; ifRange: string | null }>;
      results: Array<{ kernelId: string; interrupted: boolean; identical: boolean; sha256: boolean }>;
    }> }).kernelGithubRegression());
    expect(result.electron).toBeTruthy();
    expect(result.config.catalogUrls).toEqual(['https://github.com/Tabll/ClawXXX/releases/download/kernel-runtimes/kernel-catalog.production.json']);
    expect(result.config.mirrorBaseUrls).toHaveLength(1);
    expect(result.requests).toHaveLength(4);
    for (const request of result.requests) expect(request.url).toMatch(/^https:\/\/github.com\/Tabll\/ClawXXX\/releases\/download\/kernel-runtimes\/.*%2Bclawx.1.tar.zst$/);
    expect(result.requests.filter(request => request.range === 'bytes=1024-' && request.ifRange === '"stable"')).toHaveLength(2);
    expect(result.results).toEqual(['openclaw', 'deepseek-harness'].map(kernelId => ({ kernelId, interrupted: true, identical: true, sha256: true })));
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
