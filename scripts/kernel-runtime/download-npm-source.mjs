#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import tar from 'tar';
import { readJson } from './lib/canonical.mjs';
import { parseSourceManifest } from './lib/source-manifest.mjs';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const kernelId = args.get('--kernel');
const destinationArgument = args.get('--destination');
if (!kernelId || !destinationArgument) throw new Error('Usage: download-npm-source --kernel KERNEL --destination DIR');
const repositoryRoot = resolve(args.get('--repository') ?? process.cwd());
const source = parseSourceManifest(readJson(join(repositoryRoot, 'kernels', kernelId, 'source.json')));
if (source.patchBase !== 'npm-tarball') throw new Error(`${kernelId} does not use an npm tarball patch base`);
const destination = resolve(destinationArgument);
if (existsSync(destination)) throw new Error(`Source destination already exists: ${destination}`);
mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
const temporaryRoot = mkdtempSync(join(tmpdir(), 'clawx-npm-source-'));
try {
  const separator = source.npm.package.lastIndexOf('@');
  const packageName = source.npm.package.slice(0, separator);
  const metadataUrl = `https://registry.npmjs.org/${encodeURIComponent(packageName)}/${encodeURIComponent(source.version)}`;
  const metadataResponse = await fetch(metadataUrl, { signal: AbortSignal.timeout(120_000) });
  if (!metadataResponse.ok) throw new Error(`NPM metadata download failed: ${metadataResponse.status}`);
  const metadata = await metadataResponse.json();
  if (metadata.version !== source.version || metadata.dist?.integrity !== source.npm.integrity
    || typeof metadata.dist?.tarball !== 'string' || !metadata.dist.tarball.startsWith('https://')) {
    throw new Error('NPM registry metadata disagrees with the frozen source manifest');
  }
  const archivePath = join(temporaryRoot, 'package.tgz');
  const archiveResponse = await fetch(metadata.dist.tarball, { signal: AbortSignal.timeout(10 * 60_000) });
  if (!archiveResponse.ok || !archiveResponse.body) throw new Error(`NPM tarball download failed: ${archiveResponse.status}`);
  await pipeline(Readable.fromWeb(archiveResponse.body), createWriteStream(archivePath, { flags: 'wx', mode: 0o600 }));
  verifySri(archivePath, source.npm.integrity);
  await validateTarEntries(archivePath);
  const staging = join(temporaryRoot, 'source');
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  await tar.x({ file: archivePath, cwd: staging, strip: 1, strict: true, preservePaths: false });
  const packageJson = readJson(join(staging, 'package.json'));
  if (packageJson.name !== packageName || packageJson.version !== source.version) throw new Error('Extracted package identity mismatch');
  writeFileSync(join(staging, '.clawx-source.json'), `${JSON.stringify({
    schemaVersion: 1,
    kernelId,
    packageName,
    version: source.version,
    integrity: source.npm.integrity,
    upstreamCommit: source.git.commit,
  })}\n`, { mode: 0o600 });
  initializeGit(staging, source.sourceDateEpoch);
  renameSync(staging, destination);
  process.stdout.write(`${JSON.stringify({ ok: true, kernelId, version: source.version, integrity: source.npm.integrity })}\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 3 });
}

function verifySri(path, integrity) {
  const match = /^sha512-([A-Za-z0-9+/=]+)$/.exec(integrity);
  if (!match) throw new Error('Only pinned SHA-512 NPM integrity is accepted');
  const actual = createHash('sha512').update(readFileSync(path)).digest('base64');
  if (actual !== match[1]) throw new Error('NPM tarball integrity mismatch');
}

async function validateTarEntries(path) {
  const violations = [];
  await tar.t({
    file: path,
    strict: true,
    onentry(entry) {
      const name = entry.path;
      if (!name.startsWith('package/') || name.includes('\\') || name.split('/').some((segment) => segment === '..')
        || !['File', 'Directory'].includes(entry.type)) violations.push(`${entry.type}:${name}`);
    },
  });
  if (violations.length > 0) throw new Error(`Unsafe NPM archive entries:\n${violations.join('\n')}`);
}

function initializeGit(root, sourceDateEpoch) {
  const git = (arguments_) => execFileSync('git', arguments_, { cwd: root, stdio: 'ignore' });
  git(['init', '--quiet']);
  git(['config', 'user.name', 'ClawX Runtime Builder']);
  git(['config', 'user.email', 'runtime-builder@claw-x.invalid']);
  git(['add', '--all']);
  const iso = new Date(sourceDateEpoch * 1_000).toISOString();
  execFileSync('git', ['commit', '--quiet', '-m', 'verified npm patch base'], {
    cwd: root,
    stdio: 'ignore',
    env: { ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso },
  });
}
