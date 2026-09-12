import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { build } from 'esbuild';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import nodeRuntime from '../../kernels/node-runtime.json';

const requireFromRepo = createRequire(resolve('package.json'));

test('real Electron restarts the real OpenClaw Gateway with an existing SQLite database', async ({ browserName: _browserName }, testInfo) => {
  test.setTimeout(180_000);
  const root = await mkdtemp(join(tmpdir(), 'clawx-electron-node-'));
  const entry = testInfo.outputPath('main.cjs');
  let app: ElectronApplication | undefined;
  try {
    await mkdir(join(root, 'electron-data'));
    await build({ entryPoints: [resolve('tests/e2e/fixtures/kernel-node-electron.ts')], outfile: entry,
      bundle: true, platform: 'node', format: 'cjs', packages: 'external',
      define: { 'import.meta.url': '__clawxImportMetaUrl' },
      banner: { js: 'const __clawxImportMetaUrl = require("node:url").pathToFileURL(__filename).href;' },
      alias: { '@shared': resolve('shared'), '@electron': resolve('electron') } });
    const env: Record<string, string> = {};
    for (const key of ['PATH', 'Path', 'SystemRoot', 'ComSpec', 'PATHEXT', 'DISPLAY', 'ELECTRON_DISABLE_SANDBOX', 'LANG']) {
      if (process.env[key]) env[key] = process.env[key]!;
    }
    app = await electron.launch({ executablePath: requireFromRepo('electron'), args: [entry], cwd: resolve('.'),
      env: { ...env, HOME: root, USERPROFILE: root, APPDATA: join(root, 'appdata'), LOCALAPPDATA: join(root, 'localappdata'),
        ...(process.env.CLAWX_E2E_EXISTING_AGENT_DATABASE ? { CLAWX_NODE_TEST_EXISTING_AGENT_DATABASE: resolve(process.env.CLAWX_E2E_EXISTING_AGENT_DATABASE) } : {}),
        CLAWX_NODE_TEST_ROOT: root, CLAWX_NODE_TEST_REPOSITORY: resolve('.') }, timeout: 30_000 });
    const call = (method: string) => app!.evaluate(async (_electron, name) => {
      const api = (globalThis as unknown as { kernelNodeRegression: Record<string, () => unknown> }).kernelNodeRegression;
      return await api[name]();
    }, method);
    const seeded = await call('seed') as { node: string; marker: { marker: string; integrity: string }; agent: Record<string, unknown> };
    expect(seeded.marker).toEqual({ marker: 'PRESERVE_EXISTING_STATE', integrity: 'ok' });
    expect(seeded.agent).toMatchObject({ version: 19, metadata: { schema_version: 19, agent_id: 'main' },
      marker: '{"marker":"PRESERVE_AGENT_STATE"}', integrity: 'ok', foreignKeyErrors: 0 });
    const identity = await call('identity') as { node: string; electron?: string; execPath: string };
    expect(identity.node).toBe(nodeRuntime.version);
    expect(identity.electron).toBeUndefined();
    expect(identity.execPath).toBe(seeded.node);
    expect(await call('worker')).toMatchObject({ ok: true });
    const pids: number[] = [];
    for (let generation = 1; generation <= 2; generation++) {
      const started = await call('start') as { pid: number; port: number; spawnfile: string };
      pids.push(started.pid);
      expect(started.spawnfile).toBe(seeded.node);
      await expect.poll(async () => {
        const status = await call('status') as { exitCode: number | null; signalCode: string | null };
        if (status.exitCode !== null || status.signalCode !== null) throw new Error(`Real Gateway exited: ${JSON.stringify(status)}`);
        try {
          const response = await fetch(`http://127.0.0.1:${started.port}/healthz`, { signal: AbortSignal.timeout(1000) });
          await response.body?.cancel();
          return response.status;
        } catch { return 0; }
      }, { timeout: 60_000, intervals: [200, 500] }).toBe(200);
      await expect.poll(() => call('ready'), { timeout: 10_000 }).toBe(true);
      expect(await call('syncAuth')).toEqual(seeded.agent);
      expect(await call('ready')).toBe(true);
      expect(await call('worker')).toMatchObject({ ok: true });
      expect(await call('stop')).toMatchObject({ activeChildren: 0, marker: 'PRESERVE_EXISTING_STATE', integrity: 'ok', agent: seeded.agent });
    }
    expect(new Set(pids).size).toBe(2);
    const evidence = await app.evaluate(() => (globalThis as unknown as { kernelNodeRegression: { evidence: unknown } }).kernelNodeRegression.evidence);
    expect(JSON.stringify(evidence)).not.toContain('GPU process isn');
    expect(JSON.stringify(evidence)).not.toContain('SQLite read-only worker exited unsuccessfully');
  } finally {
    if (app) {
      const evidence = await app.evaluate(() => (globalThis as unknown as { kernelNodeRegression: { evidence: unknown } }).kernelNodeRegression.evidence).catch(() => undefined);
      if (evidence) {
        const path = testInfo.outputPath('real-electron-kernel.json');
        await writeFile(path, JSON.stringify(evidence, null, 2));
        await testInfo.attach('real-electron-kernel', { path, contentType: 'application/json' });
      }
      await app.evaluate(async () => {
        await (globalThis as unknown as { kernelNodeRegression: { stop(): Promise<unknown> } }).kernelNodeRegression.stop();
      }).catch(() => {});
      await app.close();
    }
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
