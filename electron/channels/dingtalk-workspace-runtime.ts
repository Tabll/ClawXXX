import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

/** Resolve only a verified kernel payload, or the explicitly prepared dev tool. */
export async function resolveDwsExecutable(input: {
  location?: { packageDir: string; source: string };
  developmentRoot?: string;
  platform?: NodeJS.Platform;
  arch?: string;
}): Promise<string | undefined> {
  if (!input.location) return undefined;
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  const root = input.location.source === 'installed-artifact'
    ? join(input.location.packageDir, 'tools', 'dws')
    : input.developmentRoot ? join(input.developmentRoot, 'build', 'host-tools', `${platform}-${arch}`, 'tools', 'dws') : undefined;
  if (!root) return undefined;
  try {
    const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    if (metadata.name !== 'dingtalk-workspace-cli' || metadata.version !== '1.0.30') return undefined;
    const binary = await realpath(join(root, platform === 'win32' ? 'dws.exe' : 'dws'));
    const rel = relative(await realpath(root), binary);
    if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel) || !(await stat(binary)).isFile()) return undefined;
    return binary;
  } catch { return undefined; }
}
