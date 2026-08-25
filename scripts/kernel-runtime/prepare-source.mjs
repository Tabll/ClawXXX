#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { applyStrictPatchSeries, materializeOverlay, verifyPreparedLockfile, verifySourceInputs } from './lib/source-manifest.mjs';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const kernelId = args.get('--kernel');
const checkoutRoot = args.get('--checkout');
if (!kernelId || !checkoutRoot) throw new Error('Usage: prepare-source --kernel KERNEL --checkout DIR');
const repositoryRoot = resolve(args.get('--repository') ?? process.cwd());
const checkout = resolve(checkoutRoot);
const { source } = verifySourceInputs({ repositoryRoot, kernelId, sourceCheckout: checkout });
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim();
if (source.patchBase === 'git-checkout' && commit !== source.git.commit) {
  throw new Error(`Source checkout mismatch: ${commit} != ${source.git.commit}`);
}
if (source.patchBase === 'npm-tarball') {
  const marker = JSON.parse(readFileSync(resolve(checkout, '.clawx-source.json'), 'utf8'));
  if (marker.kernelId !== kernelId || marker.version !== source.version || marker.integrity !== source.npm.integrity) {
    throw new Error('NPM patch-base marker does not match the frozen source manifest');
  }
}
const changed = applyStrictPatchSeries({ repositoryRoot, checkoutRoot: checkout, source });
if (source.overlay) materializeOverlay({ repositoryRoot, checkoutRoot: checkout, overlay: source.overlay });
verifyPreparedLockfile({ repositoryRoot, checkoutRoot: checkout, source });
process.stdout.write(`${JSON.stringify({
  ok: true,
  kernelId,
  commit,
  patchedFiles: changed,
  overlay: source.overlay?.manifest,
})}\n`);
