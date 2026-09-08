// @vitest-environment node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '../..');
const selector = readFileSync(require.resolve('tar/lib/get-write-flag.js'), 'utf8');

describe('pinned runtime tar write strategy', () => {
  it.each(['win32', 'darwin', 'linux'])('uses ordinary complete writes on %s without platform or reservation overrides', platform => {
    const module = { exports: undefined as unknown as (size: number) => string | number };
    // Evaluate the actual installed selector in an isolated VM, not by mutating
    // this process's platform, fs module, constants or environment variables.
    runInNewContext(selector, {
      module, global: {}, process: { platform, env: {} },
      require: (name: string) => {
        expect(name).toBe('fs');
        return { constants: { O_CREAT: 0x100, O_TRUNC: 0x200, O_WRONLY: 1, UV_FS_O_FILEMAP: 0x20000000 } };
      },
    });
    for (const size of [0, 1, 511 * 1024, 512 * 1024, 1024 * 1024]) {
      expect(module.exports(size)).toBe('w');
    }
    const unpack = readFileSync(require.resolve('tar/lib/unpack.js'), 'utf8');
    const reservations = readFileSync(require.resolve('tar/lib/path-reservations.js'), 'utf8');
    expect(unpack).toContain('this.reservations.reserve(paths, done => this[CHECKFS2](entry, done))');
    expect(reservations).toContain('process.platform');
  });

  it.each(['\n', '\r\n'])('pins the exact host-only patch with %j lockfile line endings', eol => {
    expect(require('tar/package.json').version).toBe('6.2.1');
    const patch = readFileSync(resolve(root, 'patches/tar@6.2.1.patch'), 'utf8');
    const hash = createHash('sha256').update(patch).digest('hex');
    const workspace = readFileSync(resolve(root, 'pnpm-workspace.yaml'), 'utf8');
    const checkoutLock = readFileSync(resolve(root, 'pnpm-lock.yaml'), 'utf8').replace(/\r\n/g, '\n').replace(/\n/g, eol);
    // Normalize only semantic lockfile comparisons, never patch checksum bytes.
    const lock = checkoutLock.replace(/\r\n/g, '\n');
    expect(workspace).toContain('tar@6.2.1: patches/tar@6.2.1.patch');
    expect(lock).toContain(`hash: ${hash}\n    path: patches/tar@6.2.1.patch`);
    expect(lock).toContain(`tar@6.2.1(patch_hash=${hash}):`);
    expect(patch.match(/^diff --git /gm)).toHaveLength(1);
    expect(patch).toContain('a/lib/get-write-flag.js b/lib/get-write-flag.js');
    expect(patch).not.toContain('path-reservations.js');
    expect(patch).not.toContain('unpack.js');
  });
});
