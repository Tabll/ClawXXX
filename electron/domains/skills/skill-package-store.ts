import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

export const SKILL_PROJECTION_MARKER = '.clawx-canonical-projection.json';

export type CanonicalSkillPackage = {
  locator: string;
  digestSha256: string;
};

type PackageFile = {
  absolutePath: string;
  relativePath: string;
  mode: number;
};

type ProjectionMarker = {
  schemaVersion: 1;
  canonicalSkillId: string;
  digestSha256: string;
};

function safeSegment(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(normalized) || normalized === '.' || normalized === '..') {
    throw new Error(`${label} must be a safe filesystem segment`);
  }
  return normalized;
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..');
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function collectRegularFiles(root: string): Promise<PackageFile[]> {
  const resolvedRoot = resolve(root);
  const rootStat = await lstat(resolvedRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('Skill package root must be a real directory, not a symbolic link');
  }

  const result: PackageFile[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const itemStat = await lstat(absolutePath);
      if (itemStat.isSymbolicLink()) {
        throw new Error(`Skill packages cannot contain symbolic links: ${relative(resolvedRoot, absolutePath)}`);
      }
      if (itemStat.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!itemStat.isFile()) {
        throw new Error(`Skill packages can contain only regular files: ${relative(resolvedRoot, absolutePath)}`);
      }
      const relativePath = relative(resolvedRoot, absolutePath).split(sep).join('/');
      if (relativePath === SKILL_PROJECTION_MARKER) continue;
      result.push({ absolutePath, relativePath, mode: itemStat.mode & 0o777 });
    }
  };
  await visit(resolvedRoot);
  if (!result.some(file => file.relativePath === 'SKILL.md')) {
    throw new Error('Skill package must contain SKILL.md at its root');
  }
  return result.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function hashFiles(files: PackageFile[]): Promise<string> {
  const digest = createHash('sha256');
  for (const file of files) {
    const content = await readFile(file.absolutePath);
    digest.update(file.relativePath, 'utf8');
    digest.update('\0');
    digest.update(String(content.byteLength), 'utf8');
    digest.update('\0');
    digest.update(content);
    digest.update('\0');
  }
  return digest.digest('hex');
}

async function copyFiles(files: PackageFile[], destination: string): Promise<void> {
  for (const file of files) {
    const target = join(destination, ...file.relativePath.split('/'));
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, await readFile(file.absolutePath), { mode: file.mode || 0o600 });
    await chmod(target, file.mode || 0o600);
  }
}

async function readProjectionMarker(target: string): Promise<ProjectionMarker | undefined> {
  try {
    const parsed = JSON.parse(await readFile(join(target, SKILL_PROJECTION_MARKER), 'utf8')) as Partial<ProjectionMarker>;
    if (parsed.schemaVersion !== 1
      || typeof parsed.canonicalSkillId !== 'string'
      || !/^[a-f0-9]{64}$/.test(parsed.digestSha256 ?? '')) return undefined;
    return parsed as ProjectionMarker;
  } catch {
    return undefined;
  }
}

async function writeProjectionMarker(target: string, marker: ProjectionMarker): Promise<void> {
  await writeFile(
    join(target, SKILL_PROJECTION_MARKER),
    `${JSON.stringify(marker, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
}

/**
 * Owns immutable, kernel-neutral Skill packages. Kernel roots are projections
 * and are never accepted as durable locators after import.
 */
export class CanonicalSkillPackageStore {
  constructor(readonly root: string) {}

  async importPackage(canonicalSkillId: string, sourceRoot: string): Promise<CanonicalSkillPackage> {
    const id = safeSegment(canonicalSkillId, 'Canonical Skill id');
    const source = resolve(sourceRoot);
    const files = await collectRegularFiles(source);
    const digestSha256 = await hashFiles(files);
    const packageParent = join(resolve(this.root), id);
    const destination = join(packageParent, digestSha256);
    await mkdir(packageParent, { recursive: true, mode: 0o700 });

    if (await exists(destination)) {
      const existingDigest = await this.digestPackage(destination);
      if (existingDigest !== digestSha256) throw new Error('Canonical Skill package digest collision');
      return { locator: destination, digestSha256 };
    }

    const staging = join(packageParent, `.import-${process.pid}-${randomUUID()}`);
    await mkdir(staging, { recursive: false, mode: 0o700 });
    try {
      await copyFiles(files, staging);
      try {
        await rename(staging, destination);
      } catch (error) {
        if (!await exists(destination)) throw error;
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    return { locator: destination, digestSha256 };
  }

  async digestPackage(packageRoot: string): Promise<string> {
    return hashFiles(await collectRegularFiles(packageRoot));
  }

  async readInstructions(packageRoot: string): Promise<string> {
    await collectRegularFiles(packageRoot);
    return readFile(join(resolve(packageRoot), 'SKILL.md'), 'utf8');
  }

  async listPackageFiles(packageRoot: string): Promise<string[]> {
    return (await collectRegularFiles(packageRoot)).map(file => file.relativePath);
  }

  /**
   * Atomically materializes a physical copy in a kernel-owned root. An
   * existing unowned directory is adopted only when its digest is identical;
   * otherwise it is preserved and the projection fails closed.
   */
  async projectPackage(input: {
    canonicalSkillId: string;
    slug: string;
    packageRoot: string;
    kernelRoot: string;
  }): Promise<string> {
    const id = safeSegment(input.canonicalSkillId, 'Canonical Skill id');
    const slug = safeSegment(input.slug, 'Skill slug');
    const source = resolve(input.packageRoot);
    const kernelRoot = resolve(input.kernelRoot);
    if (isWithin(source, kernelRoot) || isWithin(kernelRoot, source)) {
      throw new Error('Canonical and kernel Skill roots must be isolated');
    }
    const files = await collectRegularFiles(source);
    const digestSha256 = await hashFiles(files);
    await mkdir(kernelRoot, { recursive: true, mode: 0o700 });
    const target = join(kernelRoot, slug);

    if (await exists(target)) {
      const targetStat = await lstat(target);
      if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
        throw new Error(`Kernel Skill projection is not a real directory: ${slug}`);
      }
      const marker = await readProjectionMarker(target);
      const existingDigest = await this.digestPackage(target);
      if (!marker && existingDigest === digestSha256) {
        await writeProjectionMarker(target, { schemaVersion: 1, canonicalSkillId: id, digestSha256 });
        return target;
      }
      if (!marker || marker.canonicalSkillId !== id) {
        throw new Error(`Refusing to replace unowned kernel Skill directory: ${slug}`);
      }
    }

    const staging = join(kernelRoot, `.project-${slug}-${process.pid}-${randomUUID()}`);
    await mkdir(staging, { recursive: false, mode: 0o700 });
    try {
      await copyFiles(files, staging);
      await writeProjectionMarker(staging, { schemaVersion: 1, canonicalSkillId: id, digestSha256 });
      if (await exists(target)) await rm(target, { recursive: true, force: true });
      await rename(staging, target);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    return target;
  }

  /** Removes only a ClawX-owned physical projection; user directories survive. */
  async removeProjection(kernelRoot: string, slug: string, canonicalSkillId?: string): Promise<boolean> {
    const safeSlug = safeSegment(slug, 'Skill slug');
    const target = join(resolve(kernelRoot), safeSlug);
    if (!await exists(target)) return false;
    const targetStat = await lstat(target);
    if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
      throw new Error(`Refusing to remove non-directory Skill projection: ${safeSlug}`);
    }
    const marker = await readProjectionMarker(target);
    if (!marker) return false;
    if (canonicalSkillId && marker.canonicalSkillId !== safeSegment(canonicalSkillId, 'Canonical Skill id')) {
      throw new Error(`Skill projection ownership mismatch: ${safeSlug}`);
    }
    await rm(target, { recursive: true, force: true });
    return true;
  }
}

/** Regression guard used by startup validation and tests. */
export async function assertIndependentSkillRoots(firstRoot: string, secondRoot: string): Promise<void> {
  const first = resolve(firstRoot);
  const second = resolve(secondRoot);
  if (first === second || isWithin(first, second) || isWithin(second, first)) {
    throw new Error('Kernel Skill roots must be independent directories');
  }
  for (const root of [first, second]) {
    if (!await exists(root)) continue;
    const rootStat = await lstat(root);
    if (rootStat.isSymbolicLink()) throw new Error(`Kernel Skill root cannot be a symbolic link: ${basename(root)}`);
  }
  if (await exists(first) && await exists(second) && await realpath(first) === await realpath(second)) {
    throw new Error('Kernel Skill roots resolve to the same directory');
  }
}
