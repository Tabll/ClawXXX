import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { type GenerateOptions, LlmAdapter, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { ClawXDshAcpBridge, type ClawXDshKernelEvent } from '../src/index.ts'

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly scripts: Array<StreamChunk[] | 'hang'>) { super() }

  override providerInfo() { return { id: 'mock', name: 'Mock' } }
  override listModels() { return Promise.resolve([{ provider: 'mock', id: 'mock', name: 'Mock' }]) }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text'] })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const script = this.scripts.shift()
    if (script === undefined) throw new Error('script exhausted')
    if (script === 'hang') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'partial' }
      await new Promise<void>((_resolve, reject) => {
        if (options.signal?.aborted) return reject(new Error('aborted'))
        options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
      return
    }
    for (const chunk of script) yield chunk
  }
}

function response(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'think' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'think' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text },
    { type: 'block-end', index: 1, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

describe('ClawX DeepSeek Harness bridge', () => {
  let ctx: Context | undefined

  afterEach(async () => { await ctx?.fiber.dispose(); ctx = undefined })

  async function setup(scripts: Array<StreamChunk[] | 'hang'>) {
    ctx = new Context()
    await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: '' } })
    await ctx.plugin(ApprovalService, { policy: 'ask' })
    await ctx.plugin(AgentLoop, { agents: [] })
    const adapter = new ScriptedAdapter(scripts)
    ctx.llm.registerAdapter(['mock'], adapter)
    const events: ClawXDshKernelEvent[] = []
    const bridge = new ClawXDshAcpBridge(ctx, { emit: event => { events.push(event) } })
    return { adapter, bridge, events }
  }

  it('hydrates canonical roles, emits rich ordered events, checkpoints, and disposes its agent', async () => {
    ctx = new Context()
    await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: '' } })
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([response('done')]))
    const events: ClawXDshKernelEvent[] = []
    const bridge = new ClawXDshAcpBridge(ctx, {
      emit: async event => {
        // Earlier events deliberately take longer. The bridge must still make
        // observable delivery order equal eventSeq and settle terminal last.
        await new Promise(resolve => setTimeout(resolve, event.event.kind === 'run.terminal' ? 0 : 1))
        events.push(event)
      },
    })
    const result = await bridge.prompt({
      identity: { conversationId: 'conversation', turnId: 'turn', runId: 'run' },
      context: [
        { id: 'u', turnId: 'u1', role: 'user', position: 0, type: 'text', visibility: 'portable', text: 'hello' },
        { id: 'a', turnId: 'a1', role: 'assistant', position: 1, type: 'text', visibility: 'portable', text: 'hi' },
      ],
      agentId: 'default',
      workspaceUri: process.cwd(),
      providerId: 'mock',
      modelId: 'mock',
    })

    expect(events.map(event => event.event.kind)).toEqual(expect.arrayContaining([
      'reasoning.visibility', 'assistant.delta', 'usage', 'assistant.final', 'run.terminal',
    ]))
    expect(events.map(event => event.eventSeq)).toEqual(events.map((_event, index) => index + 1))
    expect(result.checkpoint).toMatchObject({
      codec: 'deepseek-harness-agent',
      conversationId: 'conversation',
      agentId: 'default',
    })
    expect(ctx!.agents.get(result.nativeSessionId as never)).toBeUndefined()
    await bridge.close()
  })

  it('cancels the exact run without crossing another identity', async () => {
    const { bridge, events } = await setup(['hang'])
    const pending = bridge.prompt({
      identity: { conversationId: 'conversation', turnId: 'turn', runId: 'run' },
      context: [{ id: 'u', type: 'text', visibility: 'portable', text: 'hello' }],
      agentId: 'default',
      workspaceUri: process.cwd(),
      providerId: 'mock',
      modelId: 'mock',
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    await expect(bridge.cancel({ conversationId: 'other', turnId: 'turn', runId: 'run' }))
      .rejects.toThrow(/stale or unknown/)
    await expect(bridge.cancel({ conversationId: 'conversation', turnId: 'turn', runId: 'run' }))
      .resolves.toEqual({ acknowledged: true })
    await pending.catch(() => undefined)
    expect(events.some(event => event.event.kind === 'cancel.acknowledged')).toBe(true)
    await bridge.close()
  })

  it('scopes the admitted canonical persona to the exact run system prompt', async () => {
    const { adapter, bridge } = await setup([response('persona applied')])
    await bridge.prompt({
      identity: { conversationId: 'conversation', turnId: 'turn', runId: 'persona-run' },
      context: [{ id: 'u', type: 'text', visibility: 'portable', text: 'hello' }],
      agentId: 'persona-agent',
      agentVersion: 7,
      agentPersona: 'Always cite primary sources.',
      workspaceUri: process.cwd(),
      providerId: 'mock',
      modelId: 'mock',
    })
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]?.system).toContain('Always cite primary sources.')
    expect(ctx!.agents.roots()).toEqual([])
    await bridge.close()
  })

  it('mounts the admitted preset through the native DSH AgentPresets scope', async () => {
    const { adapter, bridge } = await setup([response('preset applied')])
    const mounted: string[] = []
    ctx!.provide('agentPresets', {
      mount: async (agentCtx: Context, presetId?: string) => {
        mounted.push(presetId ?? '')
        agentCtx.systemPrompt.section({
          name: 'preset:research',
          order: 10,
          text: 'Use the native research tool composition.',
        })
        return { id: presetId }
      },
    } as never)
    await bridge.prompt({
      identity: { conversationId: 'conversation', turnId: 'turn', runId: 'preset-run' },
      context: [{ id: 'u', type: 'text', visibility: 'portable', text: 'hello' }],
      agentId: 'preset-agent',
      agentPresetId: 'research',
      workspaceUri: process.cwd(),
      providerId: 'mock',
      modelId: 'mock',
    })
    expect(mounted).toEqual(['research'])
    expect(adapter.requests[0]?.system).toContain('Use the native research tool composition.')
    expect(ctx!.agents.roots()).toEqual([])
    await bridge.close()
  })

  it('fails explicitly when an admitted preset cannot be mounted', async () => {
    const { bridge } = await setup([])
    await expect(bridge.prompt({
      identity: { conversationId: 'conversation', turnId: 'turn', runId: 'missing-preset-run' },
      context: [{ id: 'u', type: 'text', visibility: 'portable', text: 'hello' }],
      agentId: 'preset-agent',
      agentPresetId: 'missing',
      workspaceUri: process.cwd(),
      providerId: 'mock',
      modelId: 'mock',
    })).rejects.toThrow(/preset is unavailable: missing/)
    expect(ctx!.agents.roots()).toEqual([])
    await bridge.close()
  })

  it('round-trips one live approval through a run-scoped permission request', async () => {
    const { bridge, events } = await setup(['hang'])
    const identity = { conversationId: 'conversation', turnId: 'turn', runId: 'permission-run' }
    const pending = bridge.prompt({
      identity,
      context: [{ id: 'u', type: 'text', visibility: 'portable', text: 'hello' }],
      agentId: 'default',
      workspaceUri: process.cwd(),
      providerId: 'mock',
      modelId: 'mock',
      permissionMode: 'ask',
    })
    let agent = ctx!.agents.roots()[0]
    for (let attempt = 0; attempt < 100 && agent === undefined; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 2))
      agent = ctx!.agents.roots()[0]
    }
    expect(agent).toBeDefined()
    for (let attempt = 0; attempt < 100
      && !agent!.session.events.some(event => event.type === 'turn/start'); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 2))
    }
    const approval = ctx!.approval.request({ agent: agent!, toolName: 'bash', reason: 'permission smoke' })
    let request = events.find(event => event.event.kind === 'permission.request')
    for (let attempt = 0; attempt < 100 && request === undefined; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 2))
      request = events.find(event => event.event.kind === 'permission.request')
    }
    const requestId = (request?.event.payload as { requestId?: string } | undefined)?.requestId
    expect(requestId).toBeTypeOf('string')
    await bridge.resolvePermission(identity, { requestId: requestId!, decision: 'allow-once' })
    await expect(approval).resolves.toBe('allowed-once')
    await bridge.cancel(identity)
    await pending.catch(() => undefined)
    await bridge.close()
  })

  it('rejects a checkpoint from another conversation before creating an agent', async () => {
    const { bridge } = await setup([])
    await expect(bridge.prompt({
      identity: { conversationId: 'new', turnId: 'turn', runId: 'run' },
      context: [{ id: 'u', type: 'text', visibility: 'portable', text: 'hello' }],
      agentId: 'default',
      workspaceUri: process.cwd(),
      providerId: 'mock',
      modelId: 'mock',
      checkpoint: {
        protocol: 'clawx.dsh-acp-bridge/v1',
        codec: 'deepseek-harness-agent',
        schemaVersion: 1,
        conversationId: 'old',
        agentId: 'default',
        workspaceUri: process.cwd(),
        contextHash: 'hash',
        nativeSessionId: 'native',
        completedAt: new Date().toISOString(),
      },
    })).rejects.toThrow(/another conversation/)
    await bridge.close()
  })
})
