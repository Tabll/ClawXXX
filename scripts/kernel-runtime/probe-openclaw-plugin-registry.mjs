#!/usr/bin/env node
/** Real pinned registry + private SQLite; no plugin code, user state or network. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const packageDir = resolve(args.get('--package-dir') ?? 'node_modules/openclaw');
assert.equal(JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')).version, '2026.9.2');
const root = mkdtempSync(join(tmpdir(), 'clawx-registry-probe-'));
const state = join(root, 'state');
const workspace = join(root, 'workspace');
let closeDatabase;
try {
  for (const directory of [state, workspace]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  Object.assign(process.env, {
    CLAWX_MANAGED_RUNTIME: '1', CLAWX_OPENCLAW_PACKAGE_DIR: packageDir,
    OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: join(state, 'openclaw.json'),
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: '1',
  });
  const installRecords = {};
  const loadPaths = [];
  // Distinct physical copies produce the same duplicate diagnostics as Windows
  // short/long aliases. Reverse owner order exposes SQLite's sorted serialization
  // on every platform without depending on 8.3 support or developer permissions.
  for (const id of ['beta', 'alpha']) {
    for (const kind of ['configured', 'installed']) {
      const path = join(root, kind, id);
      mkdirSync(path, { recursive: true, mode: 0o700 });
      writeFileSync(join(path, 'package.json'), JSON.stringify({
        name: `@clawx/registry-${id}`, version: '1.0.0', type: 'module', openclaw: { extensions: ['./index.js'] },
      }));
      writeFileSync(join(path, 'openclaw.plugin.json'), JSON.stringify({ id, configSchema: { type: 'object', properties: {} } }));
      writeFileSync(join(path, 'index.js'), 'throw new Error("Registry probes must never execute plugin code");\n');
      if (kind === 'configured') loadPaths.push(path);
      else installRecords[id] = { source: 'path', installPath: path, sourcePath: path, version: '1.0.0' };
    }
  }
  const config = {
    agents: { defaults: { workspace } },
    plugins: { allow: ['alpha', 'beta'], entries: { alpha: { enabled: true }, beta: { enabled: true } }, load: { paths: loadPaths } },
  };
  writeFileSync(join(state, 'openclaw.json'), JSON.stringify(config));
  const chunk = name => import(pathToFileURL(join(packageDir, 'dist', name)).href);
  const { a: load } = await chunk('plugin-registry-snapshot-Dy15Ew18.js');
  const { o: write } = await chunk('installed-plugin-index-store-write-DRg854w2.js');
  const { i: createCache, f: withCache } = await chunk('plugin-cache-DGWspMEc.js');
  ({ n: closeDatabase } = await chunk('openclaw-state-db-cache-C7ljO0xP.js'));
  const read = (extra = {}) => withCache(createCache(), () => load({ config, env: process.env, workspaceDir: workspace, allowCurrent: false, ...extra }));
  const initial = read({ preferPersisted: false, installRecords });
  const duplicates = initial.snapshot.diagnostics.filter(item => item.message.includes('duplicate plugin id'));
  assert.equal(duplicates.length, 2, 'The fixture must actually exercise both duplicate diagnostics');
  const assertStale = (result, code) => {
    assert.equal(result.source, 'derived', 'Changed metadata must not be accepted as a fresh registry');
    assert.ok(result.diagnostics.some(item => item.code === code));
  };
  const persistInitial = () => write(initial.snapshot, { env: process.env });
  persistInitial();
  for (let round = 0; round < 3; round += 1) {
    const current = read();
    assert.equal(current.source, 'persisted', JSON.stringify(current.diagnostics));
    assert.deepEqual(current.snapshot.diagnostics, initial.snapshot.diagnostics);
    write(current.snapshot, { env: process.env });
  }

  const manifest = join(root, 'configured', 'alpha', 'openclaw.plugin.json');
  const originalManifest = readFileSync(manifest);
  writeFileSync(manifest, JSON.stringify({ ...JSON.parse(originalManifest), name: 'changed manifest' }));
  assertStale(read(), 'persisted-registry-stale-source');
  writeFileSync(manifest, originalManifest);
  assert.equal(read().source, 'persisted');

  const packagePath = join(root, 'configured', 'alpha', 'package.json');
  const originalPackage = readFileSync(packagePath);
  writeFileSync(join(root, 'configured', 'alpha', 'replacement.js'), 'throw new Error("never execute");\n');
  writeFileSync(packagePath, JSON.stringify({ ...JSON.parse(originalPackage), openclaw: { extensions: ['./replacement.js'] } }));
  assertStale(read(), 'persisted-registry-stale-source');
  writeFileSync(packagePath, originalPackage);
  assert.equal(read().source, 'persisted');

  assertStale(read({ config: { ...config, plugins: { ...config.plugins, entries: { ...config.plugins.entries, alpha: { enabled: false } } } } }), 'persisted-registry-stale-policy');
  write({ ...initial.snapshot, diagnostics: initial.snapshot.diagnostics.map((item, index) => index === 0 ? { ...item, message: 'changed diagnostic content' } : item) }, { env: process.env });
  assertStale(read(), 'persisted-registry-stale-source');
  persistInitial();
  assert.equal(read().source, 'persisted');

  const report = { schemaVersion: 1, ok: true, version: '2026.9.2', platform: process.platform, duplicateDiagnostics: duplicates.length, persistedRoundTrips: 3, staleChangesRejected: ['manifest', 'source', 'policy', 'diagnostic'] };
  if (args.has('--report')) {
    const output = resolve(args.get('--report'));
    mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  // Only databases opened by this isolated process; close handles before Windows
  // cleanup. The production registry guard and database implementation are intact.
  closeDatabase?.();
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}
