import { randomUUID } from 'node:crypto';
import { dirname, relative, resolve, sep } from 'node:path';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';

const MAX_AUTH_BUNDLE_BYTES = 16 * 1024 * 1024;
const MAX_AUTH_BUNDLE_FILES = 10_000;
const MAX_SERIALIZED_AUTH_BUNDLE_BYTES = 24 * 1024 * 1024;
export type ChannelAuthBundle = { version: 1; files: Array<{ path: string; dataBase64: string }> };

/** Serialize a connector auth projection so safeStorage remains authoritative. */
export async function captureChannelAuthBundle(rootPath: string): Promise<string> {
  const root = resolve(rootPath);
  const files: ChannelAuthBundle['files'] = [];
  let total = 0;
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && directory === root) return [];
      throw error;
    });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      assertInside(root, path);
      if (entry.isSymbolicLink()) throw new Error('Channel auth bundle cannot contain links');
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        if (files.length >= MAX_AUTH_BUNDLE_FILES) throw new Error('Channel auth bundle contains too many files');
        const data = await readFile(path);
        total += data.byteLength;
        if (total > MAX_AUTH_BUNDLE_BYTES) throw new Error('Channel auth bundle exceeds its secure storage limit');
        files.push({ path: relative(root, path).replace(/\\/g, '/'), dataBase64: data.toString('base64') });
      }
    }
  };
  await visit(root);
  return JSON.stringify({ version: 1, files } satisfies ChannelAuthBundle);
}

/** Atomically replace a disposable auth projection from the canonical bundle. */
export async function restoreChannelAuthBundle(rootPath: string, serialized: string): Promise<void> {
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SERIALIZED_AUTH_BUNDLE_BYTES) {
    throw new Error('Channel auth bundle exceeds its serialized limit');
  }
  const parsed = JSON.parse(serialized) as ChannelAuthBundle;
  if (!parsed || typeof parsed !== 'object' || parsed.version !== 1 || !Array.isArray(parsed.files)) {
    throw new Error('Channel auth bundle is invalid');
  }
  if (parsed.files.length > MAX_AUTH_BUNDLE_FILES) throw new Error('Channel auth bundle contains too many files');
  const root = resolve(rootPath);
  const operationId = randomUUID();
  const staging = `${root}.clawx-staging-${operationId}`;
  const backup = `${root}.clawx-backup-${operationId}`;
  let total = 0;
  let preserveBackup = false;
  const seenPaths = new Set<string>();
  try {
    for (const file of parsed.files) {
      if (!file || typeof file.path !== 'string' || typeof file.dataBase64 !== 'string') {
        throw new Error('Channel auth bundle entry is invalid');
      }
      const normalized = normalizeBundlePath(file.path);
      const collisionKey = normalized.toLocaleLowerCase('en-US');
      if (seenPaths.has(collisionKey)) throw new Error('Channel auth bundle contains duplicate paths');
      seenPaths.add(collisionKey);
      if (!isCanonicalBase64(file.dataBase64)) throw new Error('Channel auth bundle entry has invalid base64 data');
      const target = resolve(staging, normalized);
      assertInside(staging, target);
      const data = Buffer.from(file.dataBase64, 'base64');
      total += data.byteLength;
      if (total > MAX_AUTH_BUNDLE_BYTES) throw new Error('Channel auth bundle exceeds its secure storage limit');
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, data, { mode: 0o600, flag: 'wx' });
    }
    await mkdir(staging, { recursive: true, mode: 0o700 });
    const hadPrevious = await rename(root, backup).then(() => true).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    });
    try {
      await rename(staging, root);
    } catch (error) {
      if (hadPrevious) {
        try {
          await rename(backup, root);
        } catch (rollbackError) {
          preserveBackup = true;
          throw new AggregateError(
            [error, rollbackError],
            `Channel auth projection rollback failed; backup preserved at ${backup}`,
            { cause: rollbackError },
          );
        }
      }
      throw error;
    }
    if (hadPrevious) await rm(backup, { recursive: true, force: true });
  } finally {
    await rm(staging, { recursive: true, force: true });
    if (!preserveBackup) await rm(backup, { recursive: true, force: true });
  }
}

export function safeChannelProjectionPath(basePath: string, accountId: string): string {
  const base = resolve(basePath);
  const target = resolve(base, encodeURIComponent(accountId));
  assertInside(base, target);
  return target;
}

function assertInside(rootPath: string, targetPath: string): void {
  const root = resolve(rootPath);
  const target = resolve(targetPath);
  const rel = relative(root, target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error('Channel auth bundle path escapes its account projection');
  }
}

function normalizeBundlePath(value: string): string {
  if (!value || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    throw new Error('Channel auth bundle path is invalid');
  }
  const segments = value.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes('\0'))) {
    throw new Error('Channel auth bundle path is invalid');
  }
  return segments.join('/');
}

function isCanonicalBase64(value: string): boolean {
  if (value === '') return true;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  return Buffer.from(value, 'base64').toString('base64') === value;
}
