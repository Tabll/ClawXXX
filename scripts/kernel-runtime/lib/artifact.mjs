import { cpSync, existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, readSync, readdirSync, rmSync, statSync, chmodSync, writeFileSync, fsyncSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { zstdCompressSync, constants as zlibConstants } from 'node:zlib';
import tar from 'tar';
import { canonicalJson, readJson, sha256Bytes, sha256File, writeCanonicalJson } from './canonical.mjs';
import { signCanonical } from './signing.mjs';

const TARGETS = new Set(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64']);
const NATIVE_SUFFIX = /\.(?:dll|dylib|exe|node|so(?:\.[0-9]+)*)$/i;
const WRONG_PLATFORM = {
  darwin: /(?:^|[/_.-])(?:linux|win32|windows|win)(?:[/_.-]|$)/i,
  linux: /(?:^|[/_.-])(?:darwin|macos|osx|win32|windows|win)(?:[/_.-]|$)/i,
  win32: /(?:^|[/_.-])(?:darwin|macos|osx|linux)(?:[/_.-]|$)/i,
};
const WRONG_ARCH = {
  arm64: /(?:^|[/_.-])(?:x64|x86_64|amd64|ia32)(?:[/_.-]|$)/i,
  x64: /(?:^|[/_.-])(?:arm64|aarch64|armv7|arm)(?:[/_.-]|$)/i,
};

export async function assembleKernelArtifact(options) {
  const {
    repositoryRoot,
    kernelId,
    platform,
    arch,
    payloadDir,
    nodeDir,
    nodeDistributionSha256,
    testReportPath,
    storageReportPath,
    licenseReportPath,
    platformSecurityReportPath,
    outputDir,
    artifactBaseUrl,
    artifactSigningKeyId,
    artifactSigningPrivateKey,
  } = options;
  const target = `${platform}-${arch}`;
  if (!TARGETS.has(target)) throw new Error(`Unsupported kernel target: ${target}`);
  for (const [label, path] of Object.entries({
    payloadDir, nodeDir, testReportPath, storageReportPath, licenseReportPath, platformSecurityReportPath,
  })) {
    if (!path || !existsSync(path)) throw new Error(`Missing artifact input ${label}: ${path}`);
  }
  const sourcePath = join(repositoryRoot, 'kernels', kernelId, 'source.json');
  const source = readJson(sourcePath);
  const runtimePath = resolveInside(repositoryRoot, source.runtime.path);
  const runtime = readJson(runtimePath);
  const nodeConfig = readJson(resolveInside(repositoryRoot, source.nodeRuntime.path));
  if (runtime.kernelId !== kernelId || runtime.artifactVersion !== source.artifactVersion
    || runtime.patchRevision !== source.patchRevision) throw new Error('Source/runtime identity mismatch');
  const nodeAsset = nodeConfig.assets.find((asset) => asset.platform === platform && asset.arch === arch);
  if (!nodeAsset || (nodeDistributionSha256 && nodeAsset.sha256 !== nodeDistributionSha256)) {
    throw new Error('Node distribution identity mismatch');
  }

  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const safeName = `${kernelId}-${source.artifactVersion}-${platform}-${arch}`;
  const archivePath = join(outputDir, `${safeName}.tar.zst`);
  const descriptorPath = join(outputDir, `${safeName}.descriptor.json`);
  if (existsSync(archivePath) || existsSync(descriptorPath)) {
    throw new Error(`Immutable artifact output already exists: ${safeName}`);
  }
  const stagingRoot = join(outputDir, `.${safeName}.staging-${process.pid}`);
  if (existsSync(stagingRoot)) throw new Error(`Staging path already exists: ${stagingRoot}`);
  mkdirSync(join(stagingRoot, 'runtime'), { recursive: true, mode: 0o700 });
  mkdirSync(join(stagingRoot, 'metadata'), { recursive: true, mode: 0o700 });
  try {
    cpSync(payloadDir, join(stagingRoot, 'runtime', 'kernel'), { recursive: true, dereference: true, force: false });
    cpSync(nodeDir, join(stagingRoot, 'runtime', 'node'), { recursive: true, dereference: true, force: false });
    normalizeTree(stagingRoot);
    assertEntrypoints(stagingRoot, runtime.entrypoints);
    validateNativePayloads(stagingRoot, platform, arch, runtime.nativePayloadAllowlist[target] ?? []);

    const runtimeManifest = buildFileManifest(join(stagingRoot, 'runtime'), source.sourceDateEpoch);
    const fileManifestPath = join(stagingRoot, 'metadata', 'files.json');
    writeCanonicalJson(fileManifestPath, runtimeManifest);
    const copiedLicenseReport = join(stagingRoot, 'metadata', 'licenses.json');
    copyVerifiedJsonReport(licenseReportPath, copiedLicenseReport, 'license audit report');
    const licenseReport = readJson(copiedLicenseReport);
    if (licenseReport.kernelId !== kernelId || !Array.isArray(licenseReport.packages)) {
      throw new Error('License audit report identity or package inventory is invalid');
    }
    const copiedPlatformSecurityReport = join(stagingRoot, 'metadata', 'platform-security.json');
    copyVerifiedJsonReport(platformSecurityReportPath, copiedPlatformSecurityReport, 'platform security report');
    const platformSecurityReport = readJson(copiedPlatformSecurityReport);
    if (platformSecurityReport.platform !== platform || platformSecurityReport.arch !== arch) {
      throw new Error('Platform security report identity does not match the runtime artifact');
    }
    const spdx = buildSpdxSbom(stagingRoot, source, runtimeManifest, licenseReport);
    const cycloneDx = buildCycloneDxSbom(stagingRoot, source, runtimeManifest, licenseReport);
    const spdxPath = join(stagingRoot, 'metadata', 'sbom.spdx.json');
    const cycloneDxPath = join(stagingRoot, 'metadata', 'sbom.cyclonedx.json');
    writeCanonicalJson(spdxPath, spdx);
    writeCanonicalJson(cycloneDxPath, cycloneDx);

    const noticesPath = join(stagingRoot, 'metadata', 'THIRD_PARTY_NOTICES.md');
    const notices = buildNotices(repositoryRoot, source, nodeConfig.version);
    writeFileSync(noticesPath, notices, { encoding: 'utf8', mode: 0o600 });
    const copiedTestReport = join(stagingRoot, 'metadata', 'tests.json');
    const copiedStorageReport = join(stagingRoot, 'metadata', 'storage-contract.json');
    copyVerifiedJsonReport(testReportPath, copiedTestReport, 'test report');
    copyVerifiedJsonReport(storageReportPath, copiedStorageReport, 'storage contract report');
    const storageReport = readJson(copiedStorageReport);
    if (storageReport.ok !== true || storageReport.nativeDurableHistory !== false) {
      throw new Error('Storage contract report does not prove DataService-only persistence');
    }

    const supplyChain = {
      sourceSha256: sha256File(sourcePath),
      lockfileSha256: source.lockfile.contentSha256,
      patchSeriesSha256: sha256File(resolveInside(repositoryRoot, source.patchSeries.path)),
      fileManifestSha256: sha256File(fileManifestPath),
      sbomSha256: sha256File(spdxPath),
      noticesSha256: sha256File(noticesPath),
      provenanceSha256: '',
      testReportSha256: sha256File(copiedTestReport),
      licenseReportSha256: sha256File(copiedLicenseReport),
      platformSecurityReportSha256: sha256File(copiedPlatformSecurityReport),
    };
    const provenance = buildProvenance({
      source,
      platform,
      arch,
      nodeAsset,
      sourceSha256: supplyChain.sourceSha256,
      lockfileSha256: supplyChain.lockfileSha256,
      patchSeriesSha256: supplyChain.patchSeriesSha256,
      overlayManifestSha256: source.overlay?.manifestSha256,
      runtimeManifestSha256: supplyChain.fileManifestSha256,
      testReportSha256: supplyChain.testReportSha256,
      storageReportSha256: sha256File(copiedStorageReport),
      licenseReportSha256: supplyChain.licenseReportSha256,
      platformSecurityReportSha256: supplyChain.platformSecurityReportSha256,
    });
    const provenancePath = join(stagingRoot, 'metadata', 'provenance.slsa.json');
    writeCanonicalJson(provenancePath, provenance);
    supplyChain.provenanceSha256 = sha256File(provenancePath);

    const artifactManifest = {
      schemaVersion: 1,
      kernelId,
      artifactVersion: source.artifactVersion,
      upstreamVersion: source.version,
      upstreamCommit: source.git.commit,
      patchRevision: source.patchRevision,
      platform,
      arch,
      node: { version: nodeConfig.version, moduleAbi: nodeConfig.moduleAbi, distributionSha256: nodeAsset.sha256 },
      capabilityContractVersion: runtime.capabilityContractVersion,
      protocols: runtime.protocols,
      checkpointCodecs: runtime.checkpointCodecs,
      storage: {
        authority: 'clawx-data-service',
        nativeDurableHistory: false,
        regressionReportSha256: sha256File(copiedStorageReport),
      },
      entrypoints: runtime.entrypoints,
      supplyChain,
      sourceDateEpoch: source.sourceDateEpoch,
    };
    writeCanonicalJson(join(stagingRoot, 'metadata', 'artifact-manifest.json'), artifactManifest);
    normalizeTree(stagingRoot);

    const archive = await createDeterministicTarZstd(stagingRoot, source.sourceDateEpoch);
    writeFileSync(archivePath, archive, { mode: 0o600, flag: 'wx' });
    fsyncFile(archivePath);
    const archiveStats = statSync(archivePath);
    const wholeManifest = buildFileManifest(stagingRoot, source.sourceDateEpoch);
    enforceBudgets(runtime.budgets, archiveStats.size, wholeManifest.totalBytes, wholeManifest.fileCount);
    const publishedAt = new Date(source.sourceDateEpoch * 1_000).toISOString();
    const expiresAt = new Date((source.sourceDateEpoch + 180 * 24 * 60 * 60) * 1_000).toISOString();
    const unsignedDescriptor = {
      schemaVersion: 1,
      kernelId,
      displayName: source.displayName,
      upstreamVersion: source.version,
      upstreamCommit: source.git.commit,
      patchRevision: source.patchRevision,
      artifactVersion: source.artifactVersion,
      platform,
      arch,
      minHostVersion: runtime.minHostVersion,
      maxHostVersion: runtime.maxHostVersion,
      capabilityContractVersion: runtime.capabilityContractVersion,
      protocols: runtime.protocols,
      checkpointCodecs: runtime.checkpointCodecs,
      storage: artifactManifest.storage,
      node: artifactManifest.node,
      archive: {
        format: 'tar.zst',
        url: `${artifactBaseUrl.replace(/\/$/, '')}/${basename(archivePath)}`,
        sha256: sha256File(archivePath),
        compressedSize: archiveStats.size,
        unpackedSize: wholeManifest.totalBytes,
        fileCount: wholeManifest.fileCount,
      },
      entrypoints: runtime.entrypoints,
      supplyChain,
      budgets: { coldReadyMs: runtime.budgets.coldReadyMs, idleRssBytes: runtime.budgets.idleRssBytes },
      publishedAt,
      expiresAt,
    };
    const descriptor = {
      ...unsignedDescriptor,
      descriptorSignature: signCanonical(unsignedDescriptor, artifactSigningPrivateKey, artifactSigningKeyId),
    };
    writeCanonicalJson(descriptorPath, descriptor);
    writeFileSync(`${archivePath}.sha256`, `${descriptor.archive.sha256}  ${basename(archivePath)}\n`, { mode: 0o600, flag: 'wx' });
    return { archivePath, descriptorPath, descriptor };
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true, maxRetries: 3 });
  }
}

export function buildFileManifest(root, sourceDateEpoch) {
  const entries = walkFiles(root).map((absolutePath) => {
    const stats = lstatSync(absolutePath);
    if (!stats.isFile()) throw new Error(`Artifact trees may only contain regular files: ${absolutePath}`);
    return {
      path: toPosix(relative(root, absolutePath)),
      sha256: sha256File(absolutePath),
      size: stats.size,
      mode: stats.mode & 0o111 ? '0755' : '0644',
    };
  });
  return {
    schemaVersion: 1,
    sourceDateEpoch,
    fileCount: entries.length,
    totalBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
    files: entries,
  };
}

export function validateNativePayloads(root, platform, arch, allowlist) {
  const compiled = allowlist.map(globToRegExp);
  const violations = [];
  for (const file of walkFiles(root)) {
    const path = toPosix(relative(root, file));
    if (path.startsWith('runtime/node/')) continue;
    if (!isNativeFile(file, path)) continue;
    if (WRONG_PLATFORM[platform].test(path) || WRONG_ARCH[arch].test(path)) {
      violations.push(`${path} targets another platform or architecture`);
      continue;
    }
    if (!compiled.some((pattern) => pattern.test(path))) violations.push(`${path} is not in the audited native allowlist`);
  }
  if (violations.length > 0) throw new Error(`Native payload validation failed:\n${violations.join('\n')}`);
}

export async function createDeterministicTarZstd(root, sourceDateEpoch) {
  if (typeof zstdCompressSync !== 'function') throw new Error('Node runtime lacks built-in Zstandard support');
  const paths = walkFiles(root).map((path) => toPosix(relative(root, path))).sort();
  const chunks = [];
  const stream = tar.c({
    cwd: root,
    portable: true,
    strict: true,
    follow: false,
    noPax: true,
    mtime: new Date(sourceDateEpoch * 1_000),
  }, paths);
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return zstdCompressSync(Buffer.concat(chunks), {
    params: {
      [zlibConstants.ZSTD_c_compressionLevel]: 19,
      [zlibConstants.ZSTD_c_checksumFlag]: 1,
      [zlibConstants.ZSTD_c_contentSizeFlag]: 1,
      [zlibConstants.ZSTD_c_nbWorkers]: 0,
    },
  });
}

function buildSpdxSbom(root, source, runtimeManifest, licenseReport) {
  const packages = discoverPackages(join(root, 'runtime', 'kernel'), licenseReport);
  const namespaceSeed = sha256Bytes(canonicalJson({ artifactVersion: source.artifactVersion, files: runtimeManifest.files }));
  return {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: `${source.kernelId}-${source.artifactVersion}`,
    documentNamespace: `https://claw-x.com/spdx/${source.kernelId}/${namespaceSeed}`,
    creationInfo: {
      created: new Date(source.sourceDateEpoch * 1_000).toISOString(),
      creators: ['Tool: clawx-kernel-runtime-builder/1'],
    },
    packages: packages.map((pkg) => ({
      SPDXID: pkg.spdxId,
      name: pkg.name,
      versionInfo: pkg.version,
      downloadLocation: 'NOASSERTION',
      filesAnalyzed: false,
      licenseConcluded: pkg.license,
      licenseDeclared: pkg.license,
      checksums: [{ algorithm: 'SHA256', checksumValue: pkg.packageJsonSha256 }],
    })),
    relationships: packages.map((pkg) => ({
      spdxElementId: 'SPDXRef-DOCUMENT',
      relationshipType: 'DESCRIBES',
      relatedSpdxElement: pkg.spdxId,
    })),
  };
}

function buildCycloneDxSbom(root, source, runtimeManifest, licenseReport) {
  const packages = discoverPackages(join(root, 'runtime', 'kernel'), licenseReport);
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    serialNumber: `urn:uuid:${uuidFromHash(sha256Bytes(canonicalJson(runtimeManifest)))}`,
    version: 1,
    metadata: {
      timestamp: new Date(source.sourceDateEpoch * 1_000).toISOString(),
      component: { type: 'application', name: source.kernelId, version: source.artifactVersion },
    },
    components: packages.map((pkg) => ({
      type: 'library',
      'bom-ref': pkg.spdxId,
      name: pkg.name,
      version: pkg.version,
      licenses: [{ expression: pkg.license }],
      hashes: [{ alg: 'SHA-256', content: pkg.packageJsonSha256 }],
    })),
  };
}

function buildProvenance(input) {
  return {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{
      name: `${input.source.kernelId}/${input.source.artifactVersion}/${input.platform}-${input.arch}/runtime`,
      digest: { sha256: input.runtimeManifestSha256 },
    }],
    predicateType: 'https://slsa.dev/provenance/v1',
    predicate: {
      buildDefinition: {
        buildType: 'https://claw-x.com/build-types/kernel-runtime/v1',
        externalParameters: {
          kernelId: input.source.kernelId,
          artifactVersion: input.source.artifactVersion,
          platform: input.platform,
          arch: input.arch,
        },
        resolvedDependencies: [
          { uri: input.source.upstream, digest: { gitCommit: input.source.git.commit, sha256: input.sourceSha256 } },
          { uri: input.source.lockfile.contentPath, digest: { sha256: input.lockfileSha256 } },
          { uri: input.source.patchSeries.path, digest: { sha256: input.patchSeriesSha256 } },
          ...(input.overlayManifestSha256 ? [{ uri: input.source.overlay.manifest, digest: { sha256: input.overlayManifestSha256 } }] : []),
          { uri: input.nodeAsset.filename, digest: { sha256: input.nodeAsset.sha256 } },
        ],
      },
      runDetails: {
        builder: { id: 'https://github.com/claw-x/ClawX/.github/workflows/kernel-runtime-build.yml' },
        metadata: { invocationId: 'reproducible', startedOn: new Date(input.source.sourceDateEpoch * 1_000).toISOString(), finishedOn: new Date(input.source.sourceDateEpoch * 1_000).toISOString() },
        byproducts: [
          { name: 'tests', digest: { sha256: input.testReportSha256 } },
          { name: 'storage-contract', digest: { sha256: input.storageReportSha256 } },
          { name: 'license-audit', digest: { sha256: input.licenseReportSha256 } },
          { name: 'platform-security', digest: { sha256: input.platformSecurityReportSha256 } },
        ],
      },
    },
  };
}

function buildNotices(repositoryRoot, source, nodeVersion) {
  const projectNotices = readFileSync(join(repositoryRoot, 'THIRD_PARTY_NOTICES.md'), 'utf8').trimEnd();
  return `${projectNotices}\n\n## Runtime-specific inputs\n\n- ${source.displayName} ${source.version} — ${source.license} — ${source.upstream}\n- Node.js ${nodeVersion} — MIT and bundled third-party licenses — https://nodejs.org/\n`;
}

function discoverPackages(root, licenseReport) {
  const resolvedLicenses = new Map();
  for (const record of licenseReport.packages) {
    if (typeof record?.name !== 'string' || typeof record?.version !== 'string' || typeof record?.license !== 'string') {
      throw new Error('License audit report contains an invalid package record');
    }
    const identity = `${record.name}@${record.version}`;
    const prior = resolvedLicenses.get(identity);
    if (prior && prior !== record.license) throw new Error(`License audit report conflicts for ${identity}`);
    resolvedLicenses.set(identity, record.license);
  }
  const packages = [];
  for (const path of walkFiles(root)) {
    if (basename(path) !== 'package.json') continue;
    let pkg;
    try {
      pkg = readJson(path);
    } catch {
      throw new Error(`Invalid package.json in runtime payload: ${path}`);
    }
    if (typeof pkg.name !== 'string' || typeof pkg.version !== 'string') continue;
    const identity = `${pkg.name}@${pkg.version}`;
    const license = resolvedLicenses.get(identity);
    if (!license) throw new Error(`Package is missing from successful license audit: ${identity}`);
    const packageJsonSha256 = sha256File(path);
    packages.push({
      name: pkg.name,
      version: pkg.version,
      license,
      packageJsonSha256,
      spdxId: `SPDXRef-Package-${sanitizeId(pkg.name)}-${packageJsonSha256.slice(0, 12)}`,
    });
  }
  return packages.sort((a, b) => a.spdxId.localeCompare(b.spdxId));
}

function normalizeTree(root) {
  for (const path of walkAll(root)) {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) throw new Error(`Runtime tree contains a symlink after materialization: ${path}`);
    if (stats.isDirectory()) chmodSync(path, 0o755);
    else if (stats.isFile()) chmodSync(path, stats.mode & 0o111 || /(?:^|\/)(?:node|node\.exe)$/.test(toPosix(path)) ? 0o755 : 0o644);
    else throw new Error(`Runtime tree contains a non-regular filesystem entry: ${path}`);
  }
}

function assertEntrypoints(root, entrypoints) {
  for (const [name, path] of Object.entries(entrypoints)) {
    const absolutePath = resolveInside(root, path);
    if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) throw new Error(`Missing ${name} entrypoint: ${path}`);
  }
}

function copyVerifiedJsonReport(source, destination, label) {
  const value = readJson(source);
  if (!value || typeof value !== 'object' || value.ok !== true) throw new Error(`${label} is not successful`);
  writeCanonicalJson(destination, value);
}

function enforceBudgets(budgets, compressedBytes, unpackedBytes, fileCount) {
  const actual = { compressedBytes, unpackedBytes, fileCount };
  for (const field of Object.keys(actual)) {
    if (!Number.isInteger(budgets[field]) || actual[field] > budgets[field]) {
      throw new Error(`Runtime ${field} budget exceeded: ${actual[field]} > ${budgets[field]}`);
    }
  }
}

function isNativeFile(file, path) {
  if (NATIVE_SUFFIX.test(path)) return true;
  const size = statSync(file).size;
  if (size < 4) return false;
  const descriptor = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(4);
    readFileChunk(descriptor, buffer);
    const hex = buffer.toString('hex');
    return hex.startsWith('7f454c46') || hex.startsWith('4d5a')
      || ['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe'].includes(hex);
  } finally {
    closeSync(descriptor);
  }
}

function readFileChunk(descriptor, buffer) {
  readSync(descriptor, buffer, 0, buffer.length, 0);
}

function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function walkFiles(root) {
  return walkAll(root).filter((path) => lstatSync(path).isFile()).sort((a, b) => toPosix(relative(root, a)).localeCompare(toPosix(relative(root, b))));
}

function walkAll(root) {
  const output = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      output.push(path);
      if (entry.isDirectory()) visit(path);
    }
  };
  visit(root);
  return output;
}

function resolveInside(root, path) {
  if (typeof path !== 'string' || path === '' || path.includes('\\') || path.startsWith('/')) throw new Error(`Unsafe artifact path: ${path}`);
  const base = resolve(root);
  const target = resolve(base, path);
  const rel = relative(base, target);
  if (rel === '..' || rel.startsWith(`..${sep}`)) throw new Error(`Artifact path escapes root: ${path}`);
  return target;
}

function toPosix(path) {
  return path.split(sep).join('/');
}

function sanitizeId(value) {
  return value.replace(/[^A-Za-z0-9.-]/g, '-').replace(/-+/g, '-');
}

function uuidFromHash(hash) {
  const chars = hash.slice(0, 32).split('');
  chars[12] = '4';
  chars[16] = ['8', '9', 'a', 'b'][Number.parseInt(chars[16], 16) % 4];
  const value = chars.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function fsyncFile(path) {
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
