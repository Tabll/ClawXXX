#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { readJson } from './lib/canonical.mjs';
import { parseSourceManifest } from './lib/source-manifest.mjs';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const kernelId = args.get('--kernel');
const destinationArgument = args.get('--destination');
if (!kernelId || !destinationArgument) throw new Error('Usage: checkout-git-source --kernel KERNEL --destination DIR');
const repositoryRoot = resolve(args.get('--repository') ?? process.cwd());
const source = parseSourceManifest(readJson(join(repositoryRoot, 'kernels', kernelId, 'source.json')));
if (source.patchBase !== 'git-checkout') throw new Error(`${kernelId} does not use a Git checkout patch base`);
const destination = resolve(destinationArgument);
if (existsSync(destination)) throw new Error(`Source destination already exists: ${destination}`);
mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
run(['init', '--quiet', destination]);
// Preserve upstream blob bytes even when the Windows runner enables autocrlf.
run(['-C', destination, 'config', 'core.autocrlf', 'false']);
run(['-C', destination, 'config', 'core.eol', 'lf']);
run(['-C', destination, 'remote', 'add', 'origin', `${source.upstream}.git`]);
run(['-C', destination, 'fetch', '--depth=1', '--no-tags', 'origin', source.git.commit]);
run(['-C', destination, 'checkout', '--quiet', '--detach', source.git.commit]);
const commit = execFileSync('git', ['-C', destination, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (commit !== source.git.commit) throw new Error(`Fetched source commit mismatch: ${commit}`);
process.stdout.write(`${JSON.stringify({ ok: true, kernelId, commit })}\n`);

function run(arguments_) {
  execFileSync('git', arguments_, { stdio: 'inherit' });
}
