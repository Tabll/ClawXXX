#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { readJson, sha256File } from './lib/canonical.mjs';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const kernelId = args.get('--kernel');
const payloadArgument = args.get('--payload');
if (!kernelId || !payloadArgument) throw new Error('Usage: materialize-overlay --kernel KERNEL --payload DIR');
const repositoryRoot = resolve(args.get('--repository') ?? process.cwd());
const payload = resolve(payloadArgument);
const source = readJson(join(repositoryRoot, 'kernels', kernelId, 'source.json'));
if (!source.overlay) throw new Error(`${kernelId} has no recorded overlay`);
const manifestPath = inside(repositoryRoot, source.overlay.manifest);
if (sha256File(manifestPath) !== source.overlay.manifestSha256) throw new Error('Overlay manifest hash mismatch');
const manifest = readJson(manifestPath);
for (const file of manifest.files) {
  const sourcePath = inside(repositoryRoot, join(source.overlay.root, file.path));
  if (sha256File(sourcePath) !== file.sha256) throw new Error(`Overlay file hash mismatch: ${file.path}`);
  const destination = inside(payload, file.path);
  if (existsSync(destination)) throw new Error(`Overlay refuses to overwrite payload path: ${file.path}`);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  copyFileSync(sourcePath, destination);
}
process.stdout.write(`${JSON.stringify({ ok: true, kernelId, files: manifest.files.length })}\n`);

function inside(root, path) {
  const base = resolve(root);
  const target = resolve(base, path);
  if (target !== base && !target.startsWith(`${base}${sep}`)) throw new Error(`Path escapes root: ${path}`);
  return target;
}
