#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const checkout = resolve(required('--clean-checkout'));
const patchedTree = resolve(required('--patched-tree'));
const referencePatch = resolve(required('--reference-patch'));
const output = resolve(required('--output'));
if (git(['status', '--porcelain=v1', '--untracked-files=all']) !== '') throw new Error('Clean checkout contains changes');
const targets = patchTargets(referencePatch);
for (const target of targets) {
  const source = inside(patchedTree, target);
  const destination = inside(checkout, target);
  if (!existsSync(source) || !lstatSync(source).isFile()) throw new Error(`Patched result is missing ${target}`);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  copyFileSync(source, destination);
}
const changed = git(['diff', '--name-only']).split(/\r?\n/).filter(Boolean);
if (changed.length !== targets.length || changed.some((path) => !targets.includes(path))) {
  throw new Error(`Golden patched tree changed unrecorded paths: ${changed.join(', ')}`);
}
execFileSync('git', ['diff', '--binary', '--full-index', '--no-ext-diff', `--output=${output}`, '--', ...targets], {
  cwd: checkout,
  stdio: 'inherit',
});
if (!existsSync(output) || lstatSync(output).size === 0) throw new Error('Exact patch generation produced no output');
process.stdout.write(`${JSON.stringify({ ok: true, files: targets.length, output })}\n`);

function patchTargets(path) {
  const targets = [];
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (!match) continue;
    if (match[1] !== match[2] || !safe(match[2])) throw new Error(`Reference patch contains unsafe target: ${line}`);
    if (!targets.includes(match[2])) targets.push(match[2]);
  }
  if (targets.length === 0) throw new Error('Reference patch contains no targets');
  return targets;
}

function inside(root, path) {
  if (!safe(path)) throw new Error(`Unsafe path: ${path}`);
  const target = resolve(root, path);
  if (!target.startsWith(`${root}${sep}`)) throw new Error(`Path escapes root: ${path}`);
  return target;
}

function safe(path) {
  return path !== '' && !path.includes('\\') && !path.startsWith('/')
    && path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function git(arguments_) {
  return execFileSync('git', arguments_, { cwd: checkout, encoding: 'utf8' }).trim();
}

function required(key) {
  const value = args.get(key);
  if (!value) throw new Error(`Missing ${key}`);
  return value;
}
