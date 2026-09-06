import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assembleKernelArtifact, validateNativePayloads } from '../../scripts/kernel-runtime/lib/artifact.mjs';
import {
  scanRuntimeDataDirectory,
  scanRuntimeDataPaths,
} from '../../scripts/kernel-runtime/lib/storage-contract.mjs';
import { applyStrictPatchSeries } from '../../scripts/kernel-runtime/lib/source-manifest.mjs';
import { describe, expect, it } from 'vitest';

const officialNodeSha256 = 'af5cfaeafe603aaf7599f287fd9d100bb41f16794f49788fa59dd3f25546930f';

describe('kernel runtime build supply chain', () => {
  it('keeps optional kernel payloads out of the base Electron package pipeline', () => {
    const builder = readFileSync(join(process.cwd(), 'electron-builder.yml'), 'utf8');
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const afterPack = readFileSync(join(process.cwd(), 'scripts', 'after-pack.cjs'), 'utf8');
    const installer = readFileSync(join(process.cwd(), 'scripts', 'installer.nsh'), 'utf8');

    expect(builder).not.toMatch(/from:\s*["']?build\/openclaw/i);
    expect(builder).not.toMatch(/resources\/openclaw/i);
    expect(packageJson.scripts.build).not.toContain('bundle-openclaw');
    expect(packageJson.scripts.package).not.toContain('bundle-openclaw');
    expect(packageJson.scripts.release).not.toContain('bundle-openclaw');
    expect(afterPack).not.toMatch(/build[\\/]openclaw|resources[\\/]openclaw/i);
    expect(installer).not.toMatch(/taskkill[^\n]+openclaw-gateway/i);
  });

  it('creates byte-for-byte deterministic signed tar.zst artifacts with traceable metadata', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-artifact-test-'));
    try {
      const payload = join(root, 'payload');
      const nodeRuntime = join(root, 'node-runtime');
      mkdirSync(payload, { recursive: true });
      mkdirSync(join(nodeRuntime, 'bin'), { recursive: true });
      writeFileSync(join(payload, 'openclaw.mjs'), 'export const runtime = "fixture";\n');
      writeFileSync(join(payload, 'clawx-openclaw.mjs'), 'import "./openclaw.mjs";\n');
      writeFileSync(join(payload, 'clawx-control-bridge.mjs'), 'process.stdout.write("ready\\n");\n');
      writeFileSync(join(payload, 'package.json'), JSON.stringify({ name: 'openclaw-fixture', version: '1.0.0', license: 'MIT' }));
      writeFileSync(join(nodeRuntime, 'bin', 'node'), '#!/bin/sh\nexit 0\n');
      writeFileSync(join(nodeRuntime, 'LICENSE'), 'Node fixture license\n');
      chmodSync(join(nodeRuntime, 'bin', 'node'), 0o755);
      const tests = join(root, 'tests.json');
      const storage = join(root, 'storage.json');
      const licenses = join(root, 'licenses.json');
      const platformSecurity = join(root, 'platform-security.json');
      writeFileSync(tests, JSON.stringify({ schemaVersion: 1, ok: true, suites: ['fixture'] }));
      writeFileSync(storage, JSON.stringify(successfulStorageReport()));
      writeFileSync(licenses, JSON.stringify({
        schemaVersion: 1,
        ok: true,
        kernelId: 'openclaw',
        packages: [{ name: 'openclaw-fixture', version: '1.0.0', license: 'MIT' }],
      }));
      writeFileSync(platformSecurity, JSON.stringify({
        schemaVersion: 1, ok: true, platform: 'darwin', arch: 'arm64', codeSigning: { fixture: true },
      }));
      const { privateKey } = generateKeyPairSync('ed25519');
      const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
      const common = {
        repositoryRoot: process.cwd(),
        kernelId: 'openclaw',
        platform: 'darwin',
        arch: 'arm64',
        payloadDir: payload,
        nodeDir: nodeRuntime,
        nodeDistributionSha256: officialNodeSha256,
        testReportPath: tests,
        storageReportPath: storage,
        licenseReportPath: licenses,
        platformSecurityReportPath: platformSecurity,
        artifactBaseUrl: 'https://artifacts.example.test/staging',
        artifactSigningKeyId: 'artifact-test-1',
        artifactSigningPrivateKey: privateKeyPem,
      };
      const first = await assembleKernelArtifact({ ...common, outputDir: join(root, 'first') });
      const second = await assembleKernelArtifact({ ...common, outputDir: join(root, 'second') });

      expect(readFileSync(first.archivePath)).toEqual(readFileSync(second.archivePath));
      expect(readFileSync(first.descriptorPath)).toEqual(readFileSync(second.descriptorPath));
      expect(first.descriptor.artifactVersion).toBe('2026.7.1-2+clawx.6');
      expect(first.descriptor.storage).toMatchObject({ authority: 'clawx-data-service', nativeDurableHistory: false });
      expect(first.descriptor.supplyChain).toEqual(expect.objectContaining({
        sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        lockfileSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        patchSeriesSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        sbomSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        provenanceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        licenseReportSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        platformSecurityReportSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }));
      expect(readFileSync(first.archivePath).subarray(0, 4).toString('hex')).toBe('28b52ffd');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects unreviewed and wrong-target native payloads', () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-native-test-'));
    try {
      mkdirSync(join(root, 'runtime', 'kernel', 'node_modules', 'unknown'), { recursive: true });
      const addon = join(root, 'runtime', 'kernel', 'node_modules', 'unknown', 'addon.node');
      writeFileSync(addon, Buffer.from('7f454c4602010100', 'hex'));
      expect(() => validateNativePayloads(root, 'darwin', 'arm64', [])).toThrow(/not in the audited native allowlist/);
      expect(() => validateNativePayloads(root, 'darwin', 'arm64', ['runtime/kernel/node_modules/unknown/**'])).not.toThrow();

      mkdirSync(join(root, 'runtime', 'kernel', 'node_modules', 'linux-x64'), { recursive: true });
      writeFileSync(join(root, 'runtime', 'kernel', 'node_modules', 'linux-x64', 'addon.node'), Buffer.from('7f454c4602010100', 'hex'));
      expect(() => validateNativePayloads(root, 'darwin', 'arm64', ['runtime/kernel/node_modules/**'])).toThrow(/another platform/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires every managed storage scenario and rejects native durable history', () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-storage-scan-'));
    try {
      mkdirSync(join(root, 'cache'), { recursive: true });
      mkdirSync(join(root, 'logs'), { recursive: true });
      writeFileSync(join(root, 'cache', 'disposable.bin'), 'cache');
      writeFileSync(join(root, 'logs', 'diagnostics.jsonl'), '{"ok":true}\n');
      expect(scanRuntimeDataPaths(root)).toMatchObject({ ok: true, violations: [] });
      expect(scanRuntimeDataDirectory(root, successfulScenarios())).toMatchObject({ ok: true, nativeDurableHistory: false });

      mkdirSync(join(root, 'sessions'), { recursive: true });
      writeFileSync(join(root, 'sessions', 'run.jsonl'), '{}\n');
      expect(scanRuntimeDataPaths(root)).toMatchObject({ ok: false });
      expect(scanRuntimeDataDirectory(root, successfulScenarios())).toMatchObject({ ok: false });
      expect(() => scanRuntimeDataDirectory(root, { ...successfulScenarios(), restart: false })).toThrow(/restart/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['darwin', 'arm64'], ['darwin', 'x64'], ['linux', 'arm64'], ['linux', 'x64'], ['win32', 'x64'],
  ])('prunes foreign native addons and ConPTY but preserves the %s/%s closure', (platform, arch) => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-native-prune-'));
    try {
      const payload = join(root, 'payload');
      const nodeModules = join(payload, 'node_modules');
      const targets = [['darwin', 'arm64'], ['darwin', 'x64'], ['linux', 'arm64'], ['linux', 'x64'], ['win32', 'x64']];
      const packages = targets.flatMap(([os, cpu]) => [
        { path: `@koromix/koffi-${os}-${cpu}`, keep: os === platform && cpu === arch },
        { path: `node-addon-require-builtin-${os}-${cpu}${os === 'linux' ? '-gnu' : os === 'win32' ? '-msvc' : ''}`, keep: os === platform && cpu === arch },
        { path: `@img/sharp-${os}-${cpu}`, keep: os === platform && cpu === arch },
        { path: `node-pty/prebuilds/${os}-${cpu}`, keep: os === platform && cpu === arch },
      ]).concat([
        { path: '@deepseek-ai/node-addon-landlock-run-linux-x64', keep: platform === 'linux' && arch === 'x64' },
        { path: '@deepseek-ai/node-addon-landlock-run-linux-arm64', keep: platform === 'linux' && arch === 'arm64' },
        { path: '@koromix/koffi-linux-x64/linux_x64', keep: platform === 'linux' && arch === 'x64' },
        { path: '@koromix/koffi-linux-arm64/linux_arm64', keep: platform === 'linux' && arch === 'arm64' },
        { path: '@koromix/koffi-linux-x64/musl_x64', keep: false },
        { path: '@koromix/koffi-linux-arm64/musl_arm64', keep: false },
        { path: 'node-pty/third_party/conpty/1.22.250204002/win10-x64', keep: platform === 'win32' && arch === 'x64' },
        { path: 'node-pty/third_party/conpty/1.22.250204002/win10-arm64', keep: false },
        { path: '@deepseek-ai/dsh-subprocess-local', keep: true },
        { path: '@koromix/unrelated-package', keep: true },
      ]);
      for (const entry of packages) {
        mkdirSync(join(nodeModules, entry.path), { recursive: true });
        writeFileSync(join(nodeModules, entry.path, 'marker'), entry.path);
      }
      const unrelated = join(root, 'outside-payload');
      mkdirSync(unrelated);
      writeFileSync(join(unrelated, 'keep'), 'user data');
      execFileSync(process.execPath, [
        join(process.cwd(), 'scripts/kernel-runtime/prune-native-payload.mjs'),
        '--payload', payload, '--platform', platform, '--arch', arch,
      ], { stdio: 'pipe' });
      for (const entry of packages) expect(existsSync(join(nodeModules, entry.path)), entry.path).toBe(entry.keep);
      expect(readFileSync(join(unrelated, 'keep'), 'utf8')).toBe('user data');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('binds clean-machine evidence to real managed runtime entrypoints and the focused host suites', () => {
    const smoke = readFileSync(join(process.cwd(), 'scripts/kernel-runtime/runtime-artifact-smoke.mjs'), 'utf8');
    const workflow = readFileSync(join(process.cwd(), '.github/workflows/kernel-runtime-build.yml'), 'utf8');

    expect(smoke).toContain('smokeOpenClawManagedEntrypoint');
    expect(smoke).toContain("[chatPath, '--version']");
    expect(smoke).toContain('smokeDeepSeekHarnessHost');
    expect(smoke).toContain('scanRuntimeDataPaths(managedDataRoot)');
    expect(workflow).toContain('tests/contract/kernels/openclaw-conversation-store.test.ts');
    expect(workflow).toContain('tests/e2e/chat-acp-session-controls.spec.ts');
    expect(workflow).toContain('tests/e2e/agents-multi-kernel.spec.ts');
    expect(workflow).toContain('runtime-artifact-smoke.json');
    expect(workflow).toContain('write-staging-artifact-trust.mjs');
    expect(workflow).toContain('tests/contract/kernels/real-runtime-artifact-install.test.ts');
    expect(workflow).toContain('package-manager-artifact-install.json');
    expect(workflow).toContain('tests/contract/kernels/real-dual-runtime-artifacts.test.ts');
    expect(workflow).toContain('kernel-runtime-openclaw-${{ matrix.target.platform }}-${{ matrix.target.arch }}');
    expect(workflow).toContain('kernel-runtime-deepseek-harness-${{ matrix.target.platform }}-${{ matrix.target.arch }}');
    expect(workflow).toContain('dual-runtime-artifact-smoke.json');
    expect(workflow).toContain('kernel-evidence-${{ matrix.kernel }}-clean-machine');
    expect(workflow).toContain('pnpm run comms:replay && pnpm run comms:compare');
    expect(workflow).not.toMatch(/temp\/publish[^\n]+staging-artifact-trust/);
  });

  it('makes complete validation, three-platform E2E and live kernel distribution drills hard release prerequisites', () => {
    const workflow = readFileSync(join(process.cwd(), '.github/workflows/release.yml'), 'utf8');

    expect(workflow).toContain('pnpm run test && pnpm run release:multi-kernel:validate');
    expect(workflow).toContain('needs: [validate-release, validate-kernel-distribution]');
    expect(workflow).toContain('environment: kernel-production');
    expect(workflow).toContain('scripts/kernel-runtime/distribution-drill.mjs');
    expect(workflow).toContain('--kernels openclaw,deepseek-harness');
    expect(workflow).toContain('Run Electron E2E on Linux before packaging');
    expect(workflow).toContain('Run Electron E2E on macOS before packaging');
    expect(workflow).toContain('Run Electron E2E on Windows before packaging');
  });

  it('refuses to manufacture anonymous or incomplete build evidence', () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-build-evidence-'));
    const script = join(process.cwd(), 'scripts', 'kernel-runtime', 'write-build-report.mjs');
    try {
      const output = join(root, 'scenarios.json');
      const proof = join(root, 'vitest.json');
      const suites = [
        'tests/contract/data/blob-and-conversation-store.test.ts',
        'tests/contract/domains/channels-runtime.test.ts',
        'tests/contract/domains/scheduler.test.ts',
        'tests/contract/kernels/conversation-router.test.ts',
        'tests/contract/kernels/data-service-spike.test.ts',
        'tests/contract/kernels/history-cutover.test.ts',
        'tests/contract/kernels/kernel-driver-contract.test.ts',
        'tests/contract/kernels/openclaw-runtime-dir.test.ts',
      ];
      writeFileSync(proof, JSON.stringify(vitestProof(suites)));
      expect(() => execFileSync(process.execPath, [
        script, '--type', 'scenarios', '--kernel', 'openclaw', '--output', output,
        '--suites', suites.join(','), '--vitest-report', proof, '--completed', 'new,prompt',
      ], { stdio: 'pipe' })).toThrow(/Storage scenario evidence must exactly cover/);
      expect(() => execFileSync(process.execPath, [
        script, '--type', 'tests', '--kernel', 'openclaw', '--output', output,
        '--suites', '', '--vitest-report', proof,
      ], { stdio: 'pipe' })).toThrow(/must name at least one completed test suite/);
      expect(() => execFileSync(process.execPath, [
        script, '--type', 'scenarios', '--kernel', 'openclaw', '--output', output,
        '--suites', suites.filter(suite => !suite.includes('scheduler')).join(','),
        '--vitest-report', proof, '--completed', 'new,prompt,cancel,compact,branch,restart,cron,channel',
      ], { stdio: 'pipe' })).toThrow(/Storage scenario proof is incomplete/);

      execFileSync(process.execPath, [
        script, '--type', 'scenarios', '--kernel', 'openclaw', '--output', output,
        '--suites', suites.join(','), '--vitest-report', proof,
        '--completed', 'new,prompt,cancel,compact,branch,restart,cron,channel',
      ], { stdio: 'pipe' });
      expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({
        ok: true,
        kernelId: 'openclaw',
        evidenceKind: 'verified-source-contract-suites',
        suites,
        completedScenarios: ['new', 'prompt', 'cancel', 'compact', 'branch', 'restart', 'cron', 'channel'],
        vitestProof: { totalTests: suites.length, passedTests: suites.length, verifiedSuites: suites.length },
        restart: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('applies only exact recorded patches and rejects offset application', () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-patch-test-'));
    try {
      const clean = createGitFixture(join(root, 'clean'), 'head\nalpha\none\nomega\ntail\n');
      const patchPath = join(root, 'change.patch');
      writeFileSync(patchPath, patchText());
      const source = { patches: [{ path: 'change.patch' }] };
      expect(applyStrictPatchSeries({ repositoryRoot: root, checkoutRoot: clean, source })).toEqual(['value.txt']);
      expect(readFileSync(join(clean, 'value.txt'), 'utf8')).toBe('head\nalpha\ntwo\nomega\ntail\n');

      const shifted = createGitFixture(join(root, 'shifted'), 'zero\nhead\nalpha\none\nomega\ntail\n');
      expect(() => applyStrictPatchSeries({ repositoryRoot: root, checkoutRoot: shifted, source })).toThrow(/fuzz or offset/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function successfulScenarios() {
  return {
    new: true,
    prompt: true,
    cancel: true,
    compact: true,
    branch: true,
    restart: true,
    cron: true,
    channel: true,
  };
}

function successfulStorageReport() {
  return {
    schemaVersion: 1,
    ok: true,
    authority: 'clawx-data-service',
    nativeDurableHistory: false,
    scenarios: successfulScenarios(),
    scannedPaths: [],
    violations: [],
  };
}

function vitestProof(suites: string[]) {
  return {
    success: true,
    numTotalTests: suites.length,
    numPassedTests: suites.length,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults: suites.map(suite => ({
      name: join(process.cwd(), suite),
      status: 'passed',
      assertionResults: [{ status: 'passed' }],
    })),
  };
}

function createGitFixture(path: string, content: string) {
  mkdirSync(path, { recursive: true });
  execFileSync('git', ['init', '--quiet'], { cwd: path });
  execFileSync('git', ['config', 'user.name', 'ClawX Test'], { cwd: path });
  execFileSync('git', ['config', 'user.email', 'tests@claw-x.invalid'], { cwd: path });
  writeFileSync(join(path, 'value.txt'), content);
  execFileSync('git', ['add', 'value.txt'], { cwd: path });
  execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: path });
  return path;
}

function patchText() {
  return [
    'diff --git a/value.txt b/value.txt',
    '--- a/value.txt',
    '+++ b/value.txt',
    '@@ -2,3 +2,3 @@',
    ' alpha',
    '-one',
    '+two',
    ' omega',
    '',
  ].join('\n');
}
