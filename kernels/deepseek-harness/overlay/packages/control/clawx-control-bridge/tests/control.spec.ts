import { describe, expect, it } from 'vitest'
import {
  CLAWX_DSH_CONTROL_PROTOCOL,
  ClawXDshControlBridge,
  assertMandatoryCapabilities,
  type ControlBridgeCapabilities,
} from '../src/index.ts'

const capabilities: ControlBridgeCapabilities = {
  chat: true,
  cancel: true,
  permissions: true,
  resume: true,
  configuration: true,
  agents: true,
  providers: true,
  skills: true,
  channels: false,
  cron: false,
  usage: true,
  checkpointCodecs: ['deepseek-harness-agent'],
}

describe('ClawX DSH control bridge', () => {
  it('negotiates exact identity and exposes no native conversation catalog', async () => {
    const bridge = new ClawXDshControlBridge({
      artifactVersion: '0.1.2-alpha.2+clawx.2',
      generation: 4,
      capabilities,
      capabilitiesDigest: 'digest',
    })
    expect(bridge.initialize({
      artifactVersion: '0.1.2-alpha.2+clawx.2',
      generation: 4,
      protocol: CLAWX_DSH_CONTROL_PROTOCOL,
      protocolVersion: 1,
      capabilitiesDigest: 'digest',
    })).toMatchObject({ kernelId: 'deepseek-harness', generation: 4 })
    await expect(bridge.dispatch('control.conversations.list', {})).rejects.toThrow(/DataService/)
    await expect(bridge.dispatch('control.agents.list', {})).resolves.toEqual([
      expect.objectContaining({ id: 'default', kernelId: 'deepseek-harness' }),
    ])
  })

  it('fails before ready when a mandatory capability or codec is missing', () => {
    expect(() => assertMandatoryCapabilities({ ...capabilities, permissions: false })).toThrow(/permissions/)
    expect(() => assertMandatoryCapabilities({ ...capabilities, checkpointCodecs: [] })).toThrow(/checkpoint codec/)
  })

  it('supports idempotent Agent upsert, per-kernel default, and removal control operations', async () => {
    const bridge = new ClawXDshControlBridge({
      artifactVersion: '0.1.2-alpha.2+clawx.5',
      generation: 4,
      capabilities,
    })
    const entity = { id: 'research', displayName: 'Research', workspaceUri: 'file:///tmp/research' }
    await expect(bridge.dispatch('control.agents.upsert', { entity, operationId: 'agent-put' }))
      .resolves.toMatchObject(entity)
    await expect(bridge.dispatch('control.agents.default.set', {
      agentId: 'research', operationId: 'agent-default',
    })).resolves.toBeUndefined()
    await expect(bridge.dispatch('control.agents.remove', {
      id: 'research', operationId: 'agent-remove',
    })).resolves.toBeUndefined()
    await expect(bridge.dispatch('control.agents.list', {})).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'research' })]),
    )
  })
})
