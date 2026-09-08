#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import CosModule from 'cos-nodejs-sdk-v5';
import { readJson, canonicalJson } from './lib/canonical.mjs';
import { readPrivateKeyFromEnvironment, signCanonical } from './lib/signing.mjs';
import { verifySignedValue } from './verify-release-set.mjs';
import { verifySourceInputs } from './lib/source-manifest.mjs';
import { loadReleasePolicy, sourceEvidence } from './lib/release-policy.mjs';
import { verifyReleaseCandidate, createGitHubReader, candidateDigest } from './lib/release-gate.mjs';
import { TencentCosPublisher } from './lib/tencent-cos.mjs';
import { GitHubReleaseMirror, ProductionReleaseIO, loadReleaseAssets, assertReleaseDistribution } from './lib/release-backend.mjs';
import { publishRuntimeRelease } from './lib/release-publication.mjs';

export function assertPublisherEnvironment(env, policy) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REPOSITORY !== policy.repository
    || env.GITHUB_REF !== `refs/heads/${policy.branch}`
    || env.GITHUB_WORKFLOW_REF !== `${policy.repository}/.github/workflows/kernel-runtime-promote.yml@refs/heads/${policy.branch}`
    || !['workflow_dispatch', 'workflow_run', 'schedule'].includes(env.GITHUB_EVENT_NAME)
    || !['publish', 'maintain'].includes(env.RELEASE_MODE)) throw new Error('Untrusted protected publisher execution context');
  if (env.BOOTSTRAP === 'true' && (env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.RELEASE_MODE !== 'publish')) {
    throw new Error('Bootstrap is available only through explicit protected manual publication');
  }
}

async function main() {
  const policy = loadReleasePolicy();
  assertPublisherEnvironment(process.env, policy);
  const evidenceDir = resolve('temp/kernel-production-evidence');
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  const evidence = (name, value) => writeFileSync(join(evidenceDir, name), `${canonicalJson(value)}\n`, { mode: 0o600 });
  try {
    const distribution = readJson(resolve('resources/kernels/distribution.json'));
    const trustStore = readJson(resolve('temp/roots.production.json'));
    assertReleaseDistribution(policy, distribution);
    for (const kernelId of policy.kernelIds) verifySourceInputs({ repositoryRoot: process.cwd(), kernelId });
    const signingKey = readPrivateKeyFromEnvironment('CLAWX_CATALOG_SIGNING_PRIVATE_KEY_B64');
    const signingKeyId = required('CLAWX_CATALOG_SIGNING_KEY_ID');
    const proof = { purpose: 'protected-publisher-key-check' };
    verifySignedValue({ ...proof, signature: signCanonical(proof, signingKey, signingKeyId) }, 'signature', trustStore, 'catalog', new Date());
    let candidate;
    let descriptors;
    let assets = new Map();
    if (process.env.RELEASE_MODE === 'publish') {
      candidate = await verifyReleaseCandidate({ api: createGitHubReader(policy), policy,
        runId: required('STAGING_RUN_ID'), currentSources: sourceEvidence(process.cwd(), policy) });
      if (candidateDigest(candidate) !== required('EXPECTED_CANDIDATE_DIGEST')
        || candidate.sourceSha !== required('EXPECTED_SOURCE_SHA')) {
        throw new Error('Accepted candidate changed while waiting for production approval; rerun the read-only gate');
      }
      evidence('accepted-candidate.json', candidate);
      ({ descriptors, assets } = await loadReleaseAssets(resolve('temp/approved-artifacts'), { policy, trustStore, distribution, candidate }));
    }
    const COS = CosModule.default ?? CosModule;
    const cos = new TencentCosPublisher({
      client: new COS({ SecretId: required('TENCENTCLOUD_SECRET_ID'), SecretKey: required('TENCENTCLOUD_SECRET_KEY'),
        Protocol: 'https:', Timeout: 120_000 }),
      bucket: policy.cos.bucket, region: policy.cos.region, rootPrefix: policy.cos.rootPrefix,
    });
    const io = new ProductionReleaseIO({ policy, distribution, trustStore, cos,
      github: new GitHubReleaseMirror(policy), assets, evidenceDir });
    // Never mutate bucket policy or create a release before validating the target.
    evidence('bucket-preflight.json', await io.cosOperation(() => cos.verifyBucket({ requireUnversioned: true })));
    const result = await publishRuntimeRelease({ io, policy, distribution, trustStore, candidate, descriptors,
      signingKey, signingKeyId, bootstrap: process.env.BOOTSTRAP === 'true', now: new Date() });
    evidence('result.json', { ok: true, publisherSha: required('GITHUB_SHA'), ...result });
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } catch (error) {
    // No SDK objects, environment dumps, PEM values or signed URLs in evidence.
    const message = error instanceof Error ? error.message : 'Production publication failed';
    evidence('result.json', { ok: false, message });
    throw new Error(message);
  }
}

function required(name) {
  if (!process.env[name]) throw new Error(`${name} is required`);
  return process.env[name];
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { await main(); }
  catch (error) { process.stderr.write(`Production release stopped: ${error.message}\n`); process.exitCode = 1; }
}
