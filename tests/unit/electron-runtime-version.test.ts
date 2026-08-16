import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '../..');
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
};
const electronPackage = JSON.parse(
  readFileSync(resolve(root, 'node_modules/electron/package.json'), 'utf8'),
) as { version: string };
const electronPath = require('electron') as string;

function runWithElectronNode(args: string[]): string {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  return execFileSync(electronPath, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
  });
}

describe('Electron runtime baseline', () => {
  it('pins and installs Electron 43.4.0 exactly', () => {
    expect(manifest.devDependencies.electron).toBe('43.4.0');
    expect(electronPackage.version).toBe('43.4.0');
    expect(manifest.scripts['electron:download']).toBe('install-electron --no');
    expect(manifest.scripts.init).toContain('pnpm run electron:download');
  });

  it('ships the expected compatible Node and Chromium runtimes', () => {
    const versions = JSON.parse(runWithElectronNode([
      '-p',
      'JSON.stringify({ electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome })',
    ])) as { electron: string; node: string; chrome: string };

    expect(versions).toEqual({
      electron: '43.4.0',
      node: '24.18.1',
      chrome: '150.0.7871.224',
    });
  });

  it('starts the pinned OpenClaw ACP command with Electron Node', () => {
    const output = runWithElectronNode([
      resolve(root, 'node_modules/openclaw/openclaw.mjs'),
      'acp',
      '--help',
    ]);

    expect(output).toContain('Run an ACP bridge backed by the Gateway');
  });
});
