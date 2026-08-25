// @vitest-environment node

import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClawXDataService } from '@electron/data/clawx-data-service';
import { canonicalJson } from '@electron/kernels/catalog';
import { KernelPackageManager } from '@electron/kernels/package-manager';
import type {
  KernelArtifactDescriptorV1,
  KernelCatalogEnvelopeV1,
  KernelTrustStoreV1,
} from '@shared/kernels/catalog';
import type { KernelDownloadProgress, KernelHostCompatibility } from '@shared/kernels/package-manager';

const artifactDir = process.env.CLAWX_REAL_ARTIFACT_DIR?.trim();
const trustPath = process.env.CLAWX_REAL_ARTIFACT_TRUST?.trim();
const evidencePath = process.env.CLAWX_REAL_ARTIFACT_EVIDENCE?.trim();
const required = process.env.CLAWX_REAL_ARTIFACT_REQUIRED === '1';
const realArtifactIt = required || (artifactDir && trustPath) ? it : it.skip;

describe('real signed runtime through the production KernelPackageManager path', () => {
  realArtifactIt('resumes, verifies, extracts, smoke-tests, activates, rescans, and uninstalls without deleting SQLite data', async () => {
    if (!artifactDir || !trustPath) {
      throw new Error('CLAWX_REAL_ARTIFACT_DIR and CLAWX_REAL_ARTIFACT_TRUST are required');
    }
    const [descriptorPath, archivePath] = await Promise.all([
      singleFile(artifactDir, '.descriptor.json'),
      singleFile(artifactDir, '.tar.zst'),
    ]);
    const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8')) as KernelArtifactDescriptorV1;
    const artifactTrust = JSON.parse(await readFile(trustPath, 'utf8')) as KernelTrustStoreV1;
    expect(descriptor).toMatchObject({
      platform: process.platform,
      arch: process.arch,
      storage: { authority: 'clawx-data-service', nativeDurableHistory: false },
    });

    const now = new Date(Date.parse(descriptor.publishedAt) + 60_000);
    const catalogKeys = generateKeyPairSync('ed25519');
    const catalogKeyId = `clean-machine-catalog-${descriptor.kernelId}-${descriptor.platform}-${descriptor.arch}`;
    const trustStore: KernelTrustStoreV1 = {
      schemaVersion: 1,
      keys: [
        ...artifactTrust.keys,
        {
          keyId: catalogKeyId,
          algorithm: 'Ed25519',
          purposes: ['catalog'],
          publicKeyPem: catalogKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
          notBefore: descriptor.publishedAt,
          notAfter: descriptor.expiresAt,
        },
      ],
    };
    const catalog = signedCatalog(descriptor, catalogKeyId, catalogKeys.privateKey, now);
    const archive = await readFile(archivePath);
    const split = Math.max(1, Math.floor(archive.byteLength / 2));
    const etag = `"${descriptor.archive.sha256}"`;
    const catalogUrl = 'https://clean-machine.invalid/catalog.staging.json';
    let archiveRequests = 0;
    let resumedWithExactIdentity = false;
    const fetcher = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url === catalogUrl) {
        const body = JSON.stringify(catalog);
        return new Response(body, {
          status: 200,
          headers: { ETag: '"clean-machine-catalog"', 'Content-Length': String(Buffer.byteLength(body)) },
        });
      }
      if (url !== descriptor.archive.url) return new Response('not found', { status: 404 });
      archiveRequests += 1;
      if (archiveRequests === 1) {
        let emitted = false;
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!emitted) {
              emitted = true;
              controller.enqueue(archive.subarray(0, split));
            } else {
              controller.error(new Error('clean-machine injected transport interruption'));
            }
          },
        });
        return new Response(body, {
          status: 200,
          headers: { ETag: etag, 'Content-Length': String(archive.byteLength) },
        });
      }
      const headers = new Headers(init?.headers);
      resumedWithExactIdentity = headers.get('range') === `bytes=${split}-`
        && headers.get('if-range') === etag;
      return new Response(archive.subarray(split), {
        status: 206,
        headers: {
          ETag: etag,
          'Content-Length': String(archive.byteLength - split),
          'Content-Range': `bytes ${split}-${archive.byteLength - 1}/${archive.byteLength}`,
        },
      });
    };

    const root = await mkdtemp(join(tmpdir(), `clawx-real-${descriptor.kernelId}-install-`));
    const data = new ClawXDataService(join(root, 'state', 'clawx.sqlite'));
    const state = data.connect({ role: 'main' });
    const progress: KernelDownloadProgress[] = [];
    const manager = new KernelPackageManager({
      root: join(root, 'kernels'),
      state,
      trustStore,
      host: compatibleHost(descriptor),
      now: () => now,
      fetcher,
    });
    try {
      await state.createConversation({
        id: 'clean-machine-preserved' as never,
        title: 'Preserved across real runtime uninstall',
        createdAt: now.toISOString(),
      });
      await expect(manager.installFromCatalog({
        kernelId: descriptor.kernelId,
        channel: 'staging',
        catalogUrls: [catalogUrl],
        onProgress: value => progress.push(value),
      })).rejects.toMatchObject({ code: 'download-failed' });

      const installed = await manager.installFromCatalog({
        kernelId: descriptor.kernelId,
        channel: 'staging',
        catalogUrls: [catalogUrl],
        onProgress: value => progress.push(value),
      });
      expect(resumedWithExactIdentity).toBe(true);
      expect(progress.some(value => value.phase === 'downloading' && value.resumed)).toBe(true);
      expect(installed).toMatchObject({
        activated: true,
        installation: {
          kernelId: descriptor.kernelId,
          activeVersion: descriptor.artifactVersion,
          state: 'installed',
        },
        version: { state: 'verified', archiveSha256: descriptor.archive.sha256 },
      });
      await expect(manager.rescan(descriptor.kernelId, descriptor.artifactVersion))
        .resolves.toMatchObject({ state: 'verified' });
      expect(await state.listKernelActivationHistory(descriptor.kernelId, 10))
        .toEqual(expect.arrayContaining([expect.objectContaining({ toVersion: descriptor.artifactVersion })]));

      const removed = await manager.uninstall(descriptor.kernelId);
      expect(removed).toMatchObject({ canonicalDataPreserved: true });
      expect(await state.getConversation('clean-machine-preserved' as never))
        .toMatchObject({ title: 'Preserved across real runtime uninstall' });

      const evidence = {
        schemaVersion: 1,
        ok: true,
        kernelId: descriptor.kernelId,
        artifactVersion: descriptor.artifactVersion,
        platform: descriptor.platform,
        arch: descriptor.arch,
        archiveSha256: descriptor.archive.sha256,
        catalogSignature: 'ephemeral-clean-machine-only',
        artifactSignatureVerified: true,
        rangeResumeVerified: resumedWithExactIdentity,
        safeExtractionVerified: true,
        controlBridgeSmokeVerified: true,
        atomicActivationVerified: true,
        integrityRescanVerified: true,
        uninstallPreservedCanonicalData: true,
      };
      if (evidencePath) await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    } finally {
      state.disconnect();
      await data.close();
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
  }, 10 * 60_000);
});

async function singleFile(root: string, suffix: string): Promise<string> {
  const matches = (await readdir(root, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith(suffix))
    .map(entry => join(root, entry.name));
  if (matches.length !== 1) throw new Error(`Expected exactly one ${suffix} in ${root}, found ${matches.length}`);
  return matches[0]!;
}

function signedCatalog(
  descriptor: KernelArtifactDescriptorV1,
  keyId: string,
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
  now: Date,
): KernelCatalogEnvelopeV1 {
  const issuedAt = now.toISOString();
  const expiresAt = new Date(Math.min(
    Date.parse(descriptor.expiresAt),
    now.getTime() + 60 * 60_000,
  )).toISOString();
  const unsigned = {
    schemaVersion: 1 as const,
    channel: 'staging' as const,
    sequence: 1,
    issuedAt,
    expiresAt,
    artifacts: [descriptor],
    revokedArtifactIdentities: [],
  };
  return {
    ...unsigned,
    catalogSignature: {
      algorithm: 'Ed25519',
      keyId,
      signature: sign(null, Buffer.from(canonicalJson(unsigned)), privateKey).toString('base64url'),
    },
  };
}

function compatibleHost(descriptor: KernelArtifactDescriptorV1): KernelHostCompatibility {
  return {
    hostVersion: '0.6.0',
    platform: process.platform,
    arch: process.arch,
    capabilityContractVersion: 1,
    chatProtocol: { name: 'acp', version: 1 },
    controlProtocol: { name: 'clawx-kernel', version: 1 },
    conversationStoreProtocol: { name: 'clawx-conversation-store', version: 1 },
    supportedNodeModuleAbis: [descriptor.node.moduleAbi],
  };
}
