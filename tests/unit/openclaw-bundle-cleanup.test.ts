// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanupBundle } from '../../scripts/openclaw-bundle-cleanup.mjs';

const require = createRequire(resolve('node_modules/openclaw/package.json'));
const koffiSource = dirname(require.resolve('koffi'));
const nativeName = `@koromix/koffi-${process.platform}-${process.arch}`;
const nativeSource = dirname(createRequire(join(koffiSource, 'index.cjs')).resolve(`${nativeName}/package.json`));
const probe = resolve('scripts/kernel-runtime/probe-openclaw-koffi.mjs');
const prune = resolve('scripts/kernel-runtime/prune-native-payload.mjs');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'clawx-koffi-cleanup-'));
  const payload = join(root, 'payload');
  try {
    mkdirSync(payload);
    writeFileSync(join(payload, 'package.json'), JSON.stringify({ name: 'clawx-koffi-fixture', type: 'module' }));
    for (const [source, name] of [[koffiSource, 'koffi'], [nativeSource, nativeName]]) {
      cpSync(source, join(payload, 'node_modules', name), {
        recursive: true, dereference: true, filter: entry => basename(entry) !== 'node_modules',
      });
    }
    return { root, payload };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function runProbe(payload: string) {
  return JSON.parse(execFileSync(process.execPath, [probe, '--package-dir', payload], {
    encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: 128 * 1024,
    env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', ELECTRON_RUN_AS_NODE: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
}

describe('OpenClaw production cleanup preserves the real Koffi runtime closure', () => {
  it('cleans and target-prunes the pinned package before loading CJS, ESM and actual native FFI', () => {
    const { root, payload } = fixture();
    try {
      const seed = (file: string, contents = 'fixture') => {
        const target = join(payload, file);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, contents);
      };
      const junk = [
        'node_modules/koffi/vendor/build-only.h', 'node_modules/koffi/doc/usage.md',
        'node_modules/koffi/tests/build-only.js', 'node_modules/koffi/index.d.ts',
        'node_modules/koffi/src/koffi/index.cjs.map', 'node_modules/node-wav/x.json',
        'node_modules/tree-sitter-bash/src/parser.c',
        'dist/extensions/fixture/node_modules/tree-sitter-bash/src/parser.c',
      ];
      const runtime = [
        'docs/prompt.md', 'node_modules/tree-sitter-bash/src/node-types.json',
        'dist/extensions/fixture/index.ts', 'dist/extensions/fixture/skills/fixture/SKILL.md',
        'dist/extensions/fixture/node_modules/tree-sitter-bash/src/node-types.json',
      ];
      for (const file of [...junk, ...runtime]) seed(file);
      const foreignName = `@koromix/koffi-${process.platform}-${process.arch === 'arm64' ? 'x64' : 'arm64'}`;
      seed(`node_modules/${foreignName}/foreign.node`);
      expect(cleanupBundle(payload)).toBeGreaterThan(0);
      execFileSync(process.execPath, [prune, '--payload', payload, '--platform', process.platform, '--arch', process.arch], {
        encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL', windowsHide: true,
      });
      for (const file of junk) expect(existsSync(join(payload, file)), file).toBe(false);
      for (const file of runtime) expect(existsSync(join(payload, file)), file).toBe(true);
      for (const file of ['index.cjs', 'index.js', 'src/koffi/index.cjs', 'src/koffi/index.js',
        'src/koffi/indirect.cjs', 'src/koffi/indirect.js', 'src/koffi/src/static.cjs']) {
        expect(readFileSync(join(payload, 'node_modules/koffi', file)))
          .toEqual(readFileSync(join(koffiSource, file)));
      }
      expect(existsSync(join(payload, 'node_modules', foreignName))).toBe(false);
      expect(runProbe(payload)).toMatchObject({
        ok: true, version: '3.1.6', platform: process.platform, arch: process.arch,
        cjs: true, esm: true, nativePidCalls: 2, payloadOnly: true,
        addons: [expect.stringContaining(`node_modules/${nativeName}/`)],
      });
      expect(cleanupBundle(payload)).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it.each(['src/koffi/index.cjs', 'src/koffi/src/static.cjs', 'src/koffi/index.js'])('rejects the actual missing runtime loader %s', file => {
    const { root, payload } = fixture();
    try {
      cleanupBundle(payload);
      rmSync(join(payload, 'node_modules/koffi', file));
      expect(() => runProbe(payload)).toThrow(/Cannot find module/);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it('rejects a missing native addon rather than passing a JS-only import check', () => {
    const { root, payload } = fixture();
    try {
      cleanupBundle(payload);
      rmSync(join(payload, 'node_modules', nativeName), { recursive: true });
      expect(() => runProbe(payload)).toThrow(/Cannot find the native Koffi module/);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it('rejects a working developer package outside the candidate payload', () => {
    const { root, payload } = fixture();
    try {
      cpSync(join(payload, 'node_modules'), join(root, 'node_modules'), { recursive: true });
      rmSync(join(payload, 'node_modules'), { recursive: true });
      expect(() => runProbe(payload)).toThrow(/Koffi resolved outside the payload/);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it('rejects a native addon resolved from an ancestor even when the JS loader is inside the payload', () => {
    const { root, payload } = fixture();
    try {
      cpSync(join(payload, 'node_modules', nativeName), join(root, 'node_modules', nativeName), { recursive: true });
      rmSync(join(payload, 'node_modules', nativeName), { recursive: true });
      expect(() => runProbe(payload)).toThrow(/Koffi resolved outside the payload/);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it.each(['\n', '\r\n'])('keeps real cleaned-payload probes before signing and after extraction (%j)', newline => {
    const workflow = readFileSync(resolve('.github/workflows/kernel-runtime-build.yml'), 'utf8')
      .replace(/\r?\n/g, newline).replace(/\r\n/g, '\n');
    expect(workflow).toContain('tests/unit/openclaw-bundle-cleanup.test.ts');
    const koffiStep = workflow.indexOf('- name: Exercise the cleaned OpenClaw Koffi native closure');
    expect(koffiStep).toBeGreaterThan(workflow.indexOf('- name: Prune non-target native payloads'));
    expect(koffiStep).toBeGreaterThan(workflow.indexOf('- name: Download and verify independent Node'));
    expect(koffiStep).toBeLessThan(workflow.indexOf('- name: Import macOS runtime signing certificate'));
    const step = workflow.slice(koffiStep, workflow.indexOf('- name: Exercise the real OpenClaw Gateway'));
    expect(step).toContain("if: matrix.kernel == 'openclaw'");
    expect(step).toContain('"$node_bin" scripts/kernel-runtime/probe-openclaw-koffi.mjs --package-dir build/openclaw');
    expect(step).toContain('timeout-minutes: 1');
    expect(step).not.toMatch(/continue-on-error|matrix.target.platform !=|matrix.target.platform ==/);
    const bundler = readFileSync(resolve('scripts/bundle-openclaw.mjs'), 'utf8');
    expect(bundler).toContain("import { cleanupBundle } from './openclaw-bundle-cleanup.mjs'");
    expect(bundler).toContain('cleanupBundle(OUTPUT)');
    const smoke = readFileSync(resolve('scripts/kernel-runtime/runtime-artifact-smoke.mjs'), 'utf8');
    expect(smoke).toContain("resolve('scripts/kernel-runtime/probe-openclaw-koffi.mjs')");
    expect(smoke).toContain("'--package-dir', join(extracted, 'runtime', 'kernel')");
    expect(smoke).toContain('koffi: koffiEvidence');
  });
});
