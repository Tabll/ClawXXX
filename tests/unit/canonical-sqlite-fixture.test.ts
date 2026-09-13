// @vitest-environment node
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { existsSync, linkSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClawXDataService } from '@electron/data/clawx-data-service';
import { CLAWX_DATA_SCHEMA_VERSION } from '@electron/data/schema';
import { asConversationId } from '@shared/conversations/contracts';
import { asAgentId, asCronJobId } from '@shared/domains/identity';
import { createCanonicalSqliteFixture } from '../fixtures/kernels/canonical-sqlite-fixture';
import { awaitArtifactOperations } from '../fixtures/kernels/artifact-test-support.mjs';

const fixtures: Awaited<ReturnType<typeof createCanonicalSqliteFixture>>[] = [];
const services: ClawXDataService[] = [];
const roots: string[] = [];
let prepared: Awaited<ReturnType<typeof fixture>>;
const policies: unknown[] = [];

beforeEach(async () => {
  policies.length = 0;
  const exec = DatabaseSync.prototype.exec;
  vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
    const result = exec.call(this, sql);
    if (sql.includes('PRAGMA synchronous = FULL')) policies.push({
      ...this.prepare('PRAGMA journal_mode').get(),
      ...this.prepare('PRAGMA synchronous').get(),
      ...this.prepare('PRAGMA foreign_keys').get(),
    });
    return result;
  });
  prepared = await fixture();
}, 5_000);

afterEach(async () => {
  try {
    await awaitArtifactOperations(services.splice(0).map(service => service.close()));
    for (const fixture of fixtures.splice(0)) fixture.dispose();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  } finally { vi.restoreAllMocks(); }
});

async function fixture() {
  const seed = await createCanonicalSqliteFixture();
  fixtures.push(seed);
  const root = mkdtempSync(join(tmpdir(), 'clawx-schema-copy-'));
  roots.push(root);
  return { seed, root };
}

describe('suite-local canonical SQLite fixtures', () => {
  it('creates the real schema and fsynced independent copies with WAL/FULL and isolated durable Conversation/Cron state', async () => {
    const { seed, root } = prepared;
    const flush = vi.spyOn(fs, 'fsyncSync');
    const sourceBytes = readFileSync(seed.databasePath);
    const aPath = join(root, 'a', 'clawx.sqlite');
    const bPath = join(root, 'b', 'clawx.sqlite');
    seed.copyTo(aPath);
    seed.copyTo(bPath);
    expect(flush).toHaveBeenCalledTimes(2);
    expect(readFileSync(aPath)).toEqual(sourceBytes);
    expect(readFileSync(bPath)).toEqual(sourceBytes);
    expect(statSync(aPath).nlink).toBe(1);
    expect(statSync(bPath).nlink).toBe(1);
    expect(statSync(aPath, { bigint: true }).ino).not.toBe(statSync(bPath, { bigint: true }).ino);
    const a = new ClawXDataService(aPath);
    const b = new ClawXDataService(bPath);
    services.push(a, b);
    const first = a.connect({ role: 'main' });
    const peer = b.connect({ role: 'main' });
    const conversationId = asConversationId('fixture-isolation');
    const jobId = asCronJobId('fixture-cron');
    await first.createConversation({ id: conversationId, title: 'only A', createdAt: '2026-09-13T00:00:00.000Z' });
    await first.putCronJob({
      id: jobId, name: 'only A', prompt: 'fixture', kernelId: 'openclaw', agentId: asAgentId('main'),
      schedule: { kind: 'interval', everyMs: 60_000, anchorAt: '2026-09-13T00:00:00.000Z' },
      conversationPolicy: 'reuse', misfirePolicy: 'run-once', overlapPolicy: 'queue',
      timeoutMs: 1_000, enabled: true, revision: 1,
      createdAt: '2026-09-13T00:00:00.000Z', updatedAt: '2026-09-13T00:00:00.000Z',
    });
    expect(await peer.getConversation(conversationId)).toBeUndefined();
    expect(await peer.listCronJobs()).toEqual([]);
    await a.close();
    services.splice(services.indexOf(a), 1);
    const reopened = new ClawXDataService(aPath);
    services.push(reopened);
    expect(await reopened.connect({ role: 'main' }).getConversation(conversationId)).toMatchObject({ title: 'only A' });
    expect((await reopened.connect({ role: 'main' }).listCronJobs()).map(job => job.id)).toEqual([jobId]);
    expect(await reopened.connect({ role: 'main' }).integrityCheck()).toBe('ok');
    expect(policies).toHaveLength(4);
    for (const policy of policies) expect(policy).toEqual({ journal_mode: 'wal', synchronous: 2, foreign_keys: 1 });
    const readback = new DatabaseSync(aPath, { readOnly: true });
    try { expect(readback.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: CLAWX_DATA_SCHEMA_VERSION }); }
    finally { readback.close(); }
    expect(readFileSync(seed.databasePath)).toEqual(sourceBytes);
  });

  it('refuses existing destinations and sidecars without overwriting any bytes', () => {
    const { seed, root } = prepared;
    const destination = join(root, 'existing.sqlite');
    writeFileSync(destination, 'owned sentinel');
    expect(() => seed.copyTo(destination)).toThrow('destination already exists');
    expect(readFileSync(destination, 'utf8')).toBe('owned sentinel');
    const withWal = join(root, 'with-wal.sqlite');
    writeFileSync(`${withWal}-wal`, 'owned journal');
    expect(() => seed.copyTo(withWal)).toThrow('destination already exists');
    expect(existsSync(withWal)).toBe(false);
    expect(readFileSync(`${withWal}-wal`, 'utf8')).toBe('owned journal');
  });

  it('rejects unclosed, aliased or mutated source bytes before creating a destination', () => {
    const { seed, root } = prepared;
    const destination = join(root, 'copy.sqlite');
    const wal = `${seed.databasePath}-wal`;
    writeFileSync(wal, 'test-owned incomplete journal');
    expect(() => seed.copyTo(destination)).toThrow('closed standalone regular file');
    rmSync(wal);
    const alias = join(dirname(seed.databasePath), 'alias.sqlite');
    linkSync(seed.databasePath, alias);
    expect(() => seed.copyTo(destination)).toThrow('closed standalone regular file');
    rmSync(alias);
    writeFileSync(seed.databasePath, 'test-owned damaged source');
    expect(() => seed.copyTo(destination)).toThrow('source changed');
    expect(existsSync(destination)).toBe(false);
  });

  it('disposes only the private source and refuses later copies, leaving owned destination files intact', () => {
    const { seed, root } = prepared;
    const destination = join(root, 'retained.sqlite');
    seed.copyTo(destination);
    const bytes = readFileSync(destination);
    seed.dispose();
    seed.dispose();
    expect(existsSync(seed.databasePath)).toBe(false);
    expect(readFileSync(destination)).toEqual(bytes);
    expect(() => seed.copyTo(join(root, 'after-dispose.sqlite'))).toThrow('disposed');
  });

  it('propagates a failed fsync and closes its handle without touching the source', () => {
    const { seed, root } = prepared;
    const bytes = readFileSync(seed.databasePath);
    const close = vi.spyOn(fs, 'closeSync');
    const flush = vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => { throw new Error('test-only flush failure'); });
    expect(() => seed.copyTo(join(root, 'unflushed.sqlite'))).toThrow('test-only flush failure');
    expect(flush).toHaveBeenCalledTimes(1);
    const fd = flush.mock.calls[0]![0];
    expect(close).toHaveBeenLastCalledWith(fd);
    expect(() => fs.fstatSync(fd)).toThrow(/EBADF/);
    expect(readFileSync(seed.databasePath)).toEqual(bytes);
  });
});
