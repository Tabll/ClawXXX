// @vitest-environment node

import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { materializeDeployTree } from '../../scripts/kernel-runtime/materialize-deploy-tree.mjs';

describe('DSH deploy materialization', () => {
  it('retains hashed JavaScript chunks emitted by the overlay multi-entry builds', () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'kernels/deepseek-harness/overlay.manifest.json'), 'utf8')) as {
      root: string; files: Array<{ path: string }>;
    };
    const packages = manifest.files.filter(file => file.path.endsWith('/package.json'));
    expect(packages.length).toBeGreaterThan(0);
    for (const file of packages) {
      const pkg = JSON.parse(readFileSync(join(process.cwd(), manifest.root, file.path), 'utf8')) as { files: string[] };
      expect(pkg.files, file.path).toContain('lib/*.js');
      expect(pkg.files, file.path).not.toContain('lib/**');
    }
  });

  it('restores reviewed root metadata and removes generated builder paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-deploy-metadata-'));
    const workspace = join(root, 'workspace');
    const payload = join(root, 'payload');
    mkdirSync(join(workspace, 'packages', 'runtime'), { recursive: true });
    mkdirSync(join(payload, 'node_modules', '.pnpm'), { recursive: true });
    const reviewed = '{"name":"@clawx/runtime","version":"1.0.0"}\n';
    writeFileSync(join(workspace, 'packages', 'runtime', 'package.json'), reviewed);
    writeFileSync(join(payload, 'package.json'), '{"name":"@clawx/runtime","dependencies":{"test":"file:///builder/path"}}');
    writeFileSync(join(payload, 'pnpm-lock.yaml'), 'builder: /builder/path');
    writeFileSync(join(payload, 'node_modules', '.pnpm', 'lock.yaml'), 'builder: /builder/path');
    materializeDeployTree({
      payloadRoot: payload, workspaceRoot: workspace, platform: process.platform, rootPackage: 'packages/runtime',
    });
    expect(readFileSync(join(payload, 'package.json'), 'utf8')).toBe(reviewed);
    expect(() => lstatSync(join(payload, 'pnpm-lock.yaml'))).toThrow();
    expect(() => lstatSync(join(payload, 'node_modules', '.pnpm', 'lock.yaml'))).toThrow();
  });

  it('copies reviewed workspace packages without development node_modules', () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-deploy-'));
    const workspace = join(root, 'workspace');
    const payload = join(root, 'payload');
    const sourcePackage = join(workspace, 'vendor', 'package');
    const packageLink = join(payload, 'node_modules', '@vendor', 'package');
    mkdirSync(join(sourcePackage, 'lib'), { recursive: true });
    mkdirSync(join(sourcePackage, 'node_modules'), { recursive: true });
    mkdirSync(join(payload, 'node_modules', '@vendor'), { recursive: true });
    writeFileSync(join(sourcePackage, 'package.json'), '{"name":"@vendor/package","version":"1.0.0"}');
    writeFileSync(join(sourcePackage, 'lib', 'index.js'), 'export const ok = true;');
    writeFileSync(join(sourcePackage, 'node_modules', 'development-only'), 'no');
    symlinkSync(sourcePackage, packageLink, process.platform === 'win32' ? 'junction' : 'dir');

    const result = materializeDeployTree({ payloadRoot: payload, workspaceRoot: workspace, platform: process.platform });
    expect(result.directories).toBe(1);
    expect(lstatSync(packageLink).isDirectory()).toBe(true);
    expect(readFileSync(join(packageLink, 'lib', 'index.js'), 'utf8')).toContain('ok = true');
    expect(() => lstatSync(join(packageLink, 'node_modules'))).toThrow();
    expect(allLinks(payload)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('replaces POSIX .bin links with regular executable shims', () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-deploy-bin-'));
    const workspace = join(root, 'workspace');
    const payload = join(root, 'payload');
    const target = join(payload, 'node_modules', 'tool', 'bin.js');
    const link = join(payload, 'node_modules', '.bin', 'tool');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(join(payload, 'node_modules', 'tool'), { recursive: true });
    mkdirSync(join(payload, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(target, '#!/usr/bin/env node\nconsole.log("ok")\n');
    chmodSync(target, 0o755);
    symlinkSync('../tool/bin.js', link, 'file');

    const result = materializeDeployTree({ payloadRoot: payload, workspaceRoot: workspace, platform: 'darwin' });
    expect(result.binShims).toBe(1);
    expect(lstatSync(link).isFile()).toBe(true);
    expect(readFileSync(link, 'utf8')).toContain('exec node');
    expect(allLinks(payload)).toEqual([]);
  });
});

function allLinks(root: string): string[] {
  const result: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) result.push(path);
      else if (stat.isDirectory()) pending.push(path);
    }
  }
  return result;
}
