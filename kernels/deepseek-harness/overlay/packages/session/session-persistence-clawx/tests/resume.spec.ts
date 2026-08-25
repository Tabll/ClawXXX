import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import * as CheckpointPolicy from '@deepseek-ai/dsh-session-checkpoint-policy'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import ClawXSessionPersistence from '../src/index.ts'
import { MemoryClawXClient } from './memory-client.ts'

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly answers: string[]) {
    super()
  }

  override providerInfo(provider: string) {
    if (provider !== 'mock') throw new Error(`unknown provider ${provider}`)
    return { id: provider, name: provider }
  }

  override listModels(provider: string) {
    return Promise.resolve(provider === 'mock'
      ? ['one', 'two'].map(id => ({ provider, id, name: id, inputModalities: ['text'] as const }))
      : [])
  }

  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text'] as const })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const text = this.answers.shift()
    if (text === undefined) throw new Error('script exhausted')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 5, outputTokens: text.length } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function runtime(client: MemoryClawXClient, answers: string[]) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(ClawXSessionPersistence, { client, writeBatchMaxDelayMs: 1 })
  await ctx.plugin(CheckpointPolicy)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new ScriptedAdapter(answers)
  ctx.llm.registerAdapter(['mock'], adapter)
  return { ctx, adapter }
}

describe('ClawX DSH persistence resume', () => {
  const contexts: Context[] = []
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('resumes a cold Agent from the RPC store and applies live model configuration', async () => {
    const client = new MemoryClawXClient()
    const id = SessionId('clawx-resume-session')
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'clawx-dsh-runtime-'))
    roots.push(runtimeRoot)

    const first = await runtime(client, ['first answer'])
    contexts.push(first.ctx)
    const firstSelection: ModelSelectionRef = {
      current: { provider: 'mock', model: 'one' },
      assembled: undefined,
    }
    const firstHandle = await first.ctx.agents.create({
      sessionId: id,
      meta: { cwd: runtimeRoot },
      agentOptions: { provider: 'mock', model: 'one' },
      setup: agentCtx => { installModelSelection(agentCtx, firstSelection) },
    })
    firstHandle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'first prompt' }],
      source: { kind: 'user' },
    }))
    await firstHandle.agent.whenIdle()
    await first.ctx.sessions.flush(firstHandle.agent.session)
    await firstHandle.dispose()
    await first.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(first.ctx), 1)

    const second = await runtime(client, ['second answer'])
    contexts.push(second.ctx)
    const secondSelection: ModelSelectionRef = {
      current: { provider: 'mock', model: 'one' },
      assembled: undefined,
    }
    const resumed = await second.ctx.agents.resume({
      resumeSessionId: id,
      agentOptions: { provider: 'mock', model: 'one' },
      setup: agentCtx => { installModelSelection(agentCtx, secondSelection) },
    })
    expect(JSON.stringify(resumed.agent.session.deriveMessages())).toContain('first answer')

    secondSelection.current = { provider: 'mock', model: 'two' }
    resumed.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'second prompt' }],
      source: { kind: 'user' },
    }))
    await resumed.agent.whenIdle()
    await second.ctx.sessions.flush(resumed.agent.session)

    expect(second.adapter.requests[0]?.model).toBe('two')
    const stored = await client.load(id)
    expect(JSON.stringify(stored?.events)).toContain('first answer')
    expect(JSON.stringify(stored?.events)).toContain('second answer')
    expect(stored?.events.some(event => event.type === 'assistant/message' && event.data.usage !== undefined)).toBe(true)
    const durableHistoryFiles = readdirSync(runtimeRoot, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => entry.name)
      .filter(name => name === 'sessions.json' || name.endsWith('.jsonl') || name.endsWith('.trajectory-path.json'))
    expect(durableHistoryFiles).toEqual([])
  })
})
