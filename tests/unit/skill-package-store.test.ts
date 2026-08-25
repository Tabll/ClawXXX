import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertIndependentSkillRoots } from '../../electron/domains/skills/skill-package-store';

const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('kernel Skill root isolation', () => {
  it('allows distinct real directories reached through a symlinked ancestor', async () => {
    if (process.platform === 'win32') return;
    const tempRoot = await mkdtemp(join(tmpdir(), 'clawx-skill-roots-'));
    cleanupRoots.push(tempRoot);
    const realParent = join(tempRoot, 'real-parent');
    const linkedParent = join(tempRoot, 'linked-parent');
    await mkdir(join(realParent, 'openclaw'), { recursive: true });
    await mkdir(join(realParent, 'deepseek-harness'), { recursive: true });
    await symlink(realParent, linkedParent, 'dir');

    await expect(assertIndependentSkillRoots(
      join(linkedParent, 'openclaw'),
      join(linkedParent, 'deepseek-harness'),
    )).resolves.toBeUndefined();
  });

  it('rejects a Skill root that is itself a symbolic link', async () => {
    if (process.platform === 'win32') return;
    const tempRoot = await mkdtemp(join(tmpdir(), 'clawx-skill-roots-'));
    cleanupRoots.push(tempRoot);
    const realRoot = join(tempRoot, 'real-root');
    const linkedRoot = join(tempRoot, 'linked-root');
    const otherRoot = join(tempRoot, 'other-root');
    await mkdir(realRoot, { recursive: true });
    await mkdir(otherRoot, { recursive: true });
    await symlink(realRoot, linkedRoot, 'dir');

    await expect(assertIndependentSkillRoots(linkedRoot, otherRoot))
      .rejects.toThrow('Kernel Skill root cannot be a symbolic link');
  });
});
