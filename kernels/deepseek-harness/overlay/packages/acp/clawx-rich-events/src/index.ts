/**
 * Lossless rich presentation projection for ClawX's DeepSeek Harness bridge.
 *
 * Upstream DSH ACP intentionally exposes an automation-only final-text surface.
 * This companion consumes the same durable SessionEvent stream and emits the
 * richer ACP updates required by the existing ClawX timeline. It owns no
 * history and writes no files.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionId, Session } from '@deepseek-ai/dsh-session'
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

function usageUpdate(event: Extract<SessionEvent, { type: 'assistant/message' }>, contextWindow: number): SessionUpdate | undefined {
  const usage = event.data.usage
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
        inputTokens: input,
        outputTokens: output,
        ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
        ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
        source: 'runtime-event',
      },
    },
  }
}

/** Map one DSH durable event to zero or more strict ACP session updates. */
export function projectSessionEvent(event: SessionEvent, contextWindow = 0): SessionUpdate[] {
  switch (event.type) {
    case 'assistant/chunk': {
      const chunk = event.data.chunk
      if (chunk.type === 'text-delta') {
        return [{
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: chunk.text },
          _meta: { clawx: { turn: event.data.turn, step: event.data.step, eventSeq: event.seq } },
        }]
      }
      if (chunk.type === 'reasoning-delta') {
        return [{
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: chunk.text },
          _meta: { clawx: { turn: event.data.turn, step: event.data.step, eventSeq: event.seq, visibility: 'private' } },
        }]
      }
      return []
    }
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
    case 'assistant/message': {
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
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (config.ownsSession !== undefined && !config.ownsSession(session.header.id)) return
    const updates = projectSessionEvent(event, config.contextWindow ?? 0)
    if (updates.length === 0) return
    const previous = tails.get(session.header.id) ?? Promise.resolve()
    const next = previous.then(async () => {
      for (const update of updates) await config.sink.sessionUpdate(session.header.id, update)
    }).catch((error: unknown) => {
      ctx.logger.warn(`clawx rich event delivery failed for ${session.header.id}: ${String(error)}`)
    })
    tails.set(session.header.id, next)
  })
  ctx.on('session/disposed', (session: Session) => { tails.delete(session.header.id) })
}
