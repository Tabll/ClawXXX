// @vitest-environment node

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditRuntimeLicenses } from '../../scripts/kernel-runtime/audit-licenses.mjs';

const basePolicy = {
  schemaVersion: 1,
  allowedLicenses: ['MIT', 'GPL-3.0'],
  overrides: [{ name: 'legacy', version: '1.0.0', license: 'MIT', evidence: 'frozen source' }],
  inheritance: [{ namePattern: '^@owner/', versionPattern: '^2\\.', license: 'MIT', evidence: 'monorepo' }],
  obligations: [{
    id: 'gpl-source', packagePattern: '^copyleft$', licensePattern: '^GPL-3\\.0$',
    actions: ['publish source'], source: 'https://example.invalid/source',
  }],
};

function payload(packages: Array<{ name: string; version: string; license?: string }>): string {
  const root = mkdtempSync(join(tmpdir(), 'clawx-license-audit-'));
  packages.forEach((pkg, index) => {
    const directory = join(root, String(index));
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'package.json'), JSON.stringify(pkg));
  });
  return root;
}

describe('kernel runtime license audit', () => {
  it('resolves frozen overrides/inheritance and records copyleft obligations', () => {
    const report = auditRuntimeLicenses({
      payloadRoot: payload([
        { name: 'permissive', version: '1.0.0', license: 'MIT' },
        { name: 'legacy', version: '1.0.0' },
        { name: '@owner/internal', version: '2.4.0' },
        { name: 'copyleft', version: '3.0.0', license: 'GPL-3.0' },
      ]),
      kernelId: 'fixture',
      policy: basePolicy,
    });
    expect(report).toMatchObject({ ok: true, uniquePackages: 4, obligationIds: ['gpl-source'] });
    expect(report.packages.find(item => item.name === 'legacy')).toMatchObject({ license: 'MIT', resolution: 'override' });
    expect(report.packages.find(item => item.name === '@owner/internal')).toMatchObject({ resolution: 'inherited' });
  });

  it('rejects unknown, explicitly unlicensed and untracked copyleft packages', () => {
    expect(() => auditRuntimeLicenses({
      payloadRoot: payload([{ name: 'unknown', version: '1.0.0' }]), kernelId: 'fixture', policy: basePolicy,
    })).toThrow(/Missing and unreviewed/);
    expect(() => auditRuntimeLicenses({
      payloadRoot: payload([{ name: 'legacy', version: '1.0.0', license: 'UNLICENSED' }]), kernelId: 'fixture', policy: basePolicy,
    })).toThrow(/Forbidden license metadata/);
    expect(() => auditRuntimeLicenses({
      payloadRoot: payload([{ name: 'other-gpl', version: '1.0.0', license: 'GPL-3.0' }]), kernelId: 'fixture', policy: basePolicy,
    })).toThrow(/no explicit redistribution obligation/);
  });

  it('retains the Windows sharp compound license and explicit bundled-libvips obligation', () => {
    const report = auditRuntimeLicenses({
      payloadRoot: payload([{
        name: '@img/sharp-win32-x64', version: '0.35.3', license: 'Apache-2.0 AND LGPL-3.0-or-later',
      }]),
      kernelId: 'deepseek-harness',
    });
    expect(report).toMatchObject({ ok: true, obligationIds: ['sharp-win32-libvips-lgpl'] });
    expect(report.packages).toEqual([expect.objectContaining({
      name: '@img/sharp-win32-x64', version: '0.35.3',
      license: 'Apache-2.0 AND LGPL-3.0-or-later', resolution: 'declared',
      obligationId: 'sharp-win32-libvips-lgpl',
    })]);
  });

  it('never treats an Apache AND LGPL expression as an optional permissive branch', () => {
    for (const name of ['unreviewed-bundle', '@img/sharp-win32-arm64', '@img/sharp-win32-x64-extra']) {
      expect(() => auditRuntimeLicenses({
        payloadRoot: payload([{ name, version: '0.35.3', license: 'Apache-2.0 AND LGPL-3.0-or-later' }]),
        kernelId: 'deepseek-harness',
      })).toThrow(/no explicit redistribution obligation/);
    }
  });
});
