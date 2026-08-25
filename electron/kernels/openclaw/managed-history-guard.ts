import { readdir, rm } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import type { OpenClawRuntimeLocation } from './runtime-location';

const FORBIDDEN_FILE_PATTERNS = [
  /(^|\/)sessions\.json$/i,
  /(^|\/)sessions\/[^/]+\.jsonl$/i,
  /\.deleted(?:\.[^/]+)?\.jsonl$/i,
  /\.jsonl\.reset\./i,
  /\.trajectory\.jsonl$/i,
  /\.trajectory-path\.json$/i,
  /(^|\/)cron\/runs(?:\/|\.|$)/i,
  /(^|\/)cron\/history(?:\/|\.|$)/i,
  /(^|\/)usage(?:-cache|-history)?\.(?:json|jsonl|sqlite)$/i,
  /(^|\/)transcript(?:s)?(?:\/|\.|$)/i,
];

function isInside(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`));
}

export function isForbiddenOpenClawHistoryPath(relativePath: string): boolean {
  const normalized = relativePath.split(sep).join('/');
  return FORBIDDEN_FILE_PATTERNS.some(pattern => pattern.test(normalized));
}

export async function listForbiddenOpenClawHistory(
  location: Pick<OpenClawRuntimeLocation, 'configRoot' | 'cacheRoot'>,
): Promise<string[]> {
  const forbidden: string[] = [];
  for (const root of [location.configRoot, location.cacheRoot]) {
    const walk = async (directory: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const path = resolve(directory, entry.name);
        if (!isInside(path, root)) throw new Error('Managed history scan escaped its root');
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile() && isForbiddenOpenClawHistoryPath(relative(root, path))) forbidden.push(path);
      }
    };
    await walk(root);
  }
  return forbidden.sort();
}

export async function purgeForbiddenOpenClawHistory(
  location: Pick<OpenClawRuntimeLocation, 'configRoot' | 'cacheRoot'>,
): Promise<string[]> {
  const forbidden = await listForbiddenOpenClawHistory(location);
  for (const path of forbidden) {
    if (!isInside(path, location.configRoot) && !isInside(path, location.cacheRoot)) {
      throw new Error(`Refusing to remove OpenClaw history outside managed roots: ${path}`);
    }
    await rm(path, { force: true });
  }
  return forbidden;
}

export async function assertNoForbiddenOpenClawHistory(
  location: Pick<OpenClawRuntimeLocation, 'configRoot' | 'cacheRoot'>,
): Promise<void> {
  const forbidden = await listForbiddenOpenClawHistory(location);
  if (forbidden.length > 0) {
    throw new Error(`Managed OpenClaw created forbidden durable history: ${forbidden.join(', ')}`);
  }
}
