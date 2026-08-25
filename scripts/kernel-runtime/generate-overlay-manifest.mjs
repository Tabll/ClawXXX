#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const argv = process.argv.slice(2);
const kernelId = argument('--kernel');
if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(kernelId)) throw new Error('A safe --kernel is required');
const repositoryRoot = resolve(argument('--repository', process.cwd()));
const manifestRoot = `kernels/${kernelId}/overlay`;
const overlayRoot = resolve(repositoryRoot, manifestRoot);
const output = resolve(repositoryRoot, argument('--output', `kernels/${kernelId}/overlay.manifest.json`));

const files = regularFiles(overlayRoot).map(path => ({
  path: relative(overlayRoot, path).split(sep).join('/'),
  sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
}));
const serialized = `${JSON.stringify({ schemaVersion: 1, root: manifestRoot, files }, null, 2)}\n`;
if (argv.includes('--check')) {
  if (readFileSync(output, 'utf8') !== serialized) throw new Error(`Overlay manifest is stale: ${output}`);
} else {
  writeFileSync(output, serialized, { encoding: 'utf8', mode: 0o600 });
}
process.stdout.write(`${JSON.stringify({ ok: true, kernelId, files: files.length, output })}\n`);

function regularFiles(root) {
  const result = [];
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => (
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    ))) {
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`Overlay contains a symbolic link: ${path}`);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) result.push(path);
      else throw new Error(`Overlay contains a non-regular entry: ${path}`);
    }
  };
  visit(root);
  return result;
}

function argument(name, fallback) {
  const index = argv.indexOf(name);
  if (index < 0) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing ${name}`);
  }
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
  return value;
}
