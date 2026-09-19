import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile, chmod, lstat } from 'node:fs/promises';
import { dirname, join, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import tar from 'tar';
import JSZip from 'jszip';
import { CUA_DRIVER_VERSION, CUA_DRIVER_TARGETS, resolveCuaDriverArtifact } from './cua-driver-artifacts.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
async function packageDirectory(name, from) {
  const require = createRequire(join(from, 'package.json'));
  // import-only packages need not export package.json or a CJS entrypoint.
  for (const nodeModules of require.resolve.paths(name) ?? []) {
    try {
      const directory = await realpath(join(nodeModules, name));
      if (JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')).name === name) return directory;
    } catch { /* Continue through Node's ordinary dependency lookup roots. */ }
  }
  throw Object.assign(new Error(`Cannot locate pinned package ${name}`), { code: 'MODULE_NOT_FOUND' });
}

export async function materializeCua({ payload, platform = process.platform, arch = process.arch, fetchImpl = fetch, archivePath, ifMissing = false, kernelId = 'openclaw' }) {
  const target = `${platform}-${arch}`;
  if (!CUA_DRIVER_TARGETS.includes(target)) return { supported: false };
  if (!['openclaw', 'deepseek-harness'].includes(kernelId)) throw new Error('Unsupported CUA kernel');
  const runtime = JSON.parse(await readFile(join(root, 'kernels', kernelId, 'runtime.json'), 'utf8'));
  const artifact = resolveCuaDriverArtifact(target);
  const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
  if (runtime.toolInputs?.cua?.version !== CUA_DRIVER_VERSION
    || runtime.toolInputs.cua.archives[artifact.asset] !== artifact.sha256
    || runtime.toolInputs.cua.hostLockfileSha256 !== sha256(await readFile(join(root, 'pnpm-lock.yaml')))
    || runtime.toolInputs.cua.licenseSha256 !== sha256(await readFile(join(root, 'scripts/kernel-runtime/licenses/cua-MIT.txt')))
    || runtime.toolInputs.cua.mplLicenseSha256 !== sha256(await readFile(join(root, 'scripts/kernel-runtime/licenses/MPL-2.0.txt')))) throw new Error('CUA build inputs differ from reviewed runtime');
  const destination = join(payload, 'tools/cua');
  if (await lstat(destination).catch(error => { if (error.code !== 'ENOENT') throw error; return undefined; })) {
    const previous = JSON.parse(await readFile(join(destination, 'package.json'), 'utf8'));
    if (ifMissing && previous.name === '@clawx/cua-tool' && previous.version === CUA_DRIVER_VERSION && previous.archiveSha256 === artifact.sha256
      && sha256(await readFile(join(destination, 'LICENSE'))) === runtime.toolInputs.cua.licenseSha256
      && sha256(await readFile(join(destination, 'MPL-2.0.txt'))) === runtime.toolInputs.cua.mplLicenseSha256
      && (await readFile(join(destination, platform === 'win32' ? 'cua-driver.exe' : 'cua-driver'))).length > 0) return { supported: true, destination };
    throw new Error('CUA destination already exists');
  }
  let archive;
  if (archivePath) archive = await readFile(archivePath);
  else {
    const response = await fetchImpl(artifact.url, { signal: AbortSignal.timeout(300_000) });
    if (!response.ok) throw new Error(`CUA archive download failed (${response.status})`);
    archive = Buffer.from(await response.arrayBuffer());
  }
  if (createHash('sha256').update(archive).digest('hex') !== artifact.sha256) throw new Error('CUA archive digest mismatch');
  const temporary = await mkdtemp(join(tmpdir(), 'clawx-cua-artifact-'));
  try {
    await mkdir(destination, { recursive: true });
    const executable = join(destination, artifact.binName);
    if (artifact.archiveType === 'zip') {
      const zip = await JSZip.loadAsync(archive); const entry = zip.file(artifact.archiveEntry);
      if (!entry || entry.dir) throw new Error('CUA archive has no executable');
      const bytes = await entry.async('nodebuffer');
      if (bytes.length > 256 * 1024 * 1024) throw new Error('CUA executable exceeds limit');
      suppressWindowsConsoleWindow(bytes);
      await writeFile(executable, bytes);
    } else {
      const path = join(temporary, 'driver.tar.gz'); await writeFile(path, archive);
      let files = 0;
      await tar.x({ file: path, cwd: temporary, strict: true, filter: (path, entry) => {
        if (path !== artifact.archiveEntry) return false;
        if (entry.type !== 'File' || entry.size > 256 * 1024 * 1024 || ++files !== 1) throw new Error('Invalid CUA executable');
        return true;
      } });
      if (files !== 1) throw new Error('CUA archive has no executable');
      await cp(join(temporary, artifact.archiveEntry), executable);
    }
    if (platform !== 'win32') await chmod(executable, 0o755);
    const copied = new Map();
    async function copyPackage(name, from) {
      const source = await packageDirectory(name, from);
      const metadata = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
      if (copied.has(name)) {
        if (copied.get(name) !== metadata.version) throw new Error('CUA dependency version conflict');
        return;
      }
      if (name.startsWith('@trycua/cua-driver') && metadata.version !== CUA_DRIVER_VERSION) throw new Error('Unreviewed CUA SDK');
      copied.set(name, metadata.version);
      await cp(source, join(destination, 'node_modules', name), { recursive: true, dereference: false, filter: path => basename(path) !== 'node_modules' });
      for (const dependency of Object.keys(metadata.dependencies ?? {})) await copyPackage(dependency, source);
      if (name === '@trycua/cua-driver') {
        const suffix = platform === 'win32' ? 'win32-x64-msvc' : target;
        await copyPackage(`@trycua/cua-driver-${suffix}`, source);
      } else for (const optional of Object.keys(metadata.optionalDependencies ?? {})) {
        if (name === '@ubjs/node' && optional !== `@ubjs/node-${platform === 'win32' ? 'win32-x64-msvc' : target}`) continue;
        try { await copyPackage(optional, source); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
      }
    }
    await copyPackage('@trycua/cua-driver', root);
    await writeFile(join(destination, 'package.json'), JSON.stringify({ name: '@clawx/cua-tool', version: CUA_DRIVER_VERSION,
      license: 'MIT', archiveSha256: artifact.sha256, dependencies: Object.fromEntries(copied) }, null, 2) + '\n');
    await cp(join(root, 'scripts/kernel-runtime/licenses/cua-MIT.txt'), join(destination, 'LICENSE'));
    await cp(join(root, 'scripts/kernel-runtime/licenses/MPL-2.0.txt'), join(destination, 'MPL-2.0.txt'));
    await writeFile(join(destination, 'NOTICE'), `CUA Driver and SDK ${CUA_DRIVER_VERSION}\nDriver/JS SDK: MIT; native SDK: MIT AND MPL-2.0; UniFFI @ubjs runtime: MPL-2.0.\nPreserve constituent copyright metadata and node-runtime-NOTICE.md.\nMatching source: https://github.com/trycua/cua/tree/cua-driver-rs-v${CUA_DRIVER_VERSION}\nNative runtime transformations: libs/cua-driver/scripts/build-node-runtime.mjs at that release tag.\nUniFFI 0.31.0-3 source: https://github.com/jhugman/uniffi-bindgen-react-native\nExact corresponding-source delivery remains part of the protected runtime promotion obligations.\nPinned dependencies are recorded in package.json and the signed artifact manifest.\n`);
    return { supported: true, destination };
  } catch (error) { await rm(destination, { recursive: true, force: true }); throw error; }
  finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = Object.fromEntries(process.argv.slice(2).reduce((rows, arg, index, values) => index % 2 === 0 ? [...rows, [arg.replace(/^--/, ''), values[index + 1]]] : rows, []));
  console.log(JSON.stringify(await materializeCua({ payload: resolve(args.payload ?? join(root, 'build/host-tools', `${process.platform}-${process.arch}`)), platform: args.platform, arch: args.arch, archivePath: args.archive, ifMissing: args['if-missing'] === 'true', kernelId: args.kernel })));
}

export function suppressWindowsConsoleWindow(bytes) {
  if (bytes.length < 0x40 || bytes.readUInt16LE(0) !== 0x5a4d) throw new Error('Invalid CUA PE header');
  const pe = bytes.readUInt32LE(0x3c);
  if (pe + 24 + 70 > bytes.length || bytes.readUInt32LE(pe) !== 0x00004550) throw new Error('Invalid CUA PE signature');
  const optional = pe + 24;
  if (![0x10b, 0x20b].includes(bytes.readUInt16LE(optional))) throw new Error('Invalid CUA PE optional header');
  const subsystem = bytes.readUInt16LE(optional + 68);
  if (![2, 3].includes(subsystem)) throw new Error('Unexpected CUA PE subsystem');
  bytes.writeUInt16LE(2, optional + 68);
}
