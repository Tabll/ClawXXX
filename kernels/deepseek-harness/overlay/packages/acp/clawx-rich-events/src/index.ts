/**
 * Lossless rich presentation projection for ClawX's DeepSeek Harness bridge.
 *
 * Live assistant frames drive incrementality; v2 Session settlements supply
 * tools and provider usage. This companion owns no history and writes no files.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionId, Session } from '@deepseek-ai/dsh-session'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-tool-todo'
import type { SessionUpdate, ToolKind } from '@agentclientprotocol/sdk'

export const name = 'clawx-rich-events'
export const inject = ['sessions']

export interface ClawXRichEventSink {
  sessionUpdate(sessionId: string, update: SessionUpdate): Promise<void>
}

export interface Config {
  readonly sink: ClawXRichEventSink
  readonly ownsSession?: (sessionId: SessionId) => boolean
  readonly contextWindow?: number
}

function toolKind(name: string): ToolKind {
  const normalized = name.toLowerCase()
  if (/read|view|cat/.test(normalized)) return 'read'
  if (/edit|write|patch/.test(normalized)) return 'edit'
  if (/delete|remove/.test(normalized)) return 'delete'
  if (/move|rename/.test(normalized)) return 'move'
  if (/search|grep|find/.test(normalized)) return 'search'
  if (/bash|shell|exec|command|terminal/.test(normalized)) return 'execute'
  if (/fetch|http|web/.test(normalized)) return 'fetch'
  return 'other'
}

function parseArguments(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

type AssistantSettlement = Extract<SessionEvent, { type: 'assistant/message' | 'assistant/attempt' }>

function usageUpdate(event: AssistantSettlement, contextWindow: number): SessionUpdate | undefined {
  let usage: TokenUsage | undefined = event.type === 'assistant/message' ? event.data.usage : undefined
  // A failed attempt has no surface message, but may still report billable
  // usage. Repeated usage chunks are snapshots of one request, not additions.
  if (event.type === 'assistant/attempt') {
    for (const record of event.data.stream) {
      if (record.type === 'chunk' && record.chunk.type === 'usage') usage = record.chunk.usage
    }
  }
  if (usage === undefined) return undefined
  const input = usage.inputTokens
  const output = usage.outputTokens
  const cacheRead = usage.cacheReadTokens
  const cacheWrite = usage.cacheWriteTokens
  return {
    sessionUpdate: 'usage_update',
    used: input + (cacheRead ?? 0) + (cacheWrite ?? 0),
    size: contextWindow,
    _meta: {
      clawx: {
        turn: event.data.turn,
        step: event.data.step,
        eventSeq: event.seq,
        inputTokens: input,
        outputTokens: output,
        ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
        ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
        ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
        ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
        source: 'runtime-event',
      },
    },
  }
}

/** Project a transient assistant frame without re-emitting its durable stream. */
export function projectAssistantStreamFrame(frame: AssistantStreamFrame): SessionUpdate[] {
  if (frame.type !== 'chunk') return []
  const chunk = frame.chunk
  const meta = { attemptId: frame.attemptId, revision: frame.revision, index: frame.index }
  if (chunk.type === 'text-delta') {
    return [{
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: chunk.text },
      _meta: { clawx: meta },
    }]
  }
  if (chunk.type === 'reasoning-delta') {
    return [{
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: chunk.text },
      _meta: { clawx: { ...meta, visibility: 'private' } },
    }]
  }
  return []
}

/** Map one DSH durable event to zero or more strict ACP session updates. */
export function projectSessionEvent(event: SessionEvent, contextWindow = 0): SessionUpdate[] {
  switch (event.type) {
    case 'tool/call':
      return [{
        sessionUpdate: 'tool_call',
        toolCallId: event.data.callId,
        title: event.data.name,
        kind: toolKind(event.data.name),
        status: 'in_progress',
        rawInput: parseArguments(event.data.arguments),
        _meta: { clawx: { turn: event.data.turn, step: event.data.step, eventSeq: event.seq } },
      }]
    case 'tool/result':
      return [{
        sessionUpdate: 'tool_call_update',
        toolCallId: event.data.message.source.callId,
        status: event.data.message.content[0]?.type === 'tool-result' && event.data.message.content[0].isError
          ? 'failed'
          : 'completed',
        rawOutput: structuredClone(event.data.message.content),
        _meta: {
          clawx: {
            turn: event.data.turn,
            step: event.data.step,
            eventSeq: event.seq,
            error: event.data.error,
            presentation: event.data.meta,
          },
        },
      }]
    case 'assistant/message':
    case 'assistant/attempt': {
      const update = usageUpdate(event, contextWindow)
      return update === undefined ? [] : [update]
    }
    case 'todo/write':
      return [{
        sessionUpdate: 'plan',
        entries: event.data.todos.map(todo => ({
          content: todo.content,
          status: todo.status,
          priority: 'medium',
        })),
        _meta: { clawx: { eventSeq: event.seq } },
      }]
    default: {
      const generic = event as unknown as { type: string; data: Record<string, unknown> }
      if (generic.type === 'session/title' && typeof generic.data.title === 'string') {
        return [{
          sessionUpdate: 'session_info_update',
          title: generic.data.title,
          updatedAt: new Date(event.time).toISOString(),
          _meta: { clawx: { eventSeq: event.seq } },
        }]
      }
      return []
    }
  }
}

/** Install ordered rich projection; sink failures are contained and logged. */
export function apply(ctx: Context, config: Config): void {
  if (config.sink === undefined) throw new Error('ClawX rich events requires a sink')
  const tails = new Map<SessionId, Promise<void>>()
  const revisions = new WeakMap<object, number>()
  const deliver = (session: Session, updates: SessionUpdate[]): void => {
    if (config.ownsSession !== undefined && !config.ownsSession(session.header.id)) return
    if (updates.length === 0) return
    const previous = tails.get(session.header.id) ?? Promise.resolve()
    const next = previous.then(async () => {
      for (const update of updates) await config.sink.sessionUpdate(session.header.id, update)
    }).catch((error: unknown) => {
      ctx.logger.warn(`clawx rich event delivery failed for ${session.header.id}: ${String(error)}`)
    })
    tails.set(session.header.id, next)
  }
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    deliver(session, projectSessionEvent(event, config.contextWindow ?? 0))
  })
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (frame.revision <= (revisions.get(agent) ?? 0)) return
    revisions.set(agent, frame.revision)
    deliver(agent.session, projectAssistantStreamFrame(frame))
  })
  ctx.on('session/disposed', (session: Session) => { tails.delete(session.header.id) })
}
