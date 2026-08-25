import { describe, expect, it, vi } from 'vitest'
import ClawXDshSkillCatalog from '../src/index.ts'

const skill = {
  id: 'shared-skill',
  slug: 'shared-skill',
  displayName: 'Shared Skill',
  description: 'Shared contract fixture',
  version: '1.0.0',
  revision: 3,
  source: { kind: 'marketplace', locator: '/canonical/shared-skill' },
  installedForKernels: ['openclaw', 'deepseek-harness'],
  enabledForKernels: ['deepseek-harness'],
  compatibility: [{ kernelId: 'deepseek-harness', compatible: true, mode: 'converted' as const }],
  enabled: true,
  instructionBody: 'Use the shared workflow.',
  createdAt: '2026-08-24T00:00:00.000Z',
  updatedAt: '2026-08-24T00:00:00.000Z',
}

describe('ClawX DSH Skill catalog', () => {
  it('registers converted instructions through ctx.skills and disposes updates', () => {
    const firstDispose = vi.fn()
    const secondDispose = vi.fn()
    const register = vi.fn().mockReturnValueOnce(firstDispose).mockReturnValueOnce(secondDispose)
    const catalog = new ClawXDshSkillCatalog({ skills: { register } } as never)
    catalog.upsert(skill, 'put-1')
    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      name: 'shared-skill',
      provider: 'clawx-canonical',
      content: 'Use the shared workflow.',
    }))
    catalog.upsert({ ...skill, revision: 4, instructionBody: 'Updated.' }, 'put-2')
    expect(firstDispose).toHaveBeenCalledOnce()
    catalog.remove(skill.id, 'remove-1')
    expect(secondDispose).toHaveBeenCalledOnce()
    expect(catalog.list()).toEqual([])
  })

  it('keeps disabled metadata out of the runtime registry and rejects rollback', () => {
    const register = vi.fn()
    const catalog = new ClawXDshSkillCatalog({ skills: { register } } as never)
    catalog.upsert({ ...skill, enabled: false }, 'put-1')
    expect(register).not.toHaveBeenCalled()
    expect(() => catalog.upsert({ ...skill, revision: 2 }, 'put-2')).toThrow(/rollback/)
    catalog.remove(skill.id, 'remove-1')
    catalog.remove(skill.id, 'remove-2')
  })

  it('rejects incompatible and invalid native projections', () => {
    const catalog = new ClawXDshSkillCatalog({ skills: { register: vi.fn() } } as never)
    expect(() => catalog.upsert({
      ...skill,
      compatibility: [{ kernelId: 'deepseek-harness', compatible: false, mode: 'unsupported' as const, reason: 'auxiliary files' }],
    }, 'put-1')).toThrow(/auxiliary files/)
    expect(() => catalog.upsert({ ...skill, slug: 'Bad_Name' }, 'put-2')).toThrow(/kebab-case/)
  })
})
