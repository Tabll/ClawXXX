// @vitest-environment node

import { existsSync } from 'fs';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { testHome } = vi.hoisted(() => ({
  testHome: `/tmp/clawx-auth-sqlite-${Math.random().toString(36).slice(2)}`,
}));

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  const mocked = {
    ...actual,
    homedir: () => testHome,
  };
  return {
    ...mocked,
    default: mocked,
  };
});

async function writeJsonStore(agentId: string, store: Record<string, unknown>): Promise<void> {
  const dir = join(testHome, '.clawx', 'kernel-config', 'openclaw', 'agents', agentId, 'agent');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'auth-profiles.json'), JSON.stringify(store, null, 2), 'utf8');
}

describe('openclaw-auth-sqlite', () => {
  beforeEach(async () => {
    vi.resetModules();
    await rm(testHome, { recursive: true, force: true });
    const runtime = await import('@electron/kernels/openclaw/runtime-location');
    runtime.configureOpenClawRuntimeLocation(runtime.createDevelopmentOpenClawRuntimeLocation({
      packageDir: resolve('node_modules/openclaw'), userDataRoot: join(testHome, '.clawx'),
      artifactVersion: 'auth-regression', nodeExecutable: process.execPath,
    }));
  });

  it('migrates auth-profiles.json into openclaw-agent.sqlite when sqlite is empty', async () => {
    await writeJsonStore('main', {
      version: 1,
      profiles: {
        'custom-customc7:default': {
          type: 'api_key',
          provider: 'custom-customc7',
          key: 'sk-test-key',
        },
      },
      order: { 'custom-customc7': ['custom-customc7:default'] },
      lastGood: { 'custom-customc7': 'custom-customc7:default' },
    });

    const {
      migrateAuthProfilesJsonToSqliteIfNeeded,
      readAuthProfilesFromSqlite,
      getAuthProfilesSqlitePath,
    } = await import('@electron/utils/openclaw-auth-sqlite');

    const migrated = await migrateAuthProfilesJsonToSqliteIfNeeded('main');
    expect(migrated).toBe(true);
    expect(existsSync(getAuthProfilesSqlitePath('main'))).toBe(true);

    const sqliteStore = readAuthProfilesFromSqlite('main');
    expect(sqliteStore?.profiles['custom-customc7:default']).toMatchObject({
      type: 'api_key',
      provider: 'custom-customc7',
      key: 'sk-test-key',
    });
    expect(sqliteStore?.order?.['custom-customc7']).toEqual(['custom-customc7:default']);
    expect(sqliteStore?.lastGood?.['custom-customc7']).toBe('custom-customc7:default');
  });

  it('saveProviderKeyToOpenClaw writes credentials readable from sqlite', async () => {
    const { saveProviderKeyToOpenClaw } = await import('@electron/utils/openclaw-auth');
    const {
      readAuthProfilesFromSqlite,
      getAuthProfilesSqlitePath,
    } = await import('@electron/utils/openclaw-auth-sqlite');

    await saveProviderKeyToOpenClaw('custom-customc7', 'sk-runtime-key', 'main');

    expect(existsSync(getAuthProfilesSqlitePath('main'))).toBe(true);
    const sqliteStore = readAuthProfilesFromSqlite('main');
    expect(sqliteStore?.profiles['custom-customc7:default']).toMatchObject({
      type: 'api_key',
      provider: 'custom-customc7',
      key: 'sk-runtime-key',
    });

    const json = JSON.parse(
      await readFile(join(
        testHome,
        '.clawx',
        'kernel-config',
        'openclaw',
        'agents',
        'main',
        'agent',
        'auth-profiles.json',
      ), 'utf8'),
    ) as Record<string, unknown>;
    expect((json.profiles as Record<string, unknown>)['custom-customc7:default']).toMatchObject({
      key: 'sk-runtime-key',
    });
  });

  it('lets the kernel initialize the full schema and preserves its metadata during repeated auth writes', async () => {
    const { writeAuthProfilesToSqlite, getAuthProfilesSqlitePath, readAuthProfilesFromSqlite } = await import('@electron/utils/openclaw-auth-sqlite');
    await writeAuthProfilesToSqlite({ version: 1, profiles: {} }, 'main');
    const db = new DatabaseSync(getAuthProfilesSqlitePath('main'));
    try {
      const metadata = db.prepare('SELECT * FROM schema_meta ORDER BY meta_key').all();
      const version = db.prepare('PRAGMA user_version').get();
      expect(version).toMatchObject({ user_version: 19 });
      expect(db.prepare('PRAGMA table_info(session_participants)').all().map(column => column.name)).toContain('identity_namespace');
      db.prepare('INSERT INTO cache_entries(scope,key,value_json,updated_at) VALUES (?,?,?,?)').run('regression', 'keep', '{"keep":true}', 1);
      await writeAuthProfilesToSqlite({ version: 1, profiles: { 'synthetic:default': { type: 'api_key', provider: 'synthetic', key: 'test-secret' } } }, 'main');
      expect(db.prepare('PRAGMA user_version').get()).toEqual(version);
      expect(db.prepare('SELECT * FROM schema_meta ORDER BY meta_key').all()).toEqual(metadata);
      expect(db.prepare("SELECT value_json FROM cache_entries WHERE scope='regression'").get()?.value_json).toBe('{"keep":true}');
      expect(readAuthProfilesFromSqlite('main')?.profiles['synthetic:default'].key).toBe('test-secret');
      expect(db.prepare('PRAGMA quick_check').get()?.quick_check).toBe('ok');
    } finally { db.close(); }
  });

  it.each([1, 20])('fails closed for schema version %s without rewriting credentials or version markers', async (version) => {
    const { writeAuthProfilesToSqlite, getAuthProfilesSqlitePath } = await import('@electron/utils/openclaw-auth-sqlite');
    await writeAuthProfilesToSqlite({ version: 1, profiles: {} }, 'main');
    const db = new DatabaseSync(getAuthProfilesSqlitePath('main'));
    try {
      db.exec(`PRAGMA user_version=${version}`);
      db.prepare("UPDATE schema_meta SET schema_version=? WHERE meta_key='primary'").run(version);
      const original = db.prepare('SELECT * FROM auth_profile_store').all();
      await expect(writeAuthProfilesToSqlite({ version: 1, profiles: { denied: { type: 'api_key', provider: 'synthetic', key: 'must-not-leak' } } }, 'main')).rejects.toThrow('admission');
      expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(version);
      expect(db.prepare('SELECT * FROM auth_profile_store').all()).toEqual(original);
    } finally { db.close(); }
  });
});
