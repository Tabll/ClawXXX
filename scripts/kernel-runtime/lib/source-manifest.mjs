import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { assertExactKeys, readJson, sha256File } from './canonical.mjs';

const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const ARTIFACT_VERSION = /^.+\+clawx\.[1-9][0-9]*$/;

export function parseSourceManifest(input) {
  assertExactKeys(input, [
    'schemaVersion', 'kernelId', 'displayName', 'upstream', 'version', 'patchBase', 'git', 'license',
    'artifactVersion', 'patchRevision', 'sourceDateEpoch', 'lockfile', 'patchSeries',
    'runtime', 'nodeRuntime', 'patches',
  ], ['npm', 'sourceEvidence', 'overlay'], 'source manifest');
  if (input.schemaVersion !== 1) throw new TypeError('Unsupported source manifest version');
  for (const field of ['kernelId', 'displayName', 'upstream', 'version', 'license']) {
    if (typeof input[field] !== 'string' || input[field].length === 0) throw new TypeError(`Invalid source.${field}`);
  }
  if (!input.upstream.startsWith('https://github.com/')) throw new TypeError('Upstream must be a GitHub HTTPS URL');
  if (input.patchBase !== 'git-checkout' && input.patchBase !== 'npm-tarball') throw new TypeError('Invalid patchBase');
  if (input.patchBase === 'npm-tarball' && !input.npm) throw new TypeError('npm-tarball patchBase requires pinned npm metadata');
  if (!ARTIFACT_VERSION.test(input.artifactVersion) || !input.artifactVersion.startsWith(`${input.version}+clawx.`)) {
    throw new TypeError('artifactVersion must combine the exact upstream version with +clawx.N');
  }
  if (!Number.isInteger(input.patchRevision) || input.patchRevision < 1
    || !input.artifactVersion.endsWith(`+clawx.${input.patchRevision}`)) {
    throw new TypeError('patchRevision must match artifactVersion');
  }
  if (!Number.isInteger(input.sourceDateEpoch) || input.sourceDateEpoch <= 0) throw new TypeError('Invalid sourceDateEpoch');
  assertExactKeys(input.git, ['commit'], ['tag', 'tagObject', 'branch', 'tree'], 'source.git');
  if (!COMMIT.test(input.git.commit)) throw new TypeError('source.git.commit must be a full lowercase commit');
  for (const field of ['lockfile', 'patchSeries', 'runtime', 'nodeRuntime']) {
    const required = field === 'lockfile'
      ? ['descriptor', 'descriptorSha256', 'contentPath', 'contentSha256']
      : ['path', 'sha256'];
    assertExactKeys(input[field], required, [], `source.${field}`);
    for (const hashField of Object.keys(input[field]).filter((key) => key.toLowerCase().includes('sha256'))) {
      if (!SHA256.test(input[field][hashField])) throw new TypeError(`Invalid source.${field}.${hashField}`);
    }
  }
  if (!Array.isArray(input.patches)) throw new TypeError('source.patches must be an array');
  for (const [index, patch] of input.patches.entries()) {
    assertExactKeys(patch, ['path', 'sha256'], [], `source.patches[${index}]`);
    if (!SHA256.test(patch.sha256)) throw new TypeError(`Invalid patch hash at ${index}`);
  }
  if (input.overlay) {
    assertExactKeys(input.overlay, ['root', 'manifest', 'manifestSha256'], [], 'source.overlay');
    if (!SHA256.test(input.overlay.manifestSha256)) throw new TypeError('Invalid overlay manifest hash');
  }
  if (/\^|~|\*|\blatest\b|\bHEAD\b/.test(JSON.stringify(input))) throw new TypeError('Source manifest contains a floating version');
  return input;
}

export function readPatchSeries(path) {
  return readFileSync(path, 'utf8').split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

export function verifySourceInputs({ repositoryRoot, kernelId, sourceCheckout }) {
  const sourcePath = join(repositoryRoot, 'kernels', kernelId, 'source.json');
  const source = parseSourceManifest(readJson(sourcePath));
  if (source.kernelId !== kernelId) throw new Error(`Kernel identity mismatch: expected ${kernelId}, received ${source.kernelId}`);
  verifyPinnedFile(repositoryRoot, source.lockfile.descriptor, source.lockfile.descriptorSha256, 'lock descriptor');
  verifyPinnedFile(repositoryRoot, source.patchSeries.path, source.patchSeries.sha256, 'patch series');
  verifyPinnedFile(repositoryRoot, source.runtime.path, source.runtime.sha256, 'runtime config');
  verifyPinnedFile(repositoryRoot, source.nodeRuntime.path, source.nodeRuntime.sha256, 'Node runtime config');

  const series = readPatchSeries(resolveInside(repositoryRoot, source.patchSeries.path));
  if (JSON.stringify(series) !== JSON.stringify(source.patches.map((patch) => patch.path))) {
    throw new Error(`${kernelId} patch series and source.patches differ`);
  }
  for (const patch of source.patches) verifyPinnedFile(repositoryRoot, patch.path, patch.sha256, 'source patch');

  const lockDescriptor = readJson(resolveInside(repositoryRoot, source.lockfile.descriptor));
  assertExactKeys(lockDescriptor, [
    'schemaVersion', 'strategy', 'packageManager', 'path', 'sha256', 'frozenInstall',
    'lifecycleScripts',
  ], ['upstreamSha256'], 'lock descriptor');
  if (lockDescriptor.schemaVersion !== 1 || lockDescriptor.frozenInstall !== true
    || lockDescriptor.path !== source.lockfile.contentPath || lockDescriptor.sha256 !== source.lockfile.contentSha256) {
    throw new Error(`${kernelId} lock descriptor disagrees with source manifest`);
  }
  if (lockDescriptor.strategy === 'repository-frozen-lockfile') {
    verifyPinnedFile(repositoryRoot, source.lockfile.contentPath, source.lockfile.contentSha256, 'frozen lockfile');
  } else if (sourceCheckout) {
    const expectedCheckoutHash = lockDescriptor.strategy === 'patched-upstream-lockfile'
      ? lockDescriptor.upstreamSha256
      : source.lockfile.contentSha256;
    if (!SHA256.test(expectedCheckoutHash ?? '')) throw new Error(`${kernelId} lock descriptor lacks an upstream hash`);
    verifyPinnedFile(sourceCheckout, source.lockfile.contentPath, expectedCheckoutHash, 'upstream frozen lockfile');
  }

  if (source.overlay) verifyOverlay(repositoryRoot, source.overlay);
  return { source, sourcePath, series };
}

export function verifyPreparedLockfile({ repositoryRoot, checkoutRoot, source }) {
  const descriptor = readJson(resolveInside(repositoryRoot, source.lockfile.descriptor));
  const root = descriptor.strategy === 'repository-frozen-lockfile' ? repositoryRoot : checkoutRoot;
  verifyPinnedFile(root, source.lockfile.contentPath, source.lockfile.contentSha256, 'prepared frozen lockfile');
}

export function applyStrictPatchSeries({ repositoryRoot, checkoutRoot, source }) {
  const before = git(checkoutRoot, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (before !== '') throw new Error('Patch checkout must be completely clean before applying the recorded series');
  const expectedPaths = new Set();
  for (const patch of source.patches) {
    const patchPath = resolveInside(repositoryRoot, patch.path);
    for (const target of patchTargets(patchPath)) expectedPaths.add(target);
    const checked = git(checkoutRoot, ['apply', '--check', '--index', '--whitespace=error-all', '--verbose', patchPath], true);
    rejectFuzzyApply(checked, patch.path);
    const applied = git(checkoutRoot, ['apply', '--index', '--whitespace=error-all', '--verbose', patchPath], true);
    rejectFuzzyApply(applied, patch.path);
  }
  const status = git(checkoutRoot, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status.split(/\r?\n/).some((line) => line.startsWith('??'))) throw new Error('Patch application produced unrecorded files');
  const changed = git(checkoutRoot, ['diff', '--cached', '--name-only', '--diff-filter=ACMRT']).split(/\r?\n/).filter(Boolean);
  if (changed.length !== expectedPaths.size || changed.some((path) => !expectedPaths.has(path))) {
    throw new Error(`Patched working tree differs from series targets: ${changed.join(', ')}`);
  }
  const check = git(checkoutRoot, ['diff', '--cached', '--check']);
  if (check !== '') throw new Error(`Patched working tree failed git diff --check:\n${check}`);
  return changed;
}

export function materializeOverlay({ repositoryRoot, checkoutRoot, overlay }) {
  const manifestPath = resolveInside(repositoryRoot, overlay.manifest);
  const manifest = readJson(manifestPath);
  assertExactKeys(manifest, ['schemaVersion', 'root', 'files'], [], 'overlay manifest');
  if (manifest.schemaVersion !== 1 || manifest.root !== overlay.root || !Array.isArray(manifest.files)) {
    throw new Error('Invalid overlay manifest');
  }
  const overlayRoot = resolveInside(repositoryRoot, overlay.root);
  for (const file of manifest.files) {
    assertExactKeys(file, ['path', 'sha256'], [], 'overlay file');
    const sourcePath = resolveInside(overlayRoot, file.path);
    if (sha256File(sourcePath) !== file.sha256) throw new Error(`Overlay changed after review: ${file.path}`);
    const destination = resolveInside(checkoutRoot, file.path);
    if (existsSync(destination)) throw new Error(`Overlay refuses to replace unpatched upstream path: ${file.path}`);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    cpSync(sourcePath, destination, { recursive: false, force: false });
  }
}

function verifyOverlay(repositoryRoot, overlay) {
  verifyPinnedFile(repositoryRoot, overlay.manifest, overlay.manifestSha256, 'overlay manifest');
  const manifest = readJson(resolveInside(repositoryRoot, overlay.manifest));
  assertExactKeys(manifest, ['schemaVersion', 'root', 'files'], [], 'overlay manifest');
  if (manifest.schemaVersion !== 1 || manifest.root !== overlay.root || !Array.isArray(manifest.files)) {
    throw new Error('Invalid overlay manifest structure');
  }
  const seen = new Set();
  for (const file of manifest.files) {
    assertExactKeys(file, ['path', 'sha256'], [], 'overlay file');
    if (seen.has(file.path)) throw new Error(`Duplicate overlay file: ${file.path}`);
    seen.add(file.path);
    verifyPinnedFile(resolveInside(repositoryRoot, overlay.root), file.path, file.sha256, 'overlay file');
  }
  const overlayRoot = resolveInside(repositoryRoot, overlay.root);
  const actual = regularOverlayFiles(overlayRoot);
  const recorded = manifest.files.map((file) => file.path);
  if (JSON.stringify(recorded) !== JSON.stringify(actual)) {
    const omitted = actual.filter((path) => !seen.has(path));
    const missing = recorded.filter((path) => !actual.includes(path));
    throw new Error(`Overlay manifest file set/order mismatch; omitted=${omitted.join(',')} missing=${missing.join(',')}`);
  }
}

function regularOverlayFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => (
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    ))) {
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`Overlay contains a symbolic link: ${relative(root, path)}`);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) files.push(relative(root, path).split(sep).join('/'));
      else throw new Error(`Overlay contains a non-regular entry: ${relative(root, path)}`);
    }
  };
  visit(root);
  return files;
}

function verifyPinnedFile(root, relativePath, expected, label) {
  const path = resolveInside(root, relativePath);
  if (!existsSync(path) || !lstatSync(path).isFile()) throw new Error(`Missing ${label}: ${relativePath}`);
  const actual = sha256File(path);
  if (actual !== expected) throw new Error(`${label} hash mismatch for ${relativePath}: ${actual}`);
}

function patchTargets(path) {
  const targets = [];
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line.startsWith('diff --git a/')) continue;
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (!match || match[1] !== match[2]) throw new Error(`Patch contains a rename or invalid target: ${line}`);
    const target = match[2];
    if (!isSafeRelative(target)) throw new Error(`Patch target escapes checkout: ${target}`);
    targets.push(target);
  }
  if (targets.length === 0) throw new Error(`Patch contains no targets: ${path}`);
  return targets;
}

function rejectFuzzyApply(output, patch) {
  if (/\boffset\b|\bfuzz\b/i.test(output)) throw new Error(`Patch ${patch} would apply with fuzz or offset`);
}

function git(cwd, args, includeStderr = false) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed:\n${stdout}${stderr}`);
  return (includeStderr ? `${stdout}\n${stderr}` : stdout).trim();
}

function resolveInside(root, path) {
  if (typeof path !== 'string' || !isSafeRelative(path)) throw new Error(`Unsafe repository path: ${String(path)}`);
  const base = resolve(root);
  const target = resolve(base, normalize(path));
  const rel = relative(base, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Path escapes root: ${path}`);
  return target;
}

function isSafeRelative(path) {
  return typeof path === 'string' && path !== '' && !isAbsolute(path) && !path.includes('\\')
    && path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}
