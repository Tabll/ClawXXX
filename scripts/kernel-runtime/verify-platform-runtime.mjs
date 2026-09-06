#!/usr/bin/env node
import { closeSync, existsSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { release as osRelease } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { listMachOFiles } from './sign-macos-runtime.mjs';
import { writeCanonicalJson } from './lib/canonical.mjs';

export function verifyPlatformRuntime(input) {
  const platform = input.platform ?? process.platform;
  const kernelRoot = resolve(input.kernelRoot);
  const nodeRoot = resolve(input.nodeRoot);
  if (platform === 'darwin') return verifyMac(kernelRoot, nodeRoot, input.assessNotarization !== false);
  if (platform === 'win32') return verifyWindows(kernelRoot, nodeRoot, input.platformSecurityReport);
  if (platform === 'linux') return verifyLinux(nodeRoot);
  throw new Error(`Unsupported runtime verification platform: ${platform}`);
}

function verifyMac(kernelRoot, nodeRoot, assessNotarization) {
  const files = [...listMachOFiles(kernelRoot), ...listMachOFiles(nodeRoot)];
  if (files.length === 0) throw new Error('No Mach-O files found during runtime verification');
  for (const file of files) run('codesign', ['--verify', '--strict', '--verbose=4', file]);
  const node = join(nodeRoot, 'bin', 'node');
  if (!existsSync(node)) throw new Error('Signed macOS Node executable is missing');
  if (assessNotarization) run('spctl', ['--assess', '--type', 'execute', '--verbose=4', node]);
  return { schemaVersion: 1, ok: true, platform: 'darwin', signedFiles: files.length, notarizationAssessed: assessNotarization };
}

function verifyWindows(kernelRoot, nodeRoot, report) {
  const files = [...peFiles(kernelRoot), ...peFiles(nodeRoot)];
  if (files.length === 0) throw new Error('No PE files found during runtime verification');
  if (!existsSync(join(nodeRoot, 'node.exe')) || !hasMagic(join(nodeRoot, 'node.exe'), new Set(['4d5a']))) {
    throw new Error('Windows Node runtime is missing or is not PE');
  }
  // Only the archive-hash-bound report may select the explicitly deferred mode.
  // A failed Authenticode check never falls back to artifact-signature-only.
  if (report?.codeSigning?.authenticode === false) {
    if (report.schemaVersion !== 1 || report.ok !== true || report.platform !== 'win32'
      || report.arch !== 'x64' || report.codeSigning.artifactSignatureOnly !== true
      || report.codeSigning.status !== 'deferred') {
      throw new Error('Invalid deferred Windows code-signing report');
    }
    return {
      schemaVersion: 1, ok: true, platform: 'win32', signedFiles: 0,
      executableFiles: files.length, authenticode: false, artifactSignatureOnly: true,
    };
  }
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$files = ConvertFrom-Json $env:CLAWX_RUNTIME_VERIFY_FILES',
    'foreach ($file in $files) {',
    '  $signature = Get-AuthenticodeSignature -LiteralPath $file',
    '  if ($signature.Status -ne "Valid") { throw "Invalid Authenticode signature: $file ($($signature.Status))" }',
    '}',
  ].join('; ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    env: { ...process.env, CLAWX_RUNTIME_VERIFY_FILES: JSON.stringify(files) },
  });
  if (result.status !== 0) throw new Error(`Windows runtime signature verification failed: ${(result.stderr || result.stdout).trim()}`);
  return { schemaVersion: 1, ok: true, platform: 'win32', signedFiles: files.length, authenticode: true };
}

function verifyLinux(nodeRoot) {
  const node = join(nodeRoot, 'bin', 'node');
  if (!existsSync(node) || !hasMagic(node, new Set(['7f454c46']))) throw new Error('Linux Node runtime is missing or is not ELF');
  const result = spawnSync(node, ['-p', 'JSON.stringify(process.report.getReport().header)'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Linux Node runtime probe failed: ${(result.stderr || result.stdout).trim()}`);
  const header = JSON.parse(result.stdout);
  const glibc = header.glibcVersionRuntime;
  if (typeof glibc !== 'string' || compareVersions(glibc, '2.39') < 0) {
    throw new Error(`Linux runtime requires glibc >= 2.39, found ${glibc ?? 'unknown'}`);
  }
  const kernel = osRelease().split('-')[0];
  if (compareVersions(kernel, '6.8') < 0) throw new Error(`Linux runtime requires kernel >= 6.8, found ${kernel}`);
  return { schemaVersion: 1, ok: true, platform: 'linux', glibc, kernel, libc: 'glibc', muslSupported: false };
}

function peFiles(root) {
  const output = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`Runtime verification refuses symbolic links: ${path}`);
      if (stat.isDirectory()) pending.push(path);
      else if (stat.isFile() && hasMagic(path, new Set(['4d5a']))) output.push(path);
    }
  }
  return output.sort();
}

function hasMagic(path, allowed) {
  const descriptor = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(4);
    const bytes = readSync(descriptor, buffer, 0, 4, 0);
    if (bytes < 2) return false;
    return [...allowed].some(magic => buffer.toString('hex', 0, magic.length / 2) === magic);
  } finally {
    closeSync(descriptor);
  }
}

function compareVersions(left, right) {
  const a = left.split('.').map(value => Number.parseInt(value, 10) || 0);
  const b = right.split('.').map(value => Number.parseInt(value, 10) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} verification failed: ${(result.stderr || result.stdout).trim()}`);
}

async function main() {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
  const report = verifyPlatformRuntime({
    kernelRoot: required(args, '--kernel'),
    nodeRoot: required(args, '--node'),
    platform: args.get('--platform') ?? process.platform,
    assessNotarization: args.get('--assess-notarization') !== 'false',
  });
  if (args.get('--report')) writeCanonicalJson(resolve(args.get('--report')), report);
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

function required(args, name) {
  const value = args.get(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
