// @vitest-environment node
import { mkdtemp, readFile, rm, symlink, mkdir, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { materializeDws } from '../../scripts/kernel-runtime/materialize-dws.mjs';
import { resolveDwsExecutable } from '@electron/channels/dingtalk-workspace-runtime';

describe('immutable DWS payload', () => {
  it.each(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64'])('assembles only the fixed %s binary and license notices', async target => {
    const root = await mkdtemp(join(tmpdir(), 'clawx-dws-payload-'));
    const [platform, arch] = target.split('-') as [NodeJS.Platform, string];
    try {
      const directory = await materializeDws({ packageRoot: resolve('node_modules/dingtalk-workspace-cli'), payload: root, platform, arch });
      expect(JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')).version).toBe('1.0.30');
      expect((await readFile(join(directory, 'LICENSE'), 'utf8')).length).toBeGreaterThan(100);
      expect((await readFile(join(directory, 'NOTICE'), 'utf8')).length).toBeGreaterThan(10);
      expect(await resolveDwsExecutable({ location: { source: 'installed-artifact', packageDir: root }, platform, arch }))
        .toBe(await realpath(join(directory, platform === 'win32' ? 'dws.exe' : 'dws')));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('does not fall back to host tools for an old installed artifact or accept an escaping binary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clawx-dws-missing-'));
    try {
      const input = { location: { source: 'installed-artifact', packageDir: root }, developmentRoot: process.cwd() };
      expect(await resolveDwsExecutable(input)).toBeUndefined();
      const tools = join(root, 'tools', 'dws'); await mkdir(tools, { recursive: true });
      await writeFile(join(tools, 'package.json'), JSON.stringify({ name: 'dingtalk-workspace-cli', version: '1.0.30' }));
      await symlink(process.execPath, join(tools, process.platform === 'win32' ? 'dws.exe' : 'dws'));
      expect(await resolveDwsExecutable(input)).toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
