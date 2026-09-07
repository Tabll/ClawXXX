// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateNativePayloads } from '../../scripts/kernel-runtime/lib/artifact.mjs';

const { nativePayloadAllowlist } = JSON.parse(readFileSync(join(process.cwd(), 'kernels/openclaw/runtime.json'), 'utf8')) as {
  nativePayloadAllowlist: Record<string, string[]>;
};
const fixtures = [
  { platform: 'darwin', arch: 'arm64', binary: '@esbuild/darwin-arm64/bin/esbuild', magic: 'cffaedfe' },
  { platform: 'darwin', arch: 'x64', binary: '@esbuild/darwin-x64/bin/esbuild', magic: 'cffaedfe' },
  { platform: 'linux', arch: 'arm64', binary: '@esbuild/linux-arm64/bin/esbuild', magic: '7f454c46' },
  { platform: 'linux', arch: 'x64', binary: '@esbuild/linux-x64/bin/esbuild', magic: '7f454c46' },
  // The integrity-pinned @esbuild/win32-x64 package puts its PE at the root.
  { platform: 'win32', arch: 'x64', binary: '@esbuild/win32-x64/esbuild.exe', magic: '4d5a0000' },
];

function withNativeFixture(binary: string, magic: string, inspect: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'clawx-esbuild-allowlist-'));
  try {
    const path = join(root, 'runtime/kernel/node_modules', binary);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(magic, 'hex'));
    inspect(root);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
}

describe('OpenClaw frozen esbuild executable allowlist', () => {
  it.each(fixtures)('audits the actual $platform/$arch package layout without executing it', ({ platform, arch, binary, magic }) => {
    withNativeFixture(binary, magic, root => {
      // Prove the native detector sees the fixture, including extensionless tools.
      expect(() => validateNativePayloads(root, platform, arch, [])).toThrow(/not in the audited native allowlist/);
      expect(() => validateNativePayloads(root, platform, arch, nativePayloadAllowlist[`${platform}-${arch}`])).not.toThrow();
    });
  });

  it.each(fixtures)('does not admit adjacent unreviewed $platform/$arch executables', ({ platform, arch, binary, magic }) => {
    withNativeFixture(`${binary}.unreviewed`, magic, root => {
      expect(() => validateNativePayloads(root, platform, arch, nativePayloadAllowlist[`${platform}-${arch}`])).toThrow(/not in the audited native allowlist/);
    });
  });

  it.each([
    { binary: '@esbuild/win32-x64/bin/esbuild.exe', error: /not in the audited native allowlist/ },
    { binary: '@esbuild/win32-x64/extra.exe', error: /not in the audited native allowlist/ },
    { binary: '@esbuild/win32-arm64/esbuild.exe', error: /another platform or architecture/ },
    { binary: '@esbuild/darwin-x64/bin/esbuild', error: /another platform or architecture/ },
    { binary: '@esbuild/linux-x64/bin/esbuild', error: /another platform or architecture/ },
  ])('rejects the obsolete or wrong-target Windows candidate $binary', ({ binary, error }) => {
    withNativeFixture(binary, '4d5a0000', root => {
      expect(() => validateNativePayloads(root, 'win32', 'x64', nativePayloadAllowlist['win32-x64'])).toThrow(error);
    });
  });
});
