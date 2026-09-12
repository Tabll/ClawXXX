// @vitest-environment node
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import nodeRuntime from '../../kernels/node-runtime.json';
import { buildKernelNodeEnvironment, resolveDevelopmentKernelNode } from '@electron/kernels/node-runtime';
import { pickKernelNodeElectronHostEnvironment } from '../e2e/fixtures/kernel-node-environment';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('isolated real-Node Electron test environment', () => {
  it('preserves Xvfb display authentication without inheriting the original home or secrets', () => {
    const source = Object.freeze({ DISPLAY: ':99', XAUTHORITY: '/tmp/xvfb-run.fixture/Xauthority',
      PATH: '/usr/bin', HOME: '/home/runner', USERPROFILE: '/home/runner', OPENAI_API_KEY: 'test-only',
      NODE_OPTIONS: '--require unsafe.cjs', NODE_PATH: '/unsafe', ELECTRON_RUN_AS_NODE: '1',
      ELECTRON_OVERRIDE_DIST_PATH: '/unsafe', ELECTRON_DISABLE_SANDBOX: '1' });
    expect(pickKernelNodeElectronHostEnvironment(source)).toEqual({ DISPLAY: ':99',
      XAUTHORITY: '/tmp/xvfb-run.fixture/Xauthority', PATH: '/usr/bin', ELECTRON_DISABLE_SANDBOX: '1' });
    expect(source.HOME).toBe('/home/runner');
  });

  it('preserves native Windows launch variables without inheriting user data directories', () => {
    expect(pickKernelNodeElectronHostEnvironment({ Path: 'C:\\Windows\\System32', SystemRoot: 'C:\\Windows',
      ComSpec: 'C:\\Windows\\System32\\cmd.exe', PATHEXT: '.COM;.EXE;.CMD', LANG: 'en_US.UTF-8',
      APPDATA: 'C:\\Users\\runner\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\runner\\AppData\\Local' }))
      .toEqual({ Path: 'C:\\Windows\\System32', SystemRoot: 'C:\\Windows',
        ComSpec: 'C:\\Windows\\System32\\cmd.exe', PATHEXT: '.COM;.EXE;.CMD', LANG: 'en_US.UTF-8' });
  });

  it('does not invent an X display or authority when the host supplies neither', () => {
    expect(pickKernelNodeElectronHostEnvironment({ DISPLAY: undefined, XAUTHORITY: '' })).toEqual({});
  });
});

describe('kernel standalone Node selection', () => {
  it('fails closed instead of falling back to Electron or system PATH', () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-node-missing-'));
    roots.push(root);
    expect(() => resolveDevelopmentKernelNode(root)).toThrow('kernel:dev:prepare');
  });

  it('requires the current platform pinned receipt and executable', () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-node-pin-'));
    roots.push(root);
    const target = `${process.platform}-${process.arch}`;
    const directory = join(root, 'temp/kernel-node', nodeRuntime.version, target);
    const node = join(directory, process.platform === 'win32' ? 'node.exe' : 'bin/node');
    mkdirSync(dirname(node), { recursive: true });
    writeFileSync(node, 'fixture; never executed');
    const asset = nodeRuntime.assets.find(item => `${item.platform}-${item.arch}` === target)!;
    const receipt = { version: nodeRuntime.version, moduleAbi: nodeRuntime.moduleAbi,
      platform: process.platform, arch: process.arch, sourceSha256: asset.sha256 };
    const receiptPath = join(directory, 'CLAWX_NODE_RUNTIME.json');
    writeFileSync(receiptPath, JSON.stringify(receipt));
    expect(resolveDevelopmentKernelNode(root)).toBe(node);
    for (const invalid of [{ sourceSha256: 'unverified' }, { version: '25.0.0' }, { moduleAbi: 1 }, { arch: 'wrong' }]) {
      writeFileSync(receiptPath, JSON.stringify({ ...receipt, ...invalid }));
      expect(() => resolveDevelopmentKernelNode(root)).toThrow('missing or invalid');
    }
  });

  it('sanitizes the final environment without changing the source or losing unrelated settings', () => {
    const node = join(tmpdir(), 'runtime with spaces', 'node');
    const base = { PATH: '/other/bin', ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ASAR: '1',
      ELECTRON_OVERRIDE_DIST_PATH: '/wrong', NODE_OPTIONS: '--require /wrong.cjs', NODE_PATH: '/wrong',
      OPENCLAW_GATEWAY_TOKEN: 'test-only', HTTPS_PROXY: 'http://127.0.0.1:7890' };
    const env = buildKernelNodeEnvironment(node, base);
    expect(env.PATH).toBe(`${dirname(node)}${delimiter}/other/bin`);
    expect(Object.keys(env).filter(key => /^(ELECTRON_|NODE_OPTIONS$|NODE_PATH$)/.test(key))).toEqual([]);
    expect(env.OPENCLAW_GATEWAY_TOKEN).toBe('test-only');
    expect(env.HTTPS_PROXY).toBe(base.HTTPS_PROXY);
    expect(base.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(buildKernelNodeEnvironment(node, env)).toEqual(env);
    expect(() => buildKernelNodeEnvironment('node', base)).toThrow('absolute');
  });
});
