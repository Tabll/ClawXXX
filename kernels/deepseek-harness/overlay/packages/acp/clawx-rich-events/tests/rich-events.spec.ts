import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeBridgeHarness, textResponse, type BridgeHarness } from '../../acp/tests/harness.ts'
import * as RichEvents from '../src/index.ts'

function richToolResponse(): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'inspect first' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'inspect first' } },
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 1, id: ToolCallId('call-rich'), name: 'echo', argumentsDelta: '{"text":"ping"}' },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id: ToolCallId('call-rich'), name: 'echo', arguments: '{"text":"ping"}' } },
    { type: 'usage', usage: { inputTokens: 7, outputTokens: 4, cacheReadTokens: 2 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

describe('ClawX DSH rich event projection', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  it('projects reasoning, tools and usage from a real DSH AgentLoop prompt', async () => {
    harness = await makeBridgeHarness({ script: [richToolResponse(), textResponse('done')] })
    const rich: unknown[] = []
    await harness.ctx.plugin(RichEvents, {
      sink: { sessionUpdate: (_sessionId, update) => { rich.push(update); return Promise.resolve() } },
      contextWindow: 32_768,
    })
    harness.ctx.tools.register(defineContentToolFixture({
      name: 'echo',
      description: 'Return deterministic content.',
      parameters: { text: { type: 'string' } },
      execute: args => Promise.resolve([{ type: 'text', text: `echo:${String(args.text)}` }]),
    }))
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'use the tool' }] })
    await vi.waitFor(() => {
      expect(rich.some(update => (update as { sessionUpdate?: string }).sessionUpdate === 'usage_update')).toBe(true)
    })

    expect(rich).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'inspect first' },
      }),
      expect.objectContaining({
        sessionUpdate: 'tool_call',
        toolCallId: 'call-rich',
        rawInput: { text: 'ping' },
        status: 'in_progress',
      }),
      expect.objectContaining({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-rich',
        status: 'completed',
      }),
      expect.objectContaining({
        sessionUpdate: 'usage_update',
        size: 32_768,
      }),
    ]))
    const usage = rich.find(update => (
      (update as { sessionUpdate?: string }).sessionUpdate === 'usage_update'
    )) as { _meta?: { clawx?: Record<string, unknown> } } | undefined
    expect(usage?._meta?.clawx).toMatchObject({
      inputTokens: 7,
      outputTokens: 4,
      cacheReadTokens: 2,
      source: 'runtime-event',
    })
    expect(usage?._meta?.clawx).not.toHaveProperty('cacheWriteTokens')
    expect(harness.updates).toContainEqual(expect.objectContaining({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'done' },
    }))
  })

  it('keeps private reasoning explicitly marked non-portable', () => {
    const updates = RichEvents.projectSessionEvent({
      type: 'assistant/chunk',
      seq: 4,
      time: Date.now(),
      data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'private' } },
    })
    expect(updates[0]).toMatchObject({
      sessionUpdate: 'agent_thought_chunk',
      _meta: { clawx: { visibility: 'private' } },
    })
  })
})
