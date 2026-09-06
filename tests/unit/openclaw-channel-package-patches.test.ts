// @vitest-environment node
import { execFile } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { Script, runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const execFileAsync = promisify(execFile);

describe('reviewed September Channel package repairs', () => {
  it('executes the real DingTalk namespace cache without reading or writing native JSON history', () => {
    const source = readFileSync('node_modules/@soimy/dingtalk/dist/index.js', 'utf8');
    const start = source.indexOf('var NAMESPACE_ROOT_DIR =');
    const end = source.indexOf('// src/message-context-store.ts', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const disk = new Proxy({}, { get: () => vi.fn(() => { throw new Error('Native disk access is forbidden'); }) });
    const cache = runInNewContext(`${source.slice(start, end)}; ({ readNamespaceJson, writeNamespaceJsonAtomic, size: () => clawxNamespaceCache.size })`, {
      fs2: disk, path3: path, Buffer, structuredClone, process: { env: { CLAWX_MANAGED_RUNTIME: '1' } },
    });
    const options = { storePath: '/isolated/agent.sqlite', scope: { accountId: 'one' }, fallback: { messages: [] } };
    expect(cache.readNamespaceJson('messages.context', options)).toEqual(options.fallback);
    cache.writeNamespaceJsonAtomic('messages.context', { ...options, data: { messages: ['current'] } });
    const read = cache.readNamespaceJson('messages.context', options);
    read.messages.push('caller mutation');
    expect(cache.readNamespaceJson('messages.context', options)).toEqual({ messages: ['current'] });
    expect(cache.readNamespaceJson('messages.context', { ...options, scope: { accountId: 'other' } })).toEqual(options.fallback);
    for (let index = 0; index < 1025; index++) cache.writeNamespaceJsonAtomic(`entry-${index}`, { ...options, data: { index } });
    expect(cache.size()).toBe(1024);
    expect(cache.readNamespaceJson('messages.context', options)).toEqual(options.fallback);
    cache.writeNamespaceJsonAtomic('too-large', { ...options, data: 'x'.repeat(32 * 1024 * 1024) });
    expect(cache.readNamespaceJson('too-large', options)).toEqual(options.fallback);
  });

  it('loads the published Lark CJS entry in a bounded native Node process', async () => {
    const root = path.resolve('node_modules/@larksuite/openclaw-lark');
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(pkg.type).toBe('commonjs');
    expect(existsSync(path.join(root, pkg.main))).toBe(true);
    // This loads the entire real plugin/SDK graph, not a unit-sized module.
    // Use a fresh native process (as the runtime does), without Vitest module
    // state, and kill a hung import before the per-test deadline expires.
    const { stdout } = await execFileAsync(process.execPath, ['--input-type=commonjs', '-e', `
      const assert = require('node:assert/strict');
      const plugin = require(process.argv[1]);
      assert.equal(typeof (plugin.default ?? plugin).register, 'function');
      process.stdout.write('CLAWX_LARK_CJS_LOADED\\n');
    `, path.join(root, pkg.main)], {
      timeout: 60_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, windowsHide: true,
    });
    expect(stdout).toContain('CLAWX_LARK_CJS_LOADED\n');
  }, 75_000);

  it('repairs both invalid import.meta sites as CommonJS syntax', () => {
    const root = path.resolve('node_modules/@larksuite/openclaw-lark');
    for (const file of ['src/core/version.js', 'src/core/token-store.js']) {
      const text = readFileSync(path.join(root, file), 'utf8');
      expect(() => new Script(text)).not.toThrow();
    }
  });
});
