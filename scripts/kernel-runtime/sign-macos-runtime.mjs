#!/usr/bin/env node
import { closeSync, lstatSync, mkdirSync, openSync, readSync, readdirSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { sha256File, writeCanonicalJson } from './lib/canonical.mjs';

const MACH_O_MAGICS = new Set([
  'feedface', 'feedfacf', 'cefaedfe', 'cffaedfe',
  'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca',
]);

export function listMachOFiles(root) {
  const output = [];
  const pending = [resolve(root)];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`macOS runtime signing refuses symbolic links: ${path}`);
      if (stat.isDirectory()) pending.push(path);
      else if (stat.isFile() && hasMagic(path, MACH_O_MAGICS)) output.push(path);
    }
  }
  return output.sort((left, right) => depth(right) - depth(left) || left.localeCompare(right));
}

export function signMacRuntime(input) {
  if (!input.identity || /[\r\n]/.test(input.identity)) throw new Error('A valid macOS signing identity is required');
  const entitlements = resolve(input.entitlements);
  const roots = [
    { label: 'kernel', path: resolve(input.kernelRoot) },
    { label: 'node', path: resolve(input.nodeRoot) },
  ];
  const files = roots.flatMap(root => listMachOFiles(root.path).map(path => ({ ...root, file: path })));
  if (files.length === 0) throw new Error('No Mach-O files were found in the runtime payload');
  for (const item of files) {
    const args = ['--force', '--timestamp', '--options', 'runtime', '--sign', input.identity];
    if (item.label === 'node' && basename(item.file) === 'node') args.push('--entitlements', entitlements);
    args.push(item.file);
    run('codesign', args);
    run('codesign', ['--verify', '--strict', '--verbose=4', item.file]);
  }
  return {
    schemaVersion: 1,
    ok: true,
    platform: 'darwin',
    identity: input.identity,
    hardenedRuntime: true,
    nodeEntitlements: [
      'com.apple.security.cs.allow-jit',
      'com.apple.security.cs.allow-unsigned-executable-memory',
      'com.apple.security.cs.disable-library-validation',
    ],
    files: files.map(item => ({
      root: item.label,
      path: relative(item.path, item.file).replaceAll('\\', '/'),
      sha256: sha256File(item.file),
    })).sort((left, right) => `${left.root}/${left.path}`.localeCompare(`${right.root}/${right.path}`)),
  };
}

function hasMagic(path, allowed) {
  const descriptor = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(4);
    if (readSync(descriptor, buffer, 0, 4, 0) !== 4) return false;
    return allowed.has(buffer.toString('hex'));
  } finally {
    closeSync(descriptor);
  }
}

function depth(path) {
  return path.split(/[\\/]/).length;
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} failed for ${args.at(-1)}: ${(result.stderr || result.stdout).trim()}`);
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('macOS runtime signing must run on macOS');
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
  const report = signMacRuntime({
    kernelRoot: required(args, '--kernel'),
    nodeRoot: required(args, '--node'),
    identity: required(args, '--identity'),
    entitlements: args.get('--entitlements') ?? join(process.cwd(), 'resources', 'kernel-runtime-node.entitlements.plist'),
  });
  const output = resolve(required(args, '--report'));
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  writeCanonicalJson(output, report);
  process.stdout.write(`${JSON.stringify({ ok: true, files: report.files.length })}\n`);
}

function required(args, name) {
  const value = args.get(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
