// @vitest-environment node

import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClawXDataService, type ClawXDataClient } from '@electron/data/clawx-data-service';
import {
  SkillProjectionReconciler,
  projectionResultsToMutation,
  type SkillKernelProjectionAdapter,
} from '@electron/domains/skills/skill-projection-reconciler';
import { CanonicalSkillService } from '@electron/domains/skills/skill-service';
import {
  CanonicalSkillPackageStore,
  SKILL_PROJECTION_MARKER,
  assertIndependentSkillRoots,
} from '@electron/domains/skills/skill-package-store';

function callClient(client: ClawXDataClient) {
  return {
    call<T>(method: string, ...args: unknown[]): Promise<T> {
      const operation = (client as unknown as Record<string, unknown>)[method];
      if (typeof operation !== 'function') return Promise.reject(new Error(`Unknown DataService method: ${method}`));
      return Reflect.apply(operation, client, args) as Promise<T>;
    },
  };
}

function makeSkill(root: string, slug: string, auxiliary = false): string {
  const directory = join(root, slug);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'SKILL.md'), `---\nname: ${slug}\ndescription: Contract fixture\n---\n\nUse the ${slug} workflow.\n`);
  if (auxiliary) {
    mkdirSync(join(directory, 'scripts'));
    writeFileSync(join(directory, 'scripts', 'run.sh'), '#!/bin/sh\n');
  }
  return directory;
}

describe('canonical multi-kernel Skills domain', () => {
  it('stores one canonical package and reconciles each kernel independently with retry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-skills-contract-'));
    const dataService = new ClawXDataService(join(root, 'state', 'clawx.sqlite'));
    const main = dataService.connect({ role: 'main' });
    const packages = new CanonicalSkillPackageStore(join(root, 'state', 'skill-packages'));
    const service = new CanonicalSkillService(callClient(main), packages, () => new Date('2026-08-24T00:00:00.000Z'));
    let deepSeekFails = true;
    const adapters: SkillKernelProjectionAdapter[] = [
      {
        kernelId: 'openclaw',
        available: () => true,
        upsert: async skill => ({ nativeId: `oc-${skill.slug}`, partial: true }),
        remove: async () => undefined,
      },
      {
        kernelId: 'deepseek-harness',
        available: () => true,
        upsert: async skill => {
          if (deepSeekFails) throw new Error('DSH bridge unavailable');
          expect(skill.instructionBody).toBe('Use the shared-skill workflow.');
          return { nativeId: `dsh-${skill.slug}` };
        },
        remove: async () => undefined,
      },
    ];
    const reconciler = new SkillProjectionReconciler(callClient(main), packages, adapters);
    try {
      const source = makeSkill(root, 'shared-skill');
      const imported = await service.importLocalSkill({
        id: 'shared-skill',
        slug: 'shared-skill',
        name: 'Shared Skill',
        description: 'Contract fixture',
        enabled: true,
        baseDir: source,
      }, { installedForKernels: ['openclaw', 'deepseek-harness'], enabledForKernels: ['openclaw', 'deepseek-harness'] });

      expect(imported.source.locator).toContain(join('state', 'skill-packages'));
      expect(imported.source.locator).not.toBe(source);
      const first = await reconciler.reconcileSkill(imported.id);
      expect(projectionResultsToMutation(imported.id, first)).toEqual({
        skillId: imported.id,
        results: [
          expect.objectContaining({ kernelId: 'openclaw', ok: false, error: expect.objectContaining({ code: 'SKILL_PARTIAL' }) }),
          expect.objectContaining({ kernelId: 'deepseek-harness', ok: false, error: expect.objectContaining({ code: 'SKILL_PROJECTION_FAILED' }) }),
        ],
      });
      expect((await service.get(imported.id))?.projections.map(value => [value.kernelId, value.state])).toEqual([
        ['deepseek-harness', 'failed'],
        ['openclaw', 'partial'],
      ]);

      deepSeekFails = false;
      expect(await reconciler.reconcileSkill(imported.id, ['deepseek-harness'])).toEqual([
        expect.objectContaining({ kernelId: 'deepseek-harness', status: 'ready' }),
      ]);
      expect((await service.get(imported.id))?.projections.map(value => [value.kernelId, value.state])).toEqual([
        ['deepseek-harness', 'ready'],
        ['openclaw', 'partial'],
      ]);
    } finally {
      await dataService.close();
    }
  });

  it('records an explicit DSH incompatibility for auxiliary packages while keeping OpenClaw native', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-skills-compat-'));
    const dataService = new ClawXDataService(join(root, 'clawx.sqlite'));
    const main = dataService.connect({ role: 'main' });
    const packages = new CanonicalSkillPackageStore(join(root, 'packages'));
    const service = new CanonicalSkillService(callClient(main), packages);
    const dshUpserts: string[] = [];
    const reconciler = new SkillProjectionReconciler(callClient(main), packages, [{
      kernelId: 'deepseek-harness',
      available: () => true,
      upsert: async skill => { dshUpserts.push(skill.id); return {}; },
      remove: async () => undefined,
    }]);
    try {
      const skill = await service.importLocalSkill({
        id: 'scripted-skill',
        name: 'Scripted Skill',
        description: 'Uses auxiliary content',
        enabled: true,
        baseDir: makeSkill(root, 'scripted-skill', true),
      }, { installedForKernels: ['deepseek-harness'], enabledForKernels: ['deepseek-harness'] });
      expect(skill.compatibility).toEqual([
        expect.objectContaining({ kernelId: 'openclaw', compatible: true, mode: 'native' }),
        expect.objectContaining({
          kernelId: 'deepseek-harness',
          compatible: false,
          mode: 'unsupported',
          reason: expect.stringContaining('auxiliary files'),
        }),
      ]);
      expect(await reconciler.reconcileSkill(skill.id)).toEqual([
        expect.objectContaining({ status: 'unsupported', error: expect.objectContaining({ retryable: false }) }),
      ]);
      expect(dshUpserts).toEqual([]);
    } finally {
      await dataService.close();
    }
  });

  it('uses physical copies, refuses cross-root links, and never removes an unowned directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-skills-roots-'));
    const source = makeSkill(root, 'isolated-skill');
    const packages = new CanonicalSkillPackageStore(join(root, 'canonical'));
    const imported = await packages.importPackage('isolated-skill', source);
    const openClawRoot = join(root, 'openclaw-skills');
    const dshRoot = join(root, 'dsh-skills');
    await assertIndependentSkillRoots(openClawRoot, dshRoot);
    const projected = await packages.projectPackage({
      canonicalSkillId: 'isolated-skill',
      slug: 'isolated-skill',
      packageRoot: imported.locator,
      kernelRoot: openClawRoot,
    });
    expect(lstatSync(projected).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(projected, 'SKILL.md')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(projected, SKILL_PROJECTION_MARKER), 'utf8')).toContain('isolated-skill');

    const unowned = makeSkill(dshRoot, 'unowned');
    expect(await packages.removeProjection(dshRoot, 'unowned')).toBe(false);
    expect(readFileSync(join(unowned, 'SKILL.md'), 'utf8')).toContain('unowned');

    const linkedRoot = join(root, 'linked-skills');
    symlinkSync(openClawRoot, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(assertIndependentSkillRoots(linkedRoot, dshRoot)).rejects.toThrow(/symbolic link|resolves outside/);

    const linkedPackage = join(root, 'linked-package');
    mkdirSync(linkedPackage);
    writeFileSync(join(linkedPackage, 'SKILL.md'), '# Linked package\n');
    symlinkSync(source, join(linkedPackage, 'foreign'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(packages.importPackage('linked-package', linkedPackage)).rejects.toThrow(/symbolic links/);
  });
});
