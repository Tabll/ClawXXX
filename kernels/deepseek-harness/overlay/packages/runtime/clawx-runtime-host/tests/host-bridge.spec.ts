import { describe, expect, it } from 'vitest'
import { ClawXRuntimeHostBridge } from '../src/host-bridge.js'

describe('ClawXRuntimeHostBridge', () => {
  it('rejects every pending and future credential request when the bridge disconnects', async () => {
    const output: unknown[] = []
    const bridge = new ClawXRuntimeHostBridge(
      { kernelId: 'deepseek-harness', generation: 4 },
      message => output.push(message),
      5_000,
    )
    const pending = bridge.request('credential.resolve', {
      accountId: 'deepseek-primary',
      purpose: 'model-request',
    })
    expect(output).toEqual([expect.objectContaining({
      type: 'host-request',
      kernelId: 'deepseek-harness',
      generation: 4,
      method: 'credential.resolve',
    })])

    bridge.close()
    await expect(pending).rejects.toThrow('disconnected')
    await expect(bridge.request('credential.resolve')).rejects.toThrow('disconnected')
  })

  it('rejects cross-generation and replayed host responses', async () => {
    const output: Array<Record<string, unknown>> = []
    const bridge = new ClawXRuntimeHostBridge(
      { kernelId: 'deepseek-harness', generation: 4 },
      message => output.push(message as Record<string, unknown>),
    )
    const pending = bridge.request('credential.resolve')
    const requestId = String(output[0]?.requestId)
    expect(() => bridge.accept({
      protocol: 'clawx.kernel-stdio/v1',
      type: 'host-response',
      requestId,
      kernelId: 'deepseek-harness',
      generation: 5,
      ok: true,
      result: { value: 'must-not-be-accepted' },
    })).toThrow('cross-generation')
    bridge.close()
    await expect(pending).rejects.toThrow('disconnected')
  })
})
