#!/usr/bin/env node
import { chmod, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import tar from 'tar';
import JSZip from 'jszip';

export const DWS_VERSION = '1.0.30';
export const DWS_ARCHIVES = {
  'darwin-x64': 'dws-darwin-amd64.tar.gz', 'darwin-arm64': 'dws-darwin-arm64.tar.gz',
  'linux-x64': 'dws-linux-amd64.tar.gz', 'linux-arm64': 'dws-linux-arm64.tar.gz',
  'win32-x64': 'dws-windows-amd64.zip', 'win32-arm64': 'dws-windows-arm64.zip',
};

/** CI/dev only: build a fixed, platform-specific immutable tool payload. */
export async function materializeDws({ packageRoot, payload, platform, arch, ifMissing = false, kernelId = 'openclaw' }) {
  if (!['openclaw', 'deepseek-harness'].includes(kernelId)) throw new Error('Unsupported DWS kernel');
  const metadata = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  if (metadata.name !== 'dingtalk-workspace-cli' || metadata.version !== DWS_VERSION) throw new Error('Unreviewed DWS package');
  const archive = DWS_ARCHIVES[`${platform}-${arch}`];
  if (!archive) throw new Error('Unsupported DWS platform');
  const runtime = JSON.parse(await readFile(new URL(`../../kernels/${kernelId}/runtime.json`, import.meta.url), 'utf8'));
  const archiveBytes = await readFile(join(packageRoot, 'assets', archive));
  if (runtime.toolInputs?.dws?.version !== DWS_VERSION
    || createHash('sha256').update(archiveBytes).digest('hex') !== runtime.toolInputs.dws.archives[archive]) {
    throw new Error('DWS archive does not match the reviewed runtime inputs');
  }
  const destination = join(payload, 'tools', 'dws');
  if (await stat(destination).catch(() => undefined)) {
    const previous = JSON.parse(await readFile(join(destination, 'package.json'), 'utf8'));
    if (ifMissing && previous.name === metadata.name && previous.version === DWS_VERSION
      && (await stat(join(destination, platform === 'win32' ? 'dws.exe' : 'dws'))).isFile()) return destination;
    throw new Error('DWS payload already exists');
  }
  await mkdir(destination, { recursive: true });
  const binary = platform === 'win32' ? 'dws.exe' : 'dws';
  const allowed = new Set([binary, 'LICENSE', 'NOTICE', 'README.md']);
  const found = new Set();
  try {
    if (archive.endsWith('.zip')) {
      const zip = await JSZip.loadAsync(archiveBytes);
      for (const name of allowed) {
        const entry = zip.file(name);
        if (!entry) throw new Error(`Missing DWS payload ${name}`);
        const bytes = await entry.async('nodebuffer');
        if (bytes.byteLength > 64 * 1024 * 1024) throw new Error('DWS payload exceeds build limit');
        await writeFile(join(destination, name), bytes, { flag: 'wx', mode: 0o644 });
        found.add(name);
      }
    } else {
      await tar.x({
        file: join(packageRoot, 'assets', archive), cwd: destination, strict: true,
        filter(name, entry) {
          if (!allowed.has(name)) return false;
          if (entry.type !== 'File' || entry.size > 64 * 1024 * 1024 || found.has(name)) throw new Error('Invalid DWS archive entry');
          found.add(name);
          return true;
        },
      });
    }
    if ([...allowed].some(name => !found.has(name))) throw new Error('Incomplete DWS payload');
    if (platform !== 'win32') await chmod(join(destination, binary), 0o755);
    await writeFile(join(destination, 'package.json'), `${JSON.stringify({ name: metadata.name, version: DWS_VERSION, license: 'Apache-2.0' }, null, 2)}\n`, { flag: 'wx' });
    return destination;
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
  const platform = args.get('--platform') ?? process.platform;
  const arch = args.get('--arch') ?? process.arch;
  const destination = await materializeDws({
    packageRoot: resolve(args.get('--package-root') ?? 'node_modules/dingtalk-workspace-cli'),
    payload: resolve(args.get('--payload') ?? `build/host-tools/${platform}-${arch}`), platform, arch, ifMissing: args.get('--if-missing') === 'true',
    kernelId: args.get('--kernel') ?? 'openclaw',
  });
  process.stdout.write(`${JSON.stringify({ ok: true, destination, version: DWS_VERSION })}\n`);
}
