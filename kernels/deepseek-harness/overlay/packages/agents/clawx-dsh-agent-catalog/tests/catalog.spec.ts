import { describe, expect, it } from 'vitest'
import ClawXDshAgentCatalog from '../src/index.ts'

const agent = {
  id: 'shared',
  displayName: 'Shared Agent',
  workspaceUri: 'file:///tmp/shared-agent',
  persona: 'Be precise.',
  model: { providerAccountId: 'deepseek-main', providerId: 'deepseek', modelId: 'deepseek-v4-pro' },
  enabled: true,
  supportedKernels: ['openclaw', 'deepseek-harness'],
  version: 3,
  createdAt: '2026-08-24T00:00:00.000Z',
  updatedAt: '2026-08-24T00:00:00.000Z',
}

describe('ClawX DSH Agent catalog', () => {
  it('freezes a versioned workspace/model/persona composition per run', () => {
    const catalog = new ClawXDshAgentCatalog()
    catalog.upsert(agent, 'put-1')
    catalog.setDefault(agent.id, 'default-1')
    const composition = catalog.resolveForRun({ canonicalVersion: 3, workspaceUri: agent.workspaceUri })
    expect(composition).toMatchObject({ id: 'shared', version: 3, persona: 'Be precise.' })
    expect(Object.isFrozen(composition)).toBe(true)
    catalog.upsert({ ...agent, persona: 'Changed later.', version: 4 }, 'put-2')
    expect(composition.persona).toBe('Be precise.')
  })

  it('rejects stale snapshots, wrong workspaces and version rollback', () => {
    const catalog = new ClawXDshAgentCatalog()
    catalog.upsert(agent, 'put-1')
    expect(() => catalog.resolveForRun({ agentId: agent.id, canonicalVersion: 2 })).toThrow(/version mismatch/)
    expect(() => catalog.resolveForRun({ agentId: agent.id, workspaceUri: 'file:///tmp/other' })).toThrow(/workspace/)
    expect(() => catalog.upsert({ ...agent, version: 2 }, 'put-2')).toThrow(/rollback/)
  })

  it('keeps same native id isolated inside this kernel catalog', () => {
    const catalog = new ClawXDshAgentCatalog()
    catalog.upsert(agent, 'put-1')
    expect(catalog.list()).toHaveLength(1)
    catalog.remove(agent.id, 'remove-1')
    expect(catalog.list()).toEqual([])
  })
})
