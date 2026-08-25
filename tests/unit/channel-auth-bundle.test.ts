// @vitest-environment node

import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  captureChannelAuthBundle,
  restoreChannelAuthBundle,
  safeChannelProjectionPath,
} from '@electron/channels/channel-auth-bundle';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'clawx-channel-auth-'));
  roots.push(root);
  return root;
}

describe('canonical Channel auth bundles', () => {
  it('captures deterministically and restores a private disposable projection', async () => {
    const root = await temporaryRoot();
    const source = join(root, 'source');
    await mkdir(join(source, 'keys'), { recursive: true });
    await writeFile(join(source, 'z.json'), 'z');
    await writeFile(join(source, 'keys', 'a.json'), 'a');

    const first = await captureChannelAuthBundle(source);
    const second = await captureChannelAuthBundle(source);
    expect(first).toBe(second);
    expect(JSON.parse(first).files.map((entry: { path: string }) => entry.path)).toEqual([
      'keys/a.json',
      'z.json',
    ]);

    const target = join(root, 'target');
    await restoreChannelAuthBundle(target, first);
    expect(await readFile(join(target, 'keys', 'a.json'), 'utf8')).toBe('a');
    expect((await stat(join(target, 'keys', 'a.json'))).mode & 0o777).toBe(0o600);
  });

  it('treats an absent connector projection as an empty bundle', async () => {
    const root = await temporaryRoot();
    expect(JSON.parse(await captureChannelAuthBundle(join(root, 'missing')))).toEqual({ version: 1, files: [] });
  });

  it.each([
    ['path traversal', { version: 1, files: [{ path: '../escape', dataBase64: 'YQ==' }] }],
    ['platform path ambiguity', { version: 1, files: [{ path: 'keys\\a', dataBase64: 'YQ==' }] }],
    ['case collision', { version: 1, files: [
      { path: 'keys/A', dataBase64: 'YQ==' },
      { path: 'keys/a', dataBase64: 'Yg==' },
    ] }],
    ['malformed base64', { version: 1, files: [{ path: 'keys/a', dataBase64: 'not base64' }] }],
  ])('rejects %s without replacing the existing projection', async (_label, malicious) => {
    const root = await temporaryRoot();
    const target = join(root, 'target');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'existing'), 'preserved');
    await expect(restoreChannelAuthBundle(target, JSON.stringify(malicious))).rejects.toThrow();
    expect(await readFile(join(target, 'existing'), 'utf8')).toBe('preserved');
  });

  it('encodes account ids into a single projection path segment', async () => {
    const root = await temporaryRoot();
    expect(safeChannelProjectionPath(root, '../../account')).toBe(join(root, '..%2F..%2Faccount'));
  });
});
