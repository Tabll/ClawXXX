#!/usr/bin/env node
/** Load the actual cleaned Koffi closure in a fresh standalone Node process. */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
assert.ok(args.get('--package-dir'), 'Usage: probe-openclaw-koffi --package-dir PAYLOAD [--report FILE]');
assert.ok(!process.versions.electron, 'Koffi must be probed with standalone Node, not Electron');
const payload = realpathSync.native(resolve(args.get('--package-dir')));
const insidePayload = filename => {
  const physical = realpathSync.native(filename);
  const rel = relative(payload, physical);
  assert.ok(rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel),
    `Koffi resolved outside the payload: ${filename}`);
  return physical;
};

// Resolve from the runtime package, never from this script's repository. The
// boundary checks reject pnpm/developer/global fallbacks, even if they can load.
const require = createRequire(join(payload, 'package.json'));
const entry = insidePayload(require.resolve('koffi'));
const koffiDir = dirname(entry);
const manifest = JSON.parse(readFileSync(insidePayload(join(koffiDir, 'package.json')), 'utf8'));
assert.equal(manifest.name, 'koffi');
const cjs = require(entry);
const esmEntry = insidePayload(join(koffiDir, 'index.js'));
const esm = await import(pathToFileURL(esmEntry).href);
assert.equal(cjs.version, manifest.version);
assert.equal(esm.default.version, manifest.version);

// A real FFI call catches a missing, foreign or unloadable addon that a file
// existence check or a platform's unrelated Gateway path would not exercise.
const library = process.platform === 'win32' ? 'kernel32.dll'
  : process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';
for (const api of [cjs, esm.default]) {
  assert.equal(api.type('uint32_t').size, 4);
  const handle = api.load(library);
  try {
    const getPid = process.platform === 'win32'
      ? handle.func('GetCurrentProcessId', 'uint32_t', [])
      : handle.func('getpid', 'int', []);
    assert.equal(getPid(), process.pid, 'Koffi must execute the real native process-id function');
  } finally {
    handle.unload();
  }
}

const loaded = Object.keys(require.cache).map(insidePayload);
const addons = loaded.filter(filename => filename.endsWith('.node'));
assert.ok(addons.length > 0, 'No native Koffi addon was loaded');
const expectedAddon = join(payload, 'node_modules', '@koromix', `koffi-${process.platform}-${process.arch}`);
for (const filename of addons) {
  const rel = relative(expectedAddon, filename);
  assert.ok(rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel),
    'Koffi must load the selected target addon from this payload');
}
const evidence = {
  ok: true, version: manifest.version, platform: process.platform, arch: process.arch,
  node: process.versions.node, cjs: true, esm: true, nativePidCalls: 2,
  payloadOnly: true, addons: addons.map(filename => relative(payload, filename).split(sep).join('/')),
};
if (args.has('--report')) {
  const report = resolve(args.get('--report'));
  mkdirSync(dirname(report), { recursive: true });
  writeFileSync(report, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
}
process.stdout.write(`${JSON.stringify(evidence)}\n`);
