import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expectedArtifactNames, loadReleasePolicy, sourceEvidence } from './release-policy.mjs';
import { canonicalJson, sha256Bytes } from './canonical.mjs';
import { fetchBoundedJson } from './release-http.mjs';
import { maintenanceHint } from './release-maintenance.mjs';

export function assertTrustedRun(run, policy, workflow, events) {
  if (!run || run.repository?.full_name !== policy.repository || run.head_repository?.full_name !== policy.repository
    || run.head_branch !== policy.branch || run.path !== workflow || !events.includes(run.event)
    || !/^[a-f0-9]{40}$/.test(run.head_sha) || !Number.isSafeInteger(run.id) || run.id < 1
    || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) {
    throw new Error('Untrusted release workflow, repository, branch or source identity');
  }
  if (run.status !== 'completed' || run.conclusion !== 'success') throw new Error('Required workflow is not completely successful');
}

export function assertAcceptanceJobs(buildJobs, e2eJobs, policy) {
  const expected = new Set();
  for (const { platform, arch } of policy.targets) {
    for (const kernel of policy.kernelIds) {
      expected.add(`build/${kernel}/${platform}/${arch}`);
      expected.add(`clean-machine-smoke/${kernel}/${platform}/${arch}`);
    }
    expected.add(`clean-machine-dual-runtime/${platform}/${arch}`);
  }
  const actual = new Set();
  for (const job of buildJobs) {
    if (job.status !== 'completed' || job.conclusion !== 'success') throw new Error('Build acceptance contains a failed, skipped or incomplete job');
    const single = /^(build|clean-machine-smoke) \(([a-z0-9-]+), [a-z0-9.-]+, (darwin|linux|win32), (x64|arm64)\)$/.exec(job.name);
    const dual = /^clean-machine-dual-runtime \([a-z0-9.-]+, (darwin|linux|win32), (x64|arm64)\)$/.exec(job.name);
    const key = single ? single.slice(1).join('/') : dual ? `clean-machine-dual-runtime/${dual[1]}/${dual[2]}` : undefined;
    if (!key || !expected.has(key) || actual.has(key)) throw new Error('Unexpected or duplicate runtime acceptance job');
    actual.add(key);
  }
  if (actual.size !== expected.size) throw new Error('Incomplete build/single/dual runtime acceptance matrix');
  if (e2eJobs.length !== policy.e2eJobs.length || new Set(e2eJobs.map(j => j.name)).size !== e2eJobs.length
    || e2eJobs.some(j => !policy.e2eJobs.includes(j.name) || j.status !== 'completed' || j.conclusion !== 'success')) {
    throw new Error('Incomplete same-source three-platform Electron E2E');
  }
}

export function createGitHubReader(policy, { token = process.env.GH_TOKEN, fetcher = fetch } = {}) {
  const root = `/repos/${policy.repository}`;
  return async (suffix, { allowMissing = false } = {}) => {
    const pinnedCompare = /^\/compare\/[a-f0-9]{40}\.\.\.[a-f0-9]{40}$/.test(suffix);
    if (!suffix.startsWith('/') || (suffix.includes('..') && !pinnedCompare) || suffix.includes('\\')
      || /%2e|%2f|%5c/i.test(suffix)) throw new Error('Unsafe GitHub metadata path');
    return fetchBoundedJson(`https://api.github.com${root}${suffix}`, {
      fetcher, allowMissing, maxBytes: 8 * 1024 * 1024,
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
        ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
  };
}

export async function githubPages(api, suffix, field) {
  const result = [];
  for (let page = 1; page <= 20; page += 1) {
    const data = await api(`${suffix}${suffix.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    const items = field ? data[field] : data;
    if (!Array.isArray(items)) throw new Error('Invalid GitHub paginated metadata');
    result.push(...items);
    if (items.length < 100) return result;
  }
  throw new Error('GitHub metadata exceeds the bounded pagination budget');
}

export async function verifyReleaseCandidate({ api, policy, runId, currentSources }) {
  const build = await api(`/actions/runs/${positiveId(runId)}`);
  assertTrustedRun(build, policy, policy.buildWorkflow, ['workflow_dispatch']);
  const main = await api(`/commits/${encodeURIComponent(policy.branch)}`);
  if (!/^[a-f0-9]{40}$/.test(main?.sha)) throw new Error('Cannot resolve trusted main source');
  const ancestry = await api(`/compare/${build.head_sha}...${main.sha}`);
  if (!['ahead', 'identical'].includes(ancestry.status)) throw new Error('Build commit is not an ancestor of trusted main');
  const sources = {};
  for (const kernelId of policy.kernelIds) {
    const content = await api(`/contents/kernels/${kernelId}/source.json?ref=${build.head_sha}`);
    if (content.encoding !== 'base64' || typeof content.content !== 'string' || content.content.length > 512_000) {
      throw new Error('Missing bounded build source manifest');
    }
    const bytes = Buffer.from(content.content, 'base64');
    const source = JSON.parse(bytes);
    const sha256 = sha256Bytes(bytes);
    const mainContent = main.sha === build.head_sha ? content
      : await api(`/contents/kernels/${kernelId}/source.json?ref=${main.sha}`);
    if (mainContent?.encoding !== 'base64' || typeof mainContent.content !== 'string' || mainContent.content.length > 512_000
      || source.kernelId !== kernelId || currentSources[kernelId]?.sha256 !== sha256
      || sha256Bytes(Buffer.from(mainContent.content, 'base64')) !== sha256) {
      throw new Error('Stale candidate: frozen kernel inputs differ from reviewed publisher checkout or current main');
    }
    sources[kernelId] = { sha256, artifactVersion: source.artifactVersion, upstreamCommit: source.git.commit,
      patchRevision: source.patchRevision };
  }
  const runs = await githubPages(api, `/actions/runs?head_sha=${build.head_sha}`, 'workflow_runs');
  const e2e = runs.filter(r => r.path === policy.e2eWorkflow && ['push', 'workflow_dispatch'].includes(r.event))
    .sort((a, b) => b.id - a.id)[0];
  assertTrustedRun(e2e, policy, policy.e2eWorkflow, ['push', 'workflow_dispatch']);
  if (e2e.head_sha !== build.head_sha) throw new Error('E2E did not validate the artifact source commit');
  const [buildJobs, e2eJobs, artifacts] = await Promise.all([
    githubPages(api, `/actions/runs/${build.id}/attempts/${build.run_attempt}/jobs`, 'jobs'),
    githubPages(api, `/actions/runs/${e2e.id}/attempts/${e2e.run_attempt}/jobs`, 'jobs'),
    githubPages(api, `/actions/runs/${build.id}/artifacts`, 'artifacts'),
  ]);
  assertAcceptanceJobs(buildJobs, e2eJobs, policy);
  const runtimes = artifacts.filter(a => a.name.startsWith('kernel-runtime-'));
  if (JSON.stringify(runtimes.map(a => a.name).sort()) !== JSON.stringify(expectedArtifactNames(policy))
    || runtimes.some(a => a.expired !== false || !/^sha256:[a-f0-9]{64}$/.test(a.digest)
      || a.workflow_run?.head_sha !== build.head_sha || !Number.isSafeInteger(a.id) || a.id < 1)) {
    throw new Error('Incomplete, expired or unbound immutable runtime artifacts');
  }
  return { schemaVersion: 1, repository: policy.repository, sourceSha: build.head_sha,
    stagingRunId: build.id, stagingAttempt: build.run_attempt, e2eRunId: e2e.id, e2eAttempt: e2e.run_attempt,
    sources, artifacts: runtimes.map(({ id, name, digest }) => ({ id, name, digest })).sort((a, b) => a.name.localeCompare(b.name)) };
}

export const candidateDigest = candidate => sha256Bytes(canonicalJson(candidate));

export async function selectReleaseCandidate({ api, policy, event, eventName, requestedRunId, currentSources }) {
  if (requestedRunId) return verifyReleaseCandidate({ api, policy, runId: requestedRunId, currentSources });
  const webhookRun = event?.workflow_run;
  if (eventName !== 'workflow_run' || !webhookRun || webhookRun.conclusion !== 'success'
    || event.repository?.full_name !== policy.repository) return undefined;
  const trigger = await api(`/actions/runs/${positiveId(webhookRun.id)}`);
  if (![policy.buildWorkflow, policy.e2eWorkflow].includes(trigger.path)) return undefined;
  assertTrustedRun(trigger, policy, trigger.path, trigger.path === policy.buildWorkflow ? ['workflow_dispatch'] : ['push', 'workflow_dispatch']);
  // GitHub's workflow_run list is OR, not AND. Explicitly join the exact SHA.
  const runs = await githubPages(api, `/actions/runs?head_sha=${trigger.head_sha}`, 'workflow_runs');
  const build = runs.filter(r => r.path === policy.buildWorkflow && r.status === 'completed' && r.conclusion === 'success')
    .sort((a, b) => b.id - a.id)[0];
  if (!build) return undefined;
  const e2e = runs.filter(r => r.path === policy.e2eWorkflow && ['push', 'workflow_dispatch'].includes(r.event))
    .sort((a, b) => b.id - a.id)[0];
  if (!e2e || e2e.status !== 'completed' || e2e.conclusion !== 'success') return undefined;
  return verifyReleaseCandidate({ api, policy, runId: build.id, currentSources });
}

function positiveId(value) {
  if (!/^[1-9][0-9]{0,15}$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new Error('Invalid workflow run ID');
  return String(value);
}

async function main() {
  const policy = loadReleasePolicy();
  if (process.env.GITHUB_REPOSITORY !== policy.repository || process.env.GITHUB_REF !== `refs/heads/${policy.branch}`) {
    throw new Error('Publishing is restricted to the reviewed repository and main branch');
  }
  const api = createGitHubReader(policy);
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  if (process.env.GITHUB_EVENT_NAME === 'schedule' || process.env.RELEASE_MODE === 'maintain') {
    const hint = await maintenanceHint({ policy });
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `eligible=${hint.eligible}\nmode=maintain\n`);
    process.stdout.write(`${JSON.stringify(hint)}\n`);
    return;
  }
  if (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' && !process.env.STAGING_RUN_ID) {
    throw new Error('Manual publication requires an explicit accepted runtime run ID');
  }
  const candidate = await selectReleaseCandidate({ api, policy, event, eventName: process.env.GITHUB_EVENT_NAME,
    requestedRunId: process.env.STAGING_RUN_ID, currentSources: sourceEvidence(process.cwd(), policy) });
  const expectedSha = process.env.EXPECTED_SOURCE_SHA;
  if (expectedSha && candidate?.sourceSha !== expectedSha) throw new Error('Requested source SHA does not match the accepted build');
  if (candidate && process.env.CANDIDATE_OUTPUT) writeFileSync(process.env.CANDIDATE_OUTPUT, `${canonicalJson(candidate)}\n`, { mode: 0o600 });
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
    `eligible=${Boolean(candidate)}\nmode=publish\nrun-id=${candidate?.stagingRunId ?? ''}\nsource-sha=${candidate?.sourceSha ?? ''}\n`
    + `candidate-digest=${candidate ? candidateDigest(candidate) : ''}\nartifact-ids=${candidate?.artifacts.map(a => a.id).join(',') ?? ''}\n`);
  process.stdout.write(`${JSON.stringify({ eligible: Boolean(candidate), candidate: candidate ?? null })}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
