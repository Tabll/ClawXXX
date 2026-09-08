// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { sha256Bytes } from '../../scripts/kernel-runtime/lib/canonical.mjs';
import { loadReleasePolicy, expectedArtifactNames } from '../../scripts/kernel-runtime/lib/release-policy.mjs';
import { verifyReleaseCandidate, selectReleaseCandidate, candidateDigest, githubPages, createGitHubReader } from '../../scripts/kernel-runtime/lib/release-gate.mjs';
import { assertPublisherEnvironment } from '../../scripts/kernel-runtime/publish-runtimes.mjs';

function gateFixture() {
  const policy = loadReleasePolicy();
  const buildSha = 'a'.repeat(40);
  const mainSha = 'b'.repeat(40);
  const run = (id: number, path: string, event: string) => ({ id, path, event, repository: { full_name: policy.repository },
    head_repository: { full_name: policy.repository }, head_branch: 'main', head_sha: buildSha,
    run_attempt: 1, status: 'completed', conclusion: 'success' });
  const build = run(101, policy.buildWorkflow, 'workflow_dispatch');
  const e2e = run(201, policy.e2eWorkflow, 'push');
  const job = (name: string) => ({ name, status: 'completed', conclusion: 'success' });
  const buildJobs = policy.targets.flatMap(({ platform, arch }) => {
    const runner = platform === 'linux' ? `ubuntu-24.04${arch === 'arm64' ? '-arm' : ''}`
      : platform === 'win32' ? 'windows-2025' : arch === 'arm64' ? 'macos-14' : 'macos-15-intel';
    return [...policy.kernelIds.flatMap(kernel => [job(`build (${kernel}, ${runner}, ${platform}, ${arch})`),
      job(`clean-machine-smoke (${kernel}, ${runner}, ${platform}, ${arch})`)]),
    job(`clean-machine-dual-runtime (${runner}, ${platform}, ${arch})`)];
  });
  const e2eJobs = policy.e2eJobs.map(job);
  const artifacts = expectedArtifactNames(policy).map((name, i) => ({ name, id: 300 + i, expired: false,
    digest: `sha256:${'c'.repeat(64)}`, workflow_run: { head_sha: buildSha } }));
  const sources = Object.fromEntries(policy.kernelIds.map(id => {
    const content = JSON.stringify({ kernelId: id, artifactVersion: '1.0.0+clawx.1', patchRevision: 1, git: { commit: 'c'.repeat(40) } });
    return [id, { raw: content, sha256: sha256Bytes(content) }];
  }));
  const runs = [build, e2e];
  let mainChanged = false;
  const api = vi.fn(async (suffix: string) => {
    if (suffix === '/commits/main') return { sha: mainSha };
    if (suffix.startsWith('/compare/')) return { status: 'ahead' };
    if (suffix === '/actions/runs/101') return build;
    if (suffix === '/actions/runs/201') return e2e;
    if (suffix.startsWith('/actions/runs?')) return { workflow_runs: runs };
    if (suffix.includes('/runs/101/attempts/1/jobs')) return { jobs: buildJobs };
    if (suffix.includes('/runs/201/attempts/1/jobs')) return { jobs: e2eJobs };
    if (suffix.includes('/runs/101/artifacts')) return { artifacts };
    const match = /^\/contents\/kernels\/([a-z-]+)\/source.json\?ref=/.exec(suffix);
    if (match) return { encoding: 'base64', content: Buffer.from(mainChanged && suffix.endsWith(mainSha) ? '{}' : sources[match[1]].raw).toString('base64') };
    throw new Error(`Unexpected fixture API route: ${suffix}`);
  });
  const input = () => ({ api, policy, runId: build.id, currentSources: sources });
  const select = (trigger = build) => selectReleaseCandidate({ ...input(), eventName: 'workflow_run',
    event: { workflow_run: trigger, repository: { full_name: policy.repository } } });
  return { policy, build, e2e, buildJobs, e2eJobs, artifacts, sources, runs, api, input, select,
    changeMain: () => { mainChanged = true; } };
}

describe('same-source production release acceptance', () => {
  it('joins either successful completion event and binds complete jobs, artifact IDs and frozen sources', async () => {
    const f = gateFixture();
    const expected = await verifyReleaseCandidate(f.input());
    expect(expected).toMatchObject({ sourceSha: 'a'.repeat(40), stagingRunId: 101, e2eRunId: 201 });
    expect(expected.artifacts).toHaveLength(10);
    expect(f.buildJobs).toHaveLength(25);
    expect(await f.select()).toEqual(expected);
    expect(await f.select(f.e2e)).toEqual(expected);
    expect(candidateDigest(expected)).toMatch(/^[a-f0-9]{64}$/);
    expect(candidateDigest({ ...expected, stagingAttempt: 2 })).not.toBe(candidateDigest(expected));
  });

  it.each(['missing', 'unfinished', 'failed'])('does not queue production when the E2E counterpart is %s', async state => {
    const f = gateFixture();
    if (state === 'missing') f.runs.pop();
    if (state === 'unfinished') f.e2e.status = 'in_progress';
    if (state === 'failed') f.e2e.conclusion = 'failure';
    expect(await f.select()).toBeUndefined();
  });

  it('does not promote an unrelated UI-only E2E commit without runtime acceptance', async () => {
    const f = gateFixture();
    f.runs.shift();
    expect(await f.select(f.e2e)).toBeUndefined();
  });

  it.each(['fork', 'branch', 'workflow', 'pull-request', 'failed build', 'skipped job', 'missing dual', 'duplicate job', 'missing E2E job',
    'expired artifact', 'foreign artifact', 'extra artifact', 'missing digest', 'publisher source changed', 'main source changed'])('rejects %s', async failure => {
    const f = gateFixture();
    if (failure === 'fork') f.build.head_repository.full_name = 'attacker/ClawXXX';
    if (failure === 'branch') f.build.head_branch = 'untrusted';
    if (failure === 'workflow') f.build.path = '.github/workflows/release.yml';
    if (failure === 'pull-request') f.build.event = 'pull_request';
    if (failure === 'failed build') f.build.conclusion = 'failure';
    if (failure === 'skipped job') f.buildJobs[0].conclusion = 'skipped';
    if (failure === 'missing dual') f.buildJobs.pop();
    if (failure === 'duplicate job') f.buildJobs[1] = f.buildJobs[0];
    if (failure === 'missing E2E job') f.e2eJobs.pop();
    if (failure === 'expired artifact') f.artifacts[0].expired = true;
    if (failure === 'foreign artifact') f.artifacts[0].workflow_run.head_sha = 'e'.repeat(40);
    if (failure === 'extra artifact') f.artifacts.push({ ...f.artifacts[0], name: 'kernel-runtime-unknown-linux-x64' });
    if (failure === 'missing digest') f.artifacts[0].digest = '';
    if (failure === 'publisher source changed') f.sources.openclaw.sha256 = 'f'.repeat(64);
    if (failure === 'main source changed') f.changeMain();
    await expect(verifyReleaseCandidate(f.input())).rejects.toThrow();
  });

  it('fails closed at the bounded GitHub pagination limit', async () => {
    await expect(githubPages(async () => ({ jobs: Array(100).fill({}) }), '/jobs', 'jobs')).rejects.toThrow(/pagination budget/);
  });

  it('allows GitHub three-dot SHA comparisons without allowing traversal metadata paths', async () => {
    const fetcher = vi.fn(async () => Response.json({ status: 'ahead' }));
    const api = createGitHubReader(loadReleasePolicy(), { token: 'test-token', fetcher });
    await expect(api(`/compare/${'a'.repeat(40)}...${'b'.repeat(40)}`)).resolves.toEqual({ status: 'ahead' });
    for (const path of ['/../secrets', '/compare/../../evil', '/contents/%2e%2e/secrets', '/contents/foo%2fbar']) {
      await expect(api(path)).rejects.toThrow(/Unsafe/);
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('production workflow trust boundaries', () => {
  it('allows only protected main workflow contexts and explicit manual bootstrap', () => {
    const policy = loadReleasePolicy();
    const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: policy.repository, GITHUB_REF: 'refs/heads/main',
      GITHUB_WORKFLOW_REF: `${policy.repository}/.github/workflows/kernel-runtime-promote.yml@refs/heads/main`,
      GITHUB_EVENT_NAME: 'workflow_run', RELEASE_MODE: 'publish', BOOTSTRAP: 'false' };
    expect(() => assertPublisherEnvironment(env, policy)).not.toThrow();
    expect(() => assertPublisherEnvironment({ ...env, BOOTSTRAP: 'true' }, policy)).toThrow(/only through explicit/);
    expect(() => assertPublisherEnvironment({ ...env, BOOTSTRAP: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch' }, policy)).not.toThrow();
    expect(() => assertPublisherEnvironment({ ...env, GITHUB_REF: 'refs/heads/untrusted' }, policy)).toThrow(/Untrusted/);
    expect(() => assertPublisherEnvironment({ ...env, GITHUB_REPOSITORY: 'fork/ClawXXX' }, policy)).toThrow(/Untrusted/);
  });

  it.each(['LF', 'CRLF'])('keeps %s workflow code separate from artifact source and never exposes production secrets to the gate', newline => {
    const raw = readFileSync('.github/workflows/kernel-runtime-promote.yml', 'utf8').replace(/\r\n/g, '\n');
    const workflow = (newline === 'CRLF' ? raw.replace(/\n/g, '\r\n') : raw).replace(/\r\n/g, '\n');
    expect(workflow).toMatch(/workflow_run:\n\s+workflows: \[Build signed kernel runtimes, Electron E2E\]/);
    expect(workflow).toMatch(/schedule:\n\s+- cron:/);
    expect(workflow).toContain('group: kernel-runtime-production-catalog');
    expect(workflow).toContain('cancel-in-progress: false');
    const gate = workflow.split('  acceptance:')[1].split('  promote:')[0];
    expect(gate).not.toMatch(/secrets\.|environment:|contents: write/);
    const promote = workflow.split('  promote:')[1];
    expect(promote).toMatch(/needs: acceptance\n\s+if: needs.acceptance.outputs.eligible == 'true'\n\s+environment: kernel-production/);
    expect(promote).toContain('artifact-ids: ${{ needs.acceptance.outputs.artifact-ids }}');
    expect(promote).toContain('EXPECTED_CANDIDATE_DIGEST: ${{ needs.acceptance.outputs.candidate-digest }}');
    expect(workflow.match(/ref: \$\{\{ github.sha \}\}/g)).toHaveLength(2);
    expect(workflow).not.toMatch(/ref:.*(?:head_sha|source-sha)|--clobber|id-token: write/);
    expect(promote).toContain('--frozen-lockfile --ignore-scripts');
  });
});
