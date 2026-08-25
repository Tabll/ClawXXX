#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import JSZip from 'jszip';
import { readJson, sha256File } from './lib/canonical.mjs';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const platform = args.get('--platform');
const arch = args.get('--arch');
const destination = args.get('--destination');
if (!platform || !arch || !destination) throw new Error('Usage: download-node-runtime --platform PLATFORM --arch ARCH --destination DIR');
const repositoryRoot = resolve(args.get('--repository') ?? process.cwd());
const config = readJson(join(repositoryRoot, 'kernels', 'node-runtime.json'));
const asset = config.assets.find((candidate) => candidate.platform === platform && candidate.arch === arch);
if (!asset) throw new Error(`No pinned Node runtime for ${platform}-${arch}`);
const finalDestination = resolve(destination);
if (existsSync(finalDestination)) throw new Error(`Node runtime destination already exists: ${finalDestination}`);
mkdirSync(dirname(finalDestination), { recursive: true, mode: 0o700 });
const temporaryRoot = mkdtempSync(join(tmpdir(), 'clawx-node-runtime-'));
try {
  const archivePath = join(temporaryRoot, asset.filename);
  await downloadAtomic(`${config.source}${asset.filename}`, archivePath, asset.sha256);
  const extracted = join(temporaryRoot, 'extracted');
  mkdirSync(extracted, { recursive: true, mode: 0o700 });
  if (asset.filename.endsWith('.zip')) await extractZip(archivePath, extracted);
  else execFileSync('tar', ['-xJf', archivePath, '-C', extracted], { stdio: 'inherit' });
  const sourceRoot = join(extracted, asset.archiveRoot);
  if (!existsSync(sourceRoot)) throw new Error(`Node archive root is missing: ${asset.archiveRoot}`);
  const staging = join(temporaryRoot, 'minimal');
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  const executable = platform === 'win32' ? 'node.exe' : join('bin', 'node');
  mkdirSync(join(staging, platform === 'win32' ? '.' : 'bin'), { recursive: true, mode: 0o700 });
  cpSync(join(sourceRoot, executable), join(staging, executable), { force: false });
  cpSync(join(sourceRoot, 'LICENSE'), join(staging, 'LICENSE'), { force: false });
  writeFileSync(join(staging, 'CLAWX_NODE_RUNTIME.json'), `${JSON.stringify({
    schemaVersion: 1,
    version: config.version,
    moduleAbi: config.moduleAbi,
    platform,
    arch,
    sourceArchive: asset.filename,
    sourceSha256: asset.sha256,
  }, null, 2)}\n`, { mode: 0o600 });
  if (process.platform === platform && process.arch === arch) {
    const nodePath = join(staging, executable);
    const probe = execFileSync(nodePath, ['-p', 'JSON.stringify({version:process.versions.node,abi:Number(process.versions.modules)})'], { encoding: 'utf8' });
    const identity = JSON.parse(probe);
    if (identity.version !== config.version || identity.abi !== config.moduleAbi) throw new Error(`Node runtime probe mismatch: ${probe}`);
  }
  renameSync(staging, finalDestination);
  process.stdout.write(`${JSON.stringify({ ok: true, version: config.version, moduleAbi: config.moduleAbi, asset: asset.filename, sha256: asset.sha256 })}\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 3 });
}

async function downloadAtomic(url, destinationPath, expectedSha256) {
  const partial = `${destinationPath}.partial`;
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10 * 60_000) });
  if (!response.ok || !response.body) throw new Error(`Node download failed: ${response.status} ${response.statusText}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { flags: 'wx', mode: 0o600 }));
  if (sha256File(partial) !== expectedSha256) throw new Error(`Node archive SHA-256 mismatch for ${basename(destinationPath)}`);
  renameSync(partial, destinationPath);
}

async function extractZip(archivePath, destinationRoot) {
  const zip = await JSZip.loadAsync(readFileSync(archivePath), { checkCRC32: true, createFolders: false });
  for (const [name, entry] of Object.entries(zip.files)) {
    if (name.startsWith('/') || name.includes('\\') || name.split('/').some((segment) => segment === '..')) {
      throw new Error(`Unsafe Node zip entry: ${name}`);
    }
    if (entry.dir) continue;
    const output = join(destinationRoot, name);
    mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
    const bytes = await entry.async('nodebuffer');
    writeFileSync(output, bytes, { mode: 0o600, flag: 'wx' });
    if (statSync(output).size !== bytes.length) throw new Error(`Truncated Node zip entry: ${name}`);
  }
}
