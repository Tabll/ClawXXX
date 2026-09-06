import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function readOverlay(path: string): string {
  return readFileSync(join(root, 'kernels', 'deepseek-harness', 'overlay', path), 'utf8');
}

describe('DeepSeek Harness canonical Skill runtime overlay', () => {
  it('scans only its managed Skill root and never follows Skill symlinks', () => {
    const runtimeHost = readOverlay('packages/runtime/clawx-runtime-host/src/index.ts');
    const composition = readOverlay('packages/runtime/clawx-runtime-host/src/composition.ts');

    expect(runtimeHost).toContain("mkdir(join(config.dataDir, 'skills'), { recursive: true, mode: 0o700 })");
    expect(runtimeHost).toContain('await ctx.plugin(ClawXAgentServices');
    expect(composition).toContain('includeDefaultRoots: false');
    expect(composition).toContain("customSkillDirs: [join(config.dataDir, 'skills')]");
    expect(composition).toContain('watchFollowSymlinks: false');
    expect(runtimeHost).toContain("skillRootPolicy: 'isolated-no-symlink-follow'");
  });

  it('registers enabled canonical instructions through ctx.skills without owning durable metadata', () => {
    const catalog = readOverlay('packages/skills/clawx-dsh-skill-catalog/src/index.ts');

    expect(catalog).toContain('this.ctx.skills.register({');
    expect(catalog).toContain("provider: 'clawx-canonical'");
    expect(catalog).toContain('canonicalRevision: entity.revision');
    expect(catalog).toContain('Process-local only; ClawX SQLite remains the sole metadata authority.');
    expect(catalog).not.toMatch(/writeFile|appendFile|createWriteStream/);
  });
});
