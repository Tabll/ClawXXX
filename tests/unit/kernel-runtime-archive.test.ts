import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import tar from 'tar';
import { describe, expect, it } from 'vitest';
import { buildFileManifest, createDeterministicTarZstd, verifyTarFileManifest } from '../../scripts/kernel-runtime/lib/artifact.mjs';
import { streamBudget } from '../fixtures/kernels/archive-overhead.mjs';

const epoch = 1_788_638_407;
const prefix = 'runtime/kernel/snapshots/';
const longStem = 'index-node-test-ts-write-text-over-image-bottom-align-text-when-passing-object-with-alignment-y-1-snap';
const names = [
  `${prefix}${longStem}.png`,
  `${prefix}${'same-prefix-'.repeat(10)}first.txt`,
  `${prefix}${'same-prefix-'.repeat(10)}second.txt`,
  `${prefix}${'内核'.repeat(30)}.txt`,
  `runtime/kernel/${'nested/'.repeat(25)}${'long-'.repeat(25)}file.txt`,
];

describe('lossless deterministic runtime archives', () => {
  it('keeps archive-overhead fixture buffering bounded independently of runner speed', () => {
    const report = JSON.parse(execFileSync(process.execPath, [
      join(process.cwd(), 'tests/fixtures/kernels/archive-overhead-probe.mjs'),
    ], { encoding: 'utf8', timeout: 4_000, windowsHide: true }));
    expect(report).toMatchObject({ legacy: false, archiveBytes: streamBudget, entries: 1 });
    // The old trailer copied over 300 times the input before the same limit.
    // Operation counts guard fixture cost without brittle wall-clock assertions.
    expect(report.concatenatedBytes).toBeLessThan(streamBudget);
  });

  it.each(['truncated path', 'duplicate', 'missing', 'content', 'mode'])('rejects %s before compression and descriptor signing', async (fault) => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-tar-roundtrip-'));
    try {
      const name = fault === 'truncated path' ? names[0] : `${prefix}first.txt`;
      mkdirSync(dirname(join(root, name)), { recursive: true });
      writeFileSync(join(root, name), 'original', { mode: 0o644 });
      writeFileSync(join(root, prefix, 'other.txt'), 'other', { mode: 0o644 });
      const manifest = buildFileManifest(root, epoch);
      if (fault === 'content') writeFileSync(join(root, name), 'modified');
      const paths = fault === 'missing' ? [name]
        : fault === 'duplicate' ? [name, name, `${prefix}other.txt`]
          : [name, `${prefix}other.txt`];
      const chunks: Buffer[] = [];
      for await (const chunk of tar.c({ cwd: root, portable: true, noPax: fault === 'truncated path' }, paths)) {
        chunks.push(Buffer.from(chunk));
      }
      const encoded = Buffer.concat(chunks);
      if (fault === 'mode') {
        // Inject archive mode bits directly: Windows chmod cannot model Unix
        // executable permission changes on the source filesystem.
        const header = new tar.Header(encoded);
        header.mode = 0o755;
        header.encode(encoded);
      }
      await expect(verifyTarFileManifest(encoded, manifest)).rejects.toThrow(/Encoded archive/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('round-trips long ASCII, multibyte, deep and shared-prefix paths without host metadata', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-tar-paths-'));
    try {
      const archives: Buffer[] = [];
      for (const copy of [0, 1]) {
        const payload = join(root, `copy-${copy}`);
        for (const name of copy === 0 ? names : [...names].reverse()) {
          const file = join(payload, name);
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, `distinct content for ${name}\n`, { mode: 0o644 });
          utimesSync(file, epoch - copy * 10_000, epoch + copy * 10_000);
        }
        archives.push(await createDeterministicTarZstd(payload, epoch));
      }
      expect(archives[0]).toEqual(archives[1]);
      const decoded = zstdDecompressSync(archives[0]);
      const entries = new Map<string, Buffer>();
      const headers: string[] = [];
      const listing = tar.t({
        strict: true,
        onentry(entry) {
          expect(entry.type).toBe('File');
          expect(entries.has(entry.path)).toBe(false);
          const chunks: Buffer[] = [];
          entry.on('data', chunk => chunks.push(Buffer.from(chunk)));
          entry.on('end', () => entries.set(entry.path, Buffer.concat(chunks)));
        },
      });
      listing.on('meta', value => headers.push(String(value)));
      const completed = new Promise<void>((accept, reject) => {
        listing.on('error', reject);
        listing.on('end', accept);
      });
      listing.end(decoded);
      await completed;
      expect([...entries.keys()].sort()).toEqual([...names].sort());
      for (const name of names) expect(entries.get(name)).toEqual(readFileSync(join(root, 'copy-0', name)));
      expect(headers.length).toBeGreaterThan(0);
      expect(headers.join('')).not.toMatch(/(?:SCHILY\.|atime=|ctime=|uid=|gid=|uname=|gname=)/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
