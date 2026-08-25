// @vitest-environment node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildDeepSeekHarnessEnvironment,
  resolveDeepSeekHarnessRuntimeLocation,
} from '@electron/kernels/deepseek-harness/runtime-location';
import type { KernelArtifactDescriptorV1 } from '@shared/kernels/catalog';
import type { KernelInstallationRecord } from '@shared/kernels/package-manager';
import { isKernelStdioMessage, type KernelStdioEvent } from '@shared/kernels/runtime-protocol';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const hash = 'a'.repeat(64);

function descriptor(overrides: Partial<KernelArtifactDescriptorV1> = {}): KernelArtifactDescriptorV1 {
  return {
    schemaVersion: 1,
    kernelId: 'deepseek-harness',
    displayName: 'DeepSeek Harness',
    upstreamVersion: '0.1.1-rc.2',
    upstreamCommit: 'b150a551b8d465e31e418e1b2eaf5e79bbb7d28e',
    patchRevision: 3,
    artifactVersion: '0.1.1-rc.2+clawx.3',
    platform: 'win32',
    arch: 'x64',
    minHostVersion: '0.6.0',
    maxHostVersion: '0.6.x',
    capabilityContractVersion: 1,
    protocols: {
      chat: { name: 'acp', min: 1, max: 1 },
      control: { name: 'clawx-kernel', min: 1, max: 1 },
      conversationStore: { name: 'clawx-conversation-store', min: 1, max: 1 },
    },
    checkpointCodecs: [{ id: 'deepseek-harness-agent', schemaVersion: 1, portable: false }],
    storage: { authority: 'clawx-data-service', nativeDurableHistory: false, regressionReportSha256: hash },
    node: { version: '24.15.0', moduleAbi: 137, distributionSha256: hash },
    archive: {
      format: 'tar.zst', url: 'https://artifacts.example.test/dsh.tar.zst', sha256: hash,
      compressedSize: 1, unpackedSize: 2, fileCount: 3,
    },
    entrypoints: {
      chat: 'runtime/kernel/node_modules/@clawx/dsh-acp-bridge/lib/index.js',
      control: 'runtime/kernel/node_modules/@clawx/dsh-control-bridge/lib/bin.js',
      host: 'runtime/kernel/lib/bin.js',
    },
    supplyChain: {
      sourceSha256: hash, lockfileSha256: hash, patchSeriesSha256: hash,
      fileManifestSha256: hash, sbomSha256: hash, noticesSha256: hash,
      provenanceSha256: hash, testReportSha256: hash,
    },
    budgets: { coldReadyMs: 30_000, idleRssBytes: 512 * 1024 * 1024 },
    publishedAt: '2026-08-23T00:00:00.000Z',
    expiresAt: '2027-08-23T00:00:00.000Z',
    descriptorSignature: { algorithm: 'Ed25519', keyId: 'test', signature: 'x' },
    ...overrides,
  };
}

function installation(manifest = descriptor()): KernelInstallationRecord {
  return {
    kernelId: 'deepseek-harness',
    state: 'installed',
    activeVersion: manifest.artifactVersion,
    manifest,
    updatedAt: '2026-08-23T00:00:00.000Z',
  };
}

describe('DeepSeek Harness managed driver/runtime contract', () => {
  it('binds launch paths and capability identity to the verified installation', () => {
    const location = resolveDeepSeekHarnessRuntimeLocation({
      installation: installation(),
      packageRoot: '/managed/kernels',
      userDataRoot: '/managed/user-data',
      platform: 'win32',
      requireFiles: false,
    });
    expect(location.entryPath).toBe('/managed/kernels/deepseek-harness/installs/0.1.1-rc.2+clawx.3/runtime/kernel/lib/bin.js');
    expect(location.nodeExecutable).toMatch(/runtime\/node\/node\.exe$/);
    expect(location.capabilitiesDigest).toBe(hash);
    expect(buildDeepSeekHarnessEnvironment(location, 9)).toMatchObject({
      CLAWX_KERNEL_ID: 'deepseek-harness',
      CLAWX_KERNEL_GENERATION: '9',
      CLAWX_KERNEL_CAPABILITIES_DIGEST: hash,
      CLAWX_DISABLE_NATIVE_HISTORY: '1',
      CLAWX_DISABLE_NATIVE_SCHEDULER: '1',
      DSH_DISABLE_NATIVE_SCHEDULER: '1',
      CLAWX_CONVERSATION_STORE_PROTOCOL: 'clawx.conversation-store/v1',
    });

    expect(() => resolveDeepSeekHarnessRuntimeLocation({
      installation: installation(descriptor({ entrypoints: { host: '../escape.js' } })),
      packageRoot: '/managed/kernels',
      userDataRoot: '/managed/user-data',
      requireFiles: false,
    })).toThrow(/escapes the verified/);
  });

  it('ships one protocol host and excludes DSH Web/native durable persistence from its composition', () => {
    const runtime = JSON.parse(readFileSync(join(root, 'kernels/deepseek-harness/runtime.json'), 'utf8')) as {
      artifactVersion: string; entrypoints: Record<string, string>;
    };
    const source = JSON.parse(readFileSync(join(root, 'kernels/deepseek-harness/source.json'), 'utf8')) as {
      artifactVersion: string; git: { commit: string };
    };
    const hostSource = readFileSync(join(root,
      'kernels/deepseek-harness/overlay/packages/runtime/clawx-runtime-host/src/index.ts'), 'utf8');
    const binSource = readFileSync(join(root,
      'kernels/deepseek-harness/overlay/packages/runtime/clawx-runtime-host/src/bin.ts'), 'utf8');
    const artifactSmoke = readFileSync(join(root,
      'scripts/kernel-runtime/runtime-artifact-smoke.mjs'), 'utf8');
    const buildWorkflow = readFileSync(join(root,
      '.github/workflows/kernel-runtime-build.yml'), 'utf8');
    const hostPackage = JSON.parse(readFileSync(join(root,
      'kernels/deepseek-harness/overlay/packages/runtime/clawx-runtime-host/package.json'), 'utf8')) as {
      files: string[]; dependencies: Record<string, string>;
    };

    expect(source.git.commit).toBe('b150a551b8d465e31e418e1b2eaf5e79bbb7d28e');
    expect(runtime.artifactVersion).toBe(source.artifactVersion);
    expect(runtime.entrypoints).toEqual({
      chat: 'runtime/kernel/node_modules/@clawx/dsh-acp-bridge/lib/index.js',
      control: 'runtime/kernel/node_modules/@clawx/dsh-control-bridge/lib/bin.js',
      host: 'runtime/kernel/lib/bin.js',
    });
    expect(hostPackage.files).toEqual(expect.arrayContaining(['lib/bin.js', 'lib/home-lock.js', 'lib/invariant.js']));
    expect(hostPackage.dependencies).not.toHaveProperty('@deepseek-ai/dsh-session-persistence-jsonl');
    expect(hostPackage.dependencies).not.toHaveProperty('@deepseek-ai/dsh-session-persistence-sqlite');
    expect(hostPackage.dependencies).not.toHaveProperty('@deepseek-ai/dsh-settings-file');
    expect(hostSource).not.toMatch(/dsh-web|session-persistence-jsonl|session-persistence-sqlite|settings-file/);
    expect(hostSource).toContain("tools: { mode: 'native' }");
    expect(hostSource).toContain("request.method === 'session.new'");
    expect(hostSource).toContain("request.method === 'runtime.selfTest'");
    expect(binSource).toContain('process.stdout.write =');
    expect(binSource).toContain("component: 'clawx-dsh-runtime'");
    expect(artifactSmoke).toContain("await request('host-self-test', 'runtime.selfTest')");
    expect(buildWorkflow).toContain("CLAWX_DSH_RUN_SANDBOX_SMOKE: '1'");
  });

  it('replays the frozen rich protocol golden with strict ordered run identity', () => {
    const frames = readFileSync(join(root,
      'tests/fixtures/kernels/replay/deepseek-harness-runtime.jsonl'), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line) as unknown);
    expect(frames.every(isKernelStdioMessage)).toBe(true);
    const ready = frames[0] as { type: string; capabilities: Record<string, unknown> };
    expect(ready).toMatchObject({
      type: 'ready',
      capabilities: {
        chat: true, cancel: true, permissions: true, resume: true,
        configuration: true, agents: true, providers: true, skills: true, usage: true,
        checkpointCodecs: ['deepseek-harness-agent'],
      },
    });
    const events = frames.filter((frame): frame is KernelStdioEvent => (
      (frame as { type?: unknown }).type === 'event'
    ));
    expect(events.map(event => event.eventSeq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(events.map(event => event.event.kind)).toEqual([
      'assistant.delta', 'reasoning.visibility', 'tool.start', 'tool.result',
      'usage', 'assistant.final', 'run.terminal',
    ]);
    expect(new Set(events.map(event => JSON.stringify(event.identity))).size).toBe(1);
    expect(events.at(-1)?.event.payload).toEqual({ outcome: 'completed' });
  });
});
