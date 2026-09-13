import { createHash } from 'node:crypto';
import fs from 'node:fs';
import {
  constants, copyFileSync, existsSync, lstatSync,
  mkdirSync, mkdtempSync, openSync, readFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ClawXDataService } from '@electron/data/clawx-data-service';
import { createArtifactTestTrace } from './artifact-test-support.mjs';

const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

/**
 * Test-only, suite-local pristine schema. Bootstrap through the production
 * service once; behavior tests still open independent, durable WAL/FULL files.
 * Never use this in schema/migration tests or seed it from user/runtime data.
 */
export async function createCanonicalSqliteFixture(evidencePath?: string) {
  const trace = createArtifactTestTrace(evidencePath);
  const root = mkdtempSync(join(tmpdir(), 'clawx-schema-fixture-'));
  const databasePath = join(root, 'clawx.sqlite');
  let service: ClawXDataService | undefined;
  let closed = false;
  let ok = false;
  try {
    trace.phase('schema-create');
    service = new ClawXDataService(databasePath);
    trace.phase('schema-close');
    await service.close();
    closed = true;
    const digest = hash(databasePath);
    const assertClosedSource = () => {
      const info = lstatSync(databasePath);
      if (!info.isFile() || info.nlink !== 1
        || ['-wal', '-shm', '-journal'].some(suffix => existsSync(databasePath + suffix))) {
        throw new Error('SQLite fixture source must be a closed standalone regular file');
      }
      if (hash(databasePath) !== digest) throw new Error('SQLite fixture source changed');
    };
    assertClosedSource();
    let disposed = false;
    trace.phase('schema-ready');
    ok = true;
    return {
      // Exposed only to regression tests of source immutability/ownership.
      databasePath,
      copyTo(destination: string): void {
        if (disposed) throw new Error('SQLite fixture is disposed');
        assertClosedSource();
        if (['', '-wal', '-shm', '-journal'].some(suffix => existsSync(destination + suffix))) {
          throw new Error('SQLite fixture destination already exists');
        }
        mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
        // Ordinary exclusive copy, never a link, shared connection or memory DB.
        copyFileSync(databasePath, destination, constants.COPYFILE_EXCL);
        const fd = openSync(destination, 'r+');
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        if (hash(destination) !== digest) throw new Error('SQLite fixture copy changed');
      },
      dispose(): void {
        if (disposed) return;
        rmSync(root, { recursive: true, force: true, maxRetries: 3 });
        disposed = true;
      },
    };
  } catch (error) {
    // Never remove a database whose owner could still have an open handle.
    if (service && !closed) { await service.close(); closed = true; }
    if (closed) rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    throw error;
  } finally {
    trace.stop(ok);
  }
}
