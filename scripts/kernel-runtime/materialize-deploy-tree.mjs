#!/usr/bin/env node
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const EXCLUDED_EXTERNAL_DIRECTORIES = new Set(['.git', '.turbo', 'node_modules']);

/**
 * Turn pnpm's hoisted deploy output into a portable tree. Workspace package
 * links are copied from the reviewed source checkout without their development
 * node_modules, and POSIX .bin links become regular shims. Runtime archives and
 * the safe extractor intentionally keep a zero-symlink contract.
 */
export function materializeDeployTree(input) {
  const payloadRoot = realDirectory(input.payloadRoot, 'payload');
  const workspaceRoot = realDirectory(input.workspaceRoot, 'workspace');
  const platform = input.platform;
  const result = { directories: 0, binShims: 0, files: 0 };

  // Re-scan because copying an external workspace directory may add paths that
  // must themselves be checked, even though node_modules is excluded.
  while (true) {
    const links = symbolicLinks(payloadRoot);
    if (links.length === 0) break;
    for (const path of links) materializeLink({ path, payloadRoot, workspaceRoot, platform, result });
  }
  if (input.rootPackage) {
    const packageRoot = realDirectory(resolve(workspaceRoot, input.rootPackage), 'root workspace package');
    if (!isInside(workspaceRoot, packageRoot)) throw new Error('Root package escapes reviewed workspace');
    const manifest = readFileSync(resolve(packageRoot, 'package.json'));
    const deployedManifest = JSON.parse(readFileSync(resolve(payloadRoot, 'package.json'), 'utf8'));
    if (JSON.parse(manifest.toString()).name !== deployedManifest.name) throw new Error('Root package identity mismatch');
    // The generated deploy manifest/lockfiles contain absolute builder paths.
    // Runtime packages use the reviewed manifest; install metadata is build-only.
    writeFileSync(resolve(payloadRoot, 'package.json'), manifest);
    for (const relativePath of [
      'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'node_modules/.modules.yaml',
      'node_modules/.pnpm/lock.yaml', 'node_modules/.pnpm-workspace-state-v1.json',
    ]) {
      const path = resolve(payloadRoot, relativePath);
      if (existsSync(path)) {
        if (!lstatSync(path).isFile()) throw new Error(`Install metadata must be a regular file: ${path}`);
        rmSync(path);
      }
    }
  }
  return { ok: true, ...result };
}

function materializeLink({ path, payloadRoot, workspaceRoot, platform, result }) {
  const target = realpathSync(path);
  if (!isInside(payloadRoot, target) && !isInside(workspaceRoot, target)) {
    throw new Error(`Deploy link escapes payload and reviewed workspace: ${path} -> ${readlinkSync(path)}`);
  }
  const targetStat = lstatSync(target);
  if (targetStat.isDirectory()) {
    if (!isInside(workspaceRoot, target)) {
      throw new Error(`Only reviewed workspace directory links may be materialized: ${path}`);
    }
    rmSync(path);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    copyReviewedDirectory(target, path);
    result.directories += 1;
    return;
  }
  if (!targetStat.isFile()) throw new Error(`Deploy link target is not a regular file: ${path}`);
  if (path.split(sep).includes('.bin')) {
    if (platform === 'win32') throw new Error(`Windows deploy unexpectedly contains a .bin symbolic link: ${path}`);
    if (!isInside(payloadRoot, target)) throw new Error(`Executable shim target is outside payload: ${path}`);
    const targetFromShim = relative(dirname(path), target).replaceAll('\\', '/');
    rmSync(path);
    writeFileSync(path, [
      '#!/bin/sh',
      'script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
      `exec node "$script_dir/${targetFromShim}" "$@"`,
      '',
    ].join('\n'), { mode: 0o755 });
    result.binShims += 1;
    return;
  }
  rmSync(path);
  copyFileSync(target, path);
  chmodSync(path, targetStat.mode & 0o777);
  result.files += 1;
}

function copyReviewedDirectory(source, destination) {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.isDirectory() && EXCLUDED_EXTERNAL_DIRECTORIES.has(entry.name)) continue;
    const sourcePath = resolve(source, entry.name);
    const destinationPath = resolve(destination, entry.name);
    const stat = lstatSync(sourcePath);
    if (stat.isSymbolicLink()) throw new Error(`Reviewed workspace package contains a symbolic link: ${sourcePath}`);
    if (stat.isDirectory()) {
      mkdirSync(destinationPath, { recursive: true, mode: stat.mode & 0o777 });
      copyReviewedDirectory(sourcePath, destinationPath);
    } else if (stat.isFile()) {
      copyFileSync(sourcePath, destinationPath);
      chmodSync(destinationPath, stat.mode & 0o777);
    } else {
      throw new Error(`Reviewed workspace package contains a non-regular entry: ${sourcePath}`);
    }
  }
}

function symbolicLinks(root) {
  const links = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) links.push(path);
      else if (stat.isDirectory()) pending.push(path);
    }
  }
  return links.sort();
}

function realDirectory(path, label) {
  const absolute = resolve(path);
  if (!existsSync(absolute) || !lstatSync(absolute).isDirectory()) throw new Error(`Missing ${label} directory: ${absolute}`);
  return realpathSync(absolute);
}

function isInside(root, path) {
  return path === root || path.startsWith(`${root}${sep}`);
}

async function main() {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
  for (const name of ['--payload', '--workspace', '--platform']) {
    if (!args.get(name)) throw new Error(`Missing ${name}`);
  }
  const result = materializeDeployTree({
    payloadRoot: args.get('--payload'),
    workspaceRoot: args.get('--workspace'),
    platform: args.get('--platform'),
    rootPackage: args.get('--root-package'),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
