// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import { createDiagnosticsApi } from '@electron/services/diagnostics-api';

describe('canonical kernel diagnostics', () => {
  it('binds artifact patch provenance and protocol data to the exact live generation', async () => {
    const manifest = {
      kernelId: 'deepseek-harness',
      artifactVersion: '0.1.2-alpha.2+clawx.9',
      upstreamVersion: '0.1.2-alpha.2',
      upstreamCommit: '0123456789abcdef',
      patchRevision: 9,
      platform: 'darwin',
      arch: 'arm64',
      protocols: {
        chat: { name: 'acp', min: 1, max: 1 },
        control: { name: 'clawx-kernel', min: 1, max: 1 },
        conversationStore: { name: 'clawx-conversation-store', min: 1, max: 1 },
      },
      archive: { sha256: 'archive-sha' },
      supplyChain: {
        fileManifestSha256: 'files-sha',
        patchSeriesSha256: 'patches-sha',
      },
    };
    const capabilities = {
      chat: true,
      cancel: true,
      permissions: true,
      resume: true,
      configuration: true,
      agents: true,
      providers: true,
      skills: true,
      channels: false,
      cron: true,
      usage: true,
      checkpointCodecs: ['deepseek-harness-agent'],
    };
    const kernels = {
      list: vi.fn(async () => [{
        kernelId: 'deepseek-harness',
        state: 'ready',
        generation: 4,
        version: '0.1.2-alpha.2',
        artifactVersion: manifest.artifactVersion,
        pid: 4242,
        ownership: 'clawx-owned',
        runtimeTransport: 'stdio-jsonl',
        startedAt: '2026-08-24T01:00:00.000Z',
        lastHealthAt: '2026-08-24T01:01:00.000Z',
        capabilities,
        restartCount: 1,
        restartBudget: 3,
        lastError: 'api_key=sk-diagnosticsecret123 path=/Users/private/project',
        diagnostics: [],
      }]),
      diagnostics: vi.fn(() => ({
        snapshot: {},
        crashes: [{ message: 'old failure' }],
        logs: [{ sequence: 9 }],
        logDirectory: '/safe/logs/deepseek-harness',
      })),
      getInstallation: vi.fn(async () => ({
        kernelId: 'deepseek-harness',
        state: 'installed',
        activeVersion: manifest.artifactVersion,
        lastKnownGoodVersion: manifest.artifactVersion,
        manifest,
        updatedAt: '2026-08-24T00:00:00.000Z',
      })),
      getRuntimeVersion: vi.fn(async (_kernelId: string, artifactVersion: string) => ({
        kernelId: 'deepseek-harness',
        artifactVersion,
        manifest,
      })),
      getDriver: vi.fn(() => undefined),
    };
    const gatewayManager = { getStatus: vi.fn(() => ({ state: 'stopped' })) };

    const snapshot = await createDiagnosticsApi({
      gatewayManager: gatewayManager as never,
      kernels: kernels as never,
    }).snapshot();

    expect(snapshot.kernels).toHaveLength(1);
    expect(snapshot.kernels[0]).toMatchObject({
      kernelId: 'deepseek-harness',
      artifact: {
        artifactVersion: manifest.artifactVersion,
        upstreamVersion: '0.1.2-alpha.2',
        patchRevision: 9,
        fileManifestSha256: 'files-sha',
      },
      protocol: {
        kernelContract: 'clawx.kernel/v1',
        runtimeTransport: 'stdio-jsonl',
        conversationStore: { name: 'clawx-conversation-store', min: 1, max: 1 },
      },
      process: {
        state: 'ready',
        generation: 4,
        pid: 4242,
        artifactVersion: manifest.artifactVersion,
      },
      health: { crashCount: 1, restartCount: 1, restartBudget: 3 },
      capabilities,
      logs: { entryCount: 1, lastSequence: 9 },
    });
    expect(snapshot.kernels[0].health.lastError).toContain('api_key=[redacted]');
    expect(snapshot.kernels[0].health.lastError).toContain('[redacted-path]');
    expect(JSON.stringify(snapshot)).not.toContain('sk-diagnosticsecret123');
    expect(kernels.getRuntimeVersion).toHaveBeenCalledWith(
      'deepseek-harness',
      manifest.artifactVersion,
    );
  });
});
