#!/usr/bin/env node
/** Real pinned registry + private SQLite; no plugin code, user state or network. */
import assert from 'node:assert/strict';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const packageDir = resolve(args.get('--package-dir') ?? 'node_modules/openclaw');
assert.equal(JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')).version, '2026.9.2');
const fixturePathMode = args.get('--fixture-path-mode') ?? 'alias';
assert.ok(['native', 'alias'].includes(fixturePathMode), 'Invalid fixture path mode');
const fixture = mkdtempSync(join(tmpdir(), 'clawx-registry-probe-'));
const physicalRoot = join(fixture, 'physical');
const fixtureAlias = join(fixture, 'alias');
const root = fixturePathMode === 'alias' ? fixtureAlias : physicalRoot;
const state = join(root, 'state');
const workspace = join(root, 'workspace');
let closeDatabase;
try {
  mkdirSync(physicalRoot);
  if (fixturePathMode === 'alias') symlinkSync(realpathSync.native(physicalRoot), fixtureAlias, process.platform === 'win32' ? 'junction' : 'dir');
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
  // Discovery first reads through the configured alias and later uses a
  // canonical root. Cached manifests must retain the checked file identity.
  for (const plugin of initial.snapshot.plugins) {
    assert.equal(realpathSync.native(plugin.rootDir), realpathSync.native(join(root, 'configured', plugin.pluginId)), 'Explicit configured copies must be selected');
    assert.equal(plugin.manifestPath, realpathSync.native(join(plugin.rootDir, 'openclaw.plugin.json')), 'Cached manifest paths must use the checked physical file');
    assert.match(plugin.manifestHash, /^[a-f0-9]{64}$/, 'Active manifests must have real content hashes, never empty placeholders');
  }
  assert.equal(initial.snapshot.plugins.length, 2);
  assert.ok(!initial.snapshot.diagnostics.some(item => item.message.includes('could not hash')), 'Every fixture manifest must be hashed safely');
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

  // A path alias must retain the physical package's install owner, not inherit
  // trust merely because its manifest claims an official plugin ID.
  const physical = join(root, 'PhysicalOfficial');
  const alias = join(root, 'OfficialAlias');
  const unrelated = join(root, 'UnrelatedOfficial');
  for (const directory of [physical, unrelated]) {
    mkdirSync(directory);
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: '@openclaw/discord', version: '2026.9.2', type: 'module', openclaw: { extensions: ['./index.js'] } }));
    writeFileSync(join(directory, 'openclaw.plugin.json'), JSON.stringify({ id: 'discord', configSchema: { type: 'object', properties: {} } }));
    writeFileSync(join(directory, 'index.js'), 'throw new Error("Metadata probes must never execute plugins");\n');
  }
  symlinkSync(realpathSync.native(physical), alias, process.platform === 'win32' ? 'junction' : 'dir');
  const configuredPath = process.platform === 'win32' ? physical.toUpperCase() : physical;
  const officialRecord = { source: 'npm', spec: '@openclaw/discord', resolvedName: '@openclaw/discord', resolvedSpec: '@openclaw/discord@2026.9.2', version: '2026.9.2', installPath: realpathSync.native(physical) };
  const { n: loadManifests } = await chunk('manifest-registry-DCCgYk7q.js');
  const manifestFor = (path, records) => withCache(createCache(), () => loadManifests({
    config: { agents: { defaults: { workspace } }, plugins: { allow: ['discord'], entries: { discord: { enabled: true } }, load: { paths: [path] } } },
    env: process.env, workspaceDir: workspace, installRecords: records,
  })).plugins.find(item => item.id === 'discord');
  assert.equal(manifestFor(configuredPath, { discord: officialRecord })?.trust?.reason, 'trusted-official', 'Physical Windows aliases must retain verified install ownership');
  assert.equal(manifestFor(alias, { discord: officialRecord })?.trust?.reason, 'trusted-official', 'A junction/symlink must resolve to the verified physical install');
  assert.notEqual(manifestFor(unrelated, { discord: officialRecord })?.trust?.reason, 'trusted-official', 'A different physical package must not borrow an official ID');
  assert.notEqual(manifestFor(configuredPath, { discord: { ...officialRecord, resolvedName: '@untrusted/discord' } })?.trust?.reason, 'trusted-official', 'Path equality must not override invalid provenance');
  assert.equal(manifestFor(configuredPath, { discord: officialRecord, other: { ...officialRecord } })?.trust?.reason, 'owner-ambiguous', 'Two owners of one physical path must fail closed');

  // Canonical cache paths must not weaken the original checked-file policy.
  const { c: readFile } = await chunk('plugin-cache-files-DLPF_Tw2.js');
  const checkedRead = (relativePath, rejectHardlinks = true) => withCache(createCache(), () => readFile({ rootDir: physical, relativePath, rejectHardlinks }));
  assert.equal(checkedRead('../UnrelatedOfficial/openclaw.plugin.json').ok, false, 'Lexical traversal must remain rejected');
  symlinkSync(realpathSync.native(unrelated), join(physical, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(checkedRead('escape/openclaw.plugin.json').ok, false, 'Directory aliases must not escape the checked root');
  linkSync(join(unrelated, 'openclaw.plugin.json'), join(physical, 'hardlinked.json'));
  assert.equal(checkedRead('hardlinked.json', false).ok, true);
  assert.equal(checkedRead('hardlinked.json').ok, false, 'Strict hardlink rejection must remain intact');

  const report = { schemaVersion: 1, ok: true, version: '2026.9.2', platform: process.platform, fixturePathMode, manifestHashesVerified: true, unsafePathsRejected: true, duplicateDiagnostics: duplicates.length, persistedRoundTrips: 3, staleChangesRejected: ['manifest', 'source', 'policy', 'diagnostic'], physicalAliasTrust: true, unrelatedPathRejected: true, invalidProvenanceRejected: true, ambiguousOwnerRejected: true };
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
  rmSync(fixture, { recursive: true, force: true, maxRetries: 3 });
}
