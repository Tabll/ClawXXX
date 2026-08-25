// @vitest-environment node

import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClawXDataBackupManager } from '@electron/data/data-backup-manager';
import { prepareClawXDataStore } from '@electron/data/data-recovery';
import { ClawXDataService } from '@electron/data/clawx-data-service';
import { asConversationId } from '@shared/conversations/contracts';

describe('WAL-aware backup, verification and corruption quarantine', () => {
  it('restores a consistent SQLite backup and preserves a verified Blob snapshot', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-backup-'));
    const databasePath = join(root, 'state', 'clawx.sqlite');
    const blobRoot = join(root, 'state', 'blobs');
    const destination = join(root, 'backups', 'snapshot-one');
    const service = new ClawXDataService(databasePath, undefined, blobRoot);
    const main = service.connect({ role: 'main' });
    await main.createConversation({
      id: asConversationId('backup-conversation'),
      title: 'Backup',
      createdAt: '2026-08-23T00:00:00.000Z',
    });
    const blob = await main.putBlob({
      data: new TextEncoder().encode('backup blob'),
      mimeType: 'text/plain',
      createdAt: '2026-08-23T00:00:00.000Z',
    });
    await main.addBlobRef({
      ownerType: 'backup-test', ownerId: 'one', blobHash: blob.hash, accessPolicy: {}, createdAt: '2026-08-23T00:00:00.000Z',
    });
    const manager = new ClawXDataBackupManager();
    const manifest = await manager.create({ client: main, blobRoot, destination });
    expect(manifest.files.some(file => file.path === 'clawx.sqlite')).toBe(true);
    expect(manifest.files.some(file => file.path.endsWith(blob.hash))).toBe(true);
    if (process.platform !== 'win32') {
      expect(statSync(destination).mode & 0o777).toBe(0o700);
      expect(statSync(join(destination, 'clawx.sqlite')).mode & 0o777).toBe(0o600);
      expect(statSync(join(destination, 'manifest.json')).mode & 0o777).toBe(0o600);
      expect(statSync(join(destination, 'blobs', 'objects', blob.hash.slice(0, 2), blob.hash)).mode & 0o777).toBe(0o600);
    }
    await service.close();

    writeFileSync(databasePath, 'corrupt sqlite bytes');
    const recovery = prepareClawXDataStore({
      databasePath,
      backupPath: join(destination, 'clawx.sqlite'),
      quarantineRoot: join(root, 'quarantine'),
      now: '2026-08-23T00:00:01.000Z',
    });
    expect(recovery.state).toBe('restored-backup');
    expect(recovery.quarantinePaths).toHaveLength(1);
    expect(readFileSync(recovery.quarantinePaths[0]!, 'utf8')).toBe('corrupt sqlite bytes');
    expect(existsSync(join(destination, 'blobs', 'objects', blob.hash.slice(0, 2), blob.hash))).toBe(true);

    const restoredRoot = join(root, 'explicit-restore');
    const explicitDatabase = join(restoredRoot, 'state', 'clawx.sqlite');
    const explicitBlobs = join(restoredRoot, 'state', 'blobs');
    expect(manager.restore({
      snapshot: destination,
      databasePath: explicitDatabase,
      blobRoot: explicitBlobs,
    }).quarantined).toEqual([]);
    const explicit = new ClawXDataService(explicitDatabase, undefined, explicitBlobs);
    const explicitMain = explicit.connect({ role: 'main' });
    expect(await explicitMain.getConversation(asConversationId('backup-conversation'))).toBeDefined();
    expect(existsSync(join(explicitBlobs, 'objects', blob.hash.slice(0, 2), blob.hash))).toBe(true);
    if (process.platform !== 'win32') {
      expect(statSync(explicitDatabase).mode & 0o777).toBe(0o600);
      expect(statSync(join(explicitBlobs, 'objects', blob.hash.slice(0, 2), blob.hash)).mode & 0o777).toBe(0o600);
    }
    await explicit.close();

    const restored = new ClawXDataService(databasePath, undefined, blobRoot);
    const restoredMain = restored.connect({ role: 'main' });
    expect(await restoredMain.getConversation(asConversationId('backup-conversation'))).toBeDefined();
    await restored.close();
  });

  it('detects a consistent read-only database and does not quarantine it', async () => {
    if (process.platform === 'win32') return;
    const root = mkdtempSync(join(tmpdir(), 'clawx-read-only-'));
    const databasePath = join(root, 'clawx.sqlite');
    const service = new ClawXDataService(databasePath);
    const main = service.connect({ role: 'main' });
    await main.createConversation({ id: asConversationId('read-only'), createdAt: '2026-08-23T00:00:00.000Z' });
    await service.close();
    chmodSync(databasePath, 0o400);
    const result = prepareClawXDataStore({ databasePath });
    expect(result.state).toBe('read-only');
    expect(result.quarantinePaths).toEqual([]);
    expect(result.diagnostic).toMatch(/mutation and runtime dispatch must remain disabled/);
    chmodSync(databasePath, 0o600);
  });
});
