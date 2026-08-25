#!/usr/bin/env node
import { resolve } from 'node:path';
import { verifySourceInputs } from './lib/source-manifest.mjs';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const repositoryRoot = resolve(args.get('--repository') ?? process.cwd());
const kernelIds = args.has('--kernel') ? [args.get('--kernel')] : ['openclaw', 'deepseek-harness'];
for (const kernelId of kernelIds) {
  const sourceCheckout = args.get('--source-checkout');
  const { source, series } = verifySourceInputs({ repositoryRoot, kernelId, sourceCheckout });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    kernelId,
    artifactVersion: source.artifactVersion,
    upstreamCommit: source.git.commit,
    patchCount: series.length,
  })}\n`);
}
