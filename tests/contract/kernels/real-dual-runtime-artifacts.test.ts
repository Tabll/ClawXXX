// @vitest-environment node

import { appendFile, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClawXDataService } from '@electron/data/clawx-data-service';
import { KernelPackageManager } from '@electron/kernels/package-manager';
import { ControlBridgeSmokeTester } from '@electron/kernels/package-manager/smoke-test';
import type { KernelArtifactDescriptorV1, KernelTrustStoreV1 } from '@shared/kernels/catalog';
import type { KernelHostCompatibility } from '@shared/kernels/package-manager';

const openClawArtifactDir = process.env.CLAWX_REAL_OPENCLAW_ARTIFACT_DIR?.trim();
const dshArtifactDir = process.env.CLAWX_REAL_DSH_ARTIFACT_DIR?.trim();
const trustPath = process.env.CLAWX_REAL_DUAL_ARTIFACT_TRUST?.trim();
const evidencePath = process.env.CLAWX_REAL_DUAL_ARTIFACT_EVIDENCE?.trim();
const required = process.env.CLAWX_REAL_DUAL_ARTIFACT_REQUIRED === '1';
const dualArtifactIt = required || (openClawArtifactDir && dshArtifactDir && trustPath) ? it : it.skip;

describe('two real signed runtime artifacts on one clean machine', () => {
  dualArtifactIt('installs both, starts both control bridges concurrently, and preserves the other runtime and SQLite data on uninstall', async () => {
    if (!openClawArtifactDir || !dshArtifactDir || !trustPath) {
      throw new Error('Both real artifact directories and CLAWX_REAL_DUAL_ARTIFACT_TRUST are required');
    }
    const [openClaw, dsh, trustStore] = await Promise.all([
      artifactAt(openClawArtifactDir),
      artifactAt(dshArtifactDir),
      readFile(trustPath, 'utf8').then(value => JSON.parse(value) as KernelTrustStoreV1),
    ]);
    expect(openClaw.descriptor).toMatchObject({ kernelId: 'openclaw', platform: process.platform, arch: process.arch });
    expect(dsh.descriptor).toMatchObject({ kernelId: 'deepseek-harness', platform: process.platform, arch: process.arch });
    for (const artifact of [openClaw, dsh]) {
      expect(artifact.descriptor.storage).toMatchObject({
        authority: 'clawx-data-service',
        nativeDurableHistory: false,
      });
    }

    const publishedAt = Math.max(Date.parse(openClaw.descriptor.publishedAt), Date.parse(dsh.descriptor.publishedAt));
    const now = new Date(publishedAt + 60_000);
    const root = await mkdtemp(join(tmpdir(), 'clawx-real-dual-runtime-'));
    const data = new ClawXDataService(join(root, 'state', 'clawx.sqlite'));
    const state = data.connect({ role: 'main' });
    const manager = new KernelPackageManager({
      root: join(root, 'kernels'),
      state,
      trustStore,
      host: compatibleHost([openClaw.descriptor, dsh.descriptor]),
      now: () => now,
    });
    const smoke = new ControlBridgeSmokeTester();
    try {
      await state.createConversation({
        id: 'real-dual-preserved' as never,
        title: 'Shared data survives independent runtime uninstall',
        createdAt: now.toISOString(),
      });
      const [openInstalled, dshInstalled] = await Promise.all([
        manager.importOffline({ descriptorPath: openClaw.descriptorPath, archivePath: openClaw.archivePath }),
        manager.importOffline({ descriptorPath: dsh.descriptorPath, archivePath: dsh.archivePath }),
      ]);
      expect(openInstalled).toMatchObject({ activated: true, installation: { kernelId: 'openclaw' } });
      expect(dshInstalled).toMatchObject({ activated: true, installation: { kernelId: 'deepseek-harness' } });

      const [openHealth, dshHealth] = await Promise.all([
        smoke.test(manager.layout.installPath(openClaw.descriptor), openClaw.descriptor),
        smoke.test(manager.layout.installPath(dsh.descriptor), dsh.descriptor),
      ]);
      expect(openHealth.pid).not.toBe(dshHealth.pid);
      expect(openHealth.rssBytes).toBeGreaterThan(0);
      expect(dshHealth.rssBytes).toBeGreaterThan(0);

      await appendFile(
        join(manager.layout.installPath(openClaw.descriptor), openClaw.descriptor.entrypoints.control),
        '\n// clean-machine integrity failure injection\n',
      );
      await expect(manager.rescan('openclaw', openClaw.descriptor.artifactVersion))
        .rejects.toMatchObject({ code: 'artifact-integrity' });
      await expect(smoke.test(manager.layout.installPath(dsh.descriptor), dsh.descriptor))
        .resolves.toMatchObject({ rssBytes: expect.any(Number) });
      await expect(manager.repair('openclaw'))
        .resolves.toMatchObject({ activated: true, installation: { kernelId: 'openclaw' } });
      await expect(smoke.test(manager.layout.installPath(openClaw.descriptor), openClaw.descriptor))
        .resolves.toMatchObject({ rssBytes: expect.any(Number) });

      await expect(manager.uninstall('openclaw')).resolves.toMatchObject({ canonicalDataPreserved: true });
      await expect(manager.rescan('deepseek-harness', dsh.descriptor.artifactVersion))
        .resolves.toMatchObject({ state: 'verified' });
      await expect(smoke.test(manager.layout.installPath(dsh.descriptor), dsh.descriptor))
        .resolves.toMatchObject({ rssBytes: expect.any(Number) });
      expect(await state.getConversation('real-dual-preserved' as never))
        .toMatchObject({ title: 'Shared data survives independent runtime uninstall' });

      await expect(manager.uninstall('deepseek-harness'))
        .resolves.toMatchObject({ canonicalDataPreserved: true });
      expect(await state.getConversation('real-dual-preserved' as never)).toBeDefined();

      if (evidencePath) {
        await writeFile(evidencePath, `${JSON.stringify({
          schemaVersion: 1,
          ok: true,
          platform: process.platform,
          arch: process.arch,
          artifacts: [openClaw.descriptor, dsh.descriptor].map(descriptor => ({
            kernelId: descriptor.kernelId,
            artifactVersion: descriptor.artifactVersion,
            archiveSha256: descriptor.archive.sha256,
          })),
          sharedPackageManagerAndSQLite: true,
          concurrentControlBridgeStartup: true,
          distinctProcesses: true,
          independentIntegrityFailureAndRepair: true,
          independentUninstallAndRescan: true,
          canonicalDataPreserved: true,
        }, null, 2)}\n`, { mode: 0o600 });
      }
    } finally {
      state.disconnect();
      await data.close();
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
  }, 15 * 60_000);
});

async function artifactAt(root: string): Promise<{
  descriptor: KernelArtifactDescriptorV1;
  descriptorPath: string;
  archivePath: string;
}> {
  const [descriptorPath, archivePath] = await Promise.all([
    singleFile(root, '.descriptor.json'),
    singleFile(root, '.tar.zst'),
  ]);
  return {
    descriptor: JSON.parse(await readFile(descriptorPath, 'utf8')) as KernelArtifactDescriptorV1,
    descriptorPath,
    archivePath,
  };
}

async function singleFile(root: string, suffix: string): Promise<string> {
  const matches = (await readdir(root, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith(suffix))
    .map(entry => join(root, entry.name));
  if (matches.length !== 1) throw new Error(`Expected exactly one ${suffix} in ${root}, found ${matches.length}`);
  return matches[0]!;
}

function compatibleHost(descriptors: KernelArtifactDescriptorV1[]): KernelHostCompatibility {
  return {
    hostVersion: '0.6.0',
    platform: process.platform,
    arch: process.arch,
    capabilityContractVersion: 1,
    chatProtocol: { name: 'acp', version: 1 },
    controlProtocol: { name: 'clawx-kernel', version: 1 },
    conversationStoreProtocol: { name: 'clawx-conversation-store', version: 1 },
    supportedNodeModuleAbis: [...new Set(descriptors.map(descriptor => descriptor.node.moduleAbi))],
  };
}
