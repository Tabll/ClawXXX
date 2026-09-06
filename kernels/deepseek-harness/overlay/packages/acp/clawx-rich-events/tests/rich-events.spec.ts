import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, LlmAdapter, LlmAttemptId, ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as RichEvents from '../src/index.ts'

function richToolResponse(): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'inspect first' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'inspect first' } },
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 1, id: ToolCallId('call-rich'), name: 'echo', argumentsDelta: '{"text":"ping"}' },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id: ToolCallId('call-rich'), name: 'echo', arguments: '{"text":"ping"}' } },
    { type: 'usage', usage: { inputTokens: 7, outputTokens: 4, cacheReadTokens: 2, totalTokens: 13 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

class ScriptedAdapter extends LlmAdapter {
  private readonly scripts: StreamChunk[][] = [richToolResponse(), [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'done' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]]
  override providerInfo() { return { id: 'mock', name: 'Mock' } }
  override listModels() { return Promise.resolve([{ provider: 'mock', id: 'mock', name: 'Mock' }]) }
  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text'] as const })
  }
  async * stream(): AsyncIterable<StreamChunk> {
    const script = this.scripts.shift()
    if (!script) throw new Error('script exhausted')
    yield* script
  }
}

describe('ClawX DSH v2 rich event projection', () => {
  let ctx: Context | undefined
  afterEach(async () => { await ctx?.fiber.dispose(); ctx = undefined })

  it('projects live text once, tools and settled usage through a real AgentLoop', async () => {
    ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter())
    const rich: unknown[] = []
    await ctx.plugin(RichEvents, {
      sink: { sessionUpdate: (_id, update) => { rich.push(update); return Promise.resolve() } },
      contextWindow: 32_768,
    })
    ctx.tools.register(defineContentToolFixture({
      name: 'echo', description: 'Return deterministic content.',
      parameters: { text: { type: 'string' } },
      execute: args => Promise.resolve([{ type: 'text', text: 'echo:' + String(args.text) }]),
    }))
    const handle = await ctx.agents.create({
      sessionId: SessionId('rich'), agentOptions: { provider: 'mock', model: 'mock' },
    })
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'use the tool' }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()
    await vi.waitFor(() => expect(rich).toContainEqual(expect.objectContaining({
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' },
    })))
    expect(rich).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'inspect first' } }),
      expect.objectContaining({ sessionUpdate: 'tool_call', toolCallId: 'call-rich', rawInput: { text: 'ping' }, status: 'in_progress' }),
      expect.objectContaining({ sessionUpdate: 'tool_call_update', toolCallId: 'call-rich', status: 'completed' }),
      expect.objectContaining({
        sessionUpdate: 'usage_update', size: 32_768,
        _meta: { clawx: expect.objectContaining({ inputTokens: 7, outputTokens: 4, cacheReadTokens: 2, totalTokens: 13, source: 'runtime-event' }) },
      }),
    ]))
    expect(rich.filter(update => (update as { sessionUpdate: string }).sessionUpdate === 'agent_message_chunk')).toHaveLength(1)
    expect(rich.filter(update => (update as { sessionUpdate: string }).sessionUpdate === 'usage_update')).toHaveLength(1)
    await handle.dispose()
  })

  it('keeps transient reasoning private and ignores live usage to avoid duplicate billing', () => {
    const frame = { type: 'chunk' as const, attemptId: LlmAttemptId('attempt'), revision: 2, index: 0, time: 1 }
    expect(RichEvents.projectAssistantStreamFrame({
      ...frame, chunk: { type: 'reasoning-delta', index: 0, text: 'private' },
    })[0]).toMatchObject({ sessionUpdate: 'agent_thought_chunk', _meta: { clawx: { visibility: 'private' } } })
    expect(RichEvents.projectAssistantStreamFrame({
      ...frame, chunk: { type: 'usage', usage: { inputTokens: 4, outputTokens: 2 } },
    })).toEqual([])
  })

  it('counts only the final reported usage snapshot of a failed attempt', () => {
    const updates = RichEvents.projectSessionEvent({
      type: 'assistant/attempt', seq: SessionSeq(12), time: 3,
      data: { turn: 1, step: 1, stream: [
        { type: 'chunk', time: 1, chunk: { type: 'usage', usage: { inputTokens: 4, outputTokens: 1 } } },
        { type: 'chunk', time: 2, chunk: { type: 'usage', usage: { inputTokens: 4, outputTokens: 2 } } },
      ] },
    })
    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({ _meta: { clawx: { eventSeq: 12, inputTokens: 4, outputTokens: 2 } } })
    expect(updates[0]?._meta?.clawx).not.toHaveProperty('cacheWriteTokens')
  })
})
