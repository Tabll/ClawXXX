import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertExactKeys, sha256Bytes } from './canonical.mjs';

export function loadReleasePolicy(root = process.cwd()) {
  const policy = JSON.parse(readFileSync(join(root, 'kernels/release-policy.json'), 'utf8'));
  const matrix = JSON.parse(readFileSync(join(root, 'kernels/platform-matrix.json'), 'utf8'));
  return validateReleasePolicy({ ...policy, targets: matrix.targets.filter(item => item.release === 'required')
    .map(({ platform, arch }) => ({ platform, arch })) });
}

export function validateReleasePolicy(policy) {
  assertExactKeys(policy, ['schemaVersion', 'repository', 'branch', 'buildWorkflow', 'e2eWorkflow', 'kernelIds',
    'e2eJobs', 'catalogLifetimeHours', 'renewBeforeHours', 'downloadGraceHours', 'githubReleaseTag',
    'publicationBackends', 'historicalArtifactBaseUrls', 'targets']);
  if (policy.schemaVersion !== 2 || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(policy.repository)
    || policy.branch !== 'main') throw new Error('Invalid trusted release repository/branch');
  for (const name of [policy.buildWorkflow, policy.e2eWorkflow]) {
    if (!/^\.github\/workflows\/[a-z0-9-]+\.ya?ml$/.test(name)) throw new Error('Invalid release workflow path');
  }
  if (!Array.isArray(policy.kernelIds) || !policy.kernelIds.length || policy.kernelIds.length > 32
    || new Set(policy.kernelIds).size !== policy.kernelIds.length
    || policy.kernelIds.some(id => !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id))) throw new Error('Invalid enabled release kernels');
  if (!Array.isArray(policy.targets) || !policy.targets.length || policy.targets.length > 32
    || new Set(policy.targets.map(targetKey)).size !== policy.targets.length
    || policy.targets.some(t => !['darwin', 'linux', 'win32'].includes(t.platform) || !['x64', 'arm64'].includes(t.arch))) {
    throw new Error('Invalid required release targets');
  }
  if (!Array.isArray(policy.e2eJobs) || policy.e2eJobs.length !== 3 || new Set(policy.e2eJobs).size !== 3
    || policy.e2eJobs.some(name => typeof name !== 'string' || name.length > 128)) throw new Error('Invalid required E2E jobs');
  for (const key of ['catalogLifetimeHours', 'renewBeforeHours', 'downloadGraceHours']) {
    if (!Number.isSafeInteger(policy[key]) || policy[key] < 1 || policy[key] > 720) throw new Error(`Invalid ${key}`);
  }
  if (policy.renewBeforeHours >= policy.catalogLifetimeHours) throw new Error('Renewal threshold must precede catalog expiry');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(policy.githubReleaseTag)) throw new Error('Invalid kernel release tag');
  if (JSON.stringify(policy.publicationBackends) !== JSON.stringify(['github-release'])) {
    throw new Error('Unsupported protected publication backends');
  }
  if (!Array.isArray(policy.historicalArtifactBaseUrls) || policy.historicalArtifactBaseUrls.length > 16) {
    throw new Error('Invalid historical artifact roots');
  }
  for (const value of policy.historicalArtifactBaseUrls) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/')) {
      throw new Error('Invalid historical artifact root');
    }
  }
  return policy;
}

// Only enabled backends are transport destinations. Historical roots above are
// identity-validation inputs and must never be used for network I/O or deletion.
export function releaseDistribution(policy) {
  validateReleasePolicy(policy);
  const base = `https://github.com/${policy.repository}/releases/download/${policy.githubReleaseTag}/`;
  return { schemaVersion: 1, channel: 'production', mirrorBaseUrls: [base],
    catalogUrls: [`${base}kernel-catalog.production.json`] };
}

export function targetKey({ platform, arch }) { return `${platform}-${arch}`; }
export function artifactIdentity(d) { return `${d.kernelId}/${d.artifactVersion}/${targetKey(d)}`; }
export function artifactSlot(d) { return `${d.kernelId}/${targetKey(d)}`; }
export function expectedArtifactNames(policy) {
  return policy.kernelIds.flatMap(kernel => policy.targets.map(t => `kernel-runtime-${kernel}-${targetKey(t)}`)).sort();
}
export function sourceEvidence(root, policy) {
  return Object.fromEntries(policy.kernelIds.map(id => {
    const bytes = readFileSync(join(root, 'kernels', id, 'source.json'));
    const source = JSON.parse(bytes);
    return [id, { sha256: sha256Bytes(bytes), artifactVersion: source.artifactVersion,
      upstreamCommit: source.git.commit, patchRevision: source.patchRevision }];
  }));
}

export function assertSourceDescriptors(descriptors, sources) {
  for (const d of descriptors) {
    const s = sources[d.kernelId];
    if (!s || d.supplyChain.sourceSha256 !== s.sha256 || d.artifactVersion !== s.artifactVersion
      || d.upstreamCommit !== s.upstreamCommit || d.patchRevision !== s.patchRevision) {
      throw new Error(`Descriptor does not match accepted source inputs: ${artifactIdentity(d)}`);
    }
  }
}

export function requiredSlots(policy) {
  return policy.kernelIds.flatMap(kernel => policy.targets.map(t => `${kernel}/${targetKey(t)}`)).sort();
}

export function assertCompleteSet(descriptors, policy) {
  const actual = descriptors.map(artifactSlot).sort();
  if (JSON.stringify(actual) !== JSON.stringify(requiredSlots(policy))) {
    throw new Error('Release must contain exactly one latest artifact for every enabled kernel/required target');
  }
  for (const kernelId of policy.kernelIds) {
    if (new Set(descriptors.filter(d => d.kernelId === kernelId).map(d => d.artifactVersion)).size !== 1) {
      throw new Error(`Release mixes versions across targets: ${kernelId}`);
    }
  }
}
