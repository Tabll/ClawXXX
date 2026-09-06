// @vitest-environment node
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Script, runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

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

  it('loads the published Lark CJS entry and repairs both invalid import.meta sites', () => {
    const root = path.resolve('node_modules/@larksuite/openclaw-lark');
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(pkg.type).toBe('commonjs');
    expect(existsSync(path.join(root, pkg.main))).toBe(true);
    const require = createRequire(import.meta.url);
    const plugin = require(path.join(root, pkg.main));
    expect(typeof (plugin.default ?? plugin).register).toBe('function');
    for (const file of ['src/core/version.js', 'src/core/token-store.js']) {
      const text = readFileSync(path.join(root, file), 'utf8');
      expect(() => new Script(text)).not.toThrow();
    }
  });
});
