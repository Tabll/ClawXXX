// @vitest-environment node

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listMachOFiles } from '../../scripts/kernel-runtime/sign-macos-runtime.mjs';

describe('kernel platform signing and support evidence', () => {
  it('detects thin and universal Mach-O binaries without treating scripts as executables', () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-macho-'));
    writeFileSync(join(root, 'thin.node'), Buffer.from('feedfacf00000000', 'hex'));
    writeFileSync(join(root, 'universal'), Buffer.from('cafebabe00000000', 'hex'));
    writeFileSync(join(root, 'script.js'), '#!/usr/bin/env node\n');
    expect(listMachOFiles(root).map(path => path.split('/').at(-1))).toEqual(['thin.node', 'universal']);
  });

  it('requires accepted notarization and emits a canonical macOS security report', () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-platform-report-'));
    const signing = join(root, 'signing.json');
    const notarization = join(root, 'notarization.json');
    const output = join(root, 'platform.json');
    writeFileSync(signing, JSON.stringify({
      schemaVersion: 1, ok: true, platform: 'darwin',
      files: [{ root: 'node', path: 'bin/node', sha256: 'a'.repeat(64) }],
    }));
    writeFileSync(notarization, JSON.stringify({ status: 'Accepted', id: 'submission-id' }));
    execFileSync(process.execPath, [
      'scripts/kernel-runtime/write-platform-security-report.mjs',
      '--platform', 'darwin', '--arch', 'arm64', '--signing', signing,
      '--notarization', notarization, '--output', output,
    ], { cwd: process.cwd() });
    expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({
      ok: true,
      platform: 'darwin',
      arch: 'arm64',
      notarization: { status: 'Accepted', submissionId: 'submission-id' },
    });

    writeFileSync(notarization, JSON.stringify({ status: 'Invalid', id: 'submission-id' }));
    expect(() => execFileSync(process.execPath, [
      'scripts/kernel-runtime/write-platform-security-report.mjs',
      '--platform', 'darwin', '--arch', 'arm64', '--signing', signing,
      '--notarization', notarization, '--output', join(root, 'rejected.json'),
    ], { cwd: process.cwd(), stdio: 'pipe' })).toThrow();
  });

  it('keeps signing, notarization, Authenticode and Linux ABI gates in runtime CI', () => {
    const workflow = readFileSync(join(process.cwd(), '.github/workflows/kernel-runtime-build.yml'), 'utf8');
    expect(workflow).toContain('pnpm run build:lib:host');
    expect(workflow).not.toMatch(/pnpm run build:lib\s*(?:&&|\\|\n)/);
    expect(workflow).toContain('--config.node-linker=hoisted');
    expect(workflow).toContain('materialize-deploy-tree.mjs');
    expect(workflow).toContain('sign-macos-runtime.mjs');
    expect(workflow).toContain('notarytool submit');
    expect(workflow).toContain('sign-windows-runtime.ps1');
    expect(workflow).toContain('--platform linux');
    expect(workflow).toContain('--platform-security temp/reports/platform-security.json');
    const release = readFileSync(join(process.cwd(), '.github/workflows/release.yml'), 'utf8');
    const releaseBuilder = readFileSync(join(process.cwd(), 'electron-builder.release.yml'), 'utf8');
    const windowsSmoke = readFileSync(join(process.cwd(), 'scripts/windows-packaged-smoke.ps1'), 'utf8');
    expect(release).toContain('stapler validate');
    expect(release).toContain('windows-packaged-smoke.ps1');
    expect(release).toContain('CLAWX_WINDOWS_SIGNING_CERT_PFX_B64');
    expect(release).toContain('package:win:release');
    expect(release).not.toContain('skipping code signing');
    expect(releaseBuilder).toContain('forceCodeSigning: true');
    expect(releaseBuilder).toContain('verifyUpdateCodeSignature: true');
    expect(windowsSmoke).toContain('Get-AuthenticodeSignature');
    expect(windowsSmoke).toContain('Get-OwnedProcesses');
    expect(windowsSmoke).toContain('uninstallPreservedData');
  });
});
