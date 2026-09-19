// @vitest-environment node
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { resolveComputerRuntime } from '@electron/kernels/computer-use-runtime';
import { materializeCua, suppressWindowsConsoleWindow } from '../../scripts/kernel-runtime/materialize-cua.mjs';

it('does not fall back to development tools for missing or escaping installed CUA payloads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clawx-cua-resolve-'));
  const input = { location: { source: 'installed-artifact', packageDir: root }, developmentRoot: process.cwd(), platform: 'darwin' as const, arch: 'arm64' };
  try {
    expect(await resolveComputerRuntime(input)).toBeUndefined();
    const tool = join(root, 'tools/cua'); const sdk = join(tool, 'node_modules/@trycua/cua-driver');
    await mkdir(join(sdk, 'dist'), { recursive: true });
    await writeFile(join(tool, 'package.json'), JSON.stringify({ name: '@clawx/cua-tool', version: '0.25.0' }));
    await writeFile(join(sdk, 'package.json'), JSON.stringify({ name: '@trycua/cua-driver', version: '0.25.0' }));
    await writeFile(join(sdk, 'dist/index.js'), ''); await writeFile(join(sdk, 'dist/electron.js'), '');
    await writeFile(join(tool, 'cua-driver'), 'fixture executable');
    expect((await resolveComputerRuntime(input))?.key).toBe(await realpath(tool));
    await rm(join(tool, 'cua-driver')); await symlink(process.execPath, join(tool, 'cua-driver'));
    expect(await resolveComputerRuntime(input)).toBeUndefined();
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('rejects an unreviewed download before creating a payload and omits unsupported targets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clawx-cua-download-'));
  try {
    await expect(materializeCua({ payload: root, platform: 'darwin', arch: 'arm64', fetchImpl: async () => new Response('counterfeit') })).rejects.toThrow('digest');
    await expect(readFile(join(root, 'tools/cua/package.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(materializeCua({ payload: root, platform: 'linux', arch: 'x64', fetchImpl: () => { throw new Error('must not download'); } })).resolves.toEqual({ supported: false });
    await mkdir(join(root, 'tools/cua'), { recursive: true });
    await writeFile(join(root, 'tools/cua/owned-file'), 'keep');
    await expect(materializeCua({ payload: root, platform: 'darwin', arch: 'arm64', ifMissing: true, fetchImpl: () => { throw new Error('must not download'); } })).rejects.toThrow();
    expect(await readFile(join(root, 'tools/cua/owned-file'), 'utf8')).toBe('keep');
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('patches only the verified PE subsystem field and rejects an unexpected executable layout', () => {
  const binary = Buffer.alloc(256); binary.writeUInt16LE(0x5a4d, 0); binary.writeUInt32LE(64, 0x3c);
  binary.writeUInt32LE(0x00004550, 64); binary.writeUInt16LE(0x20b, 88); binary.writeUInt16LE(3, 156);
  const expected = Buffer.from(binary); expected.writeUInt16LE(2, 156);
  suppressWindowsConsoleWindow(binary); expect(binary).toEqual(expected);
  suppressWindowsConsoleWindow(binary); expect(binary).toEqual(expected);
  expect(() => suppressWindowsConsoleWindow(Buffer.alloc(256))).toThrow();
  binary.writeUInt16LE(9, 156); expect(() => suppressWindowsConsoleWindow(binary)).toThrow();
});
