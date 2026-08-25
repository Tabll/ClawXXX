import { describe, expect, it } from 'vitest';
import {
  asConversationId,
  asRunId,
  asTurnId,
  type ConversationExport,
} from '@shared/conversations/contracts';
import {
  kernelEventToAcpUpdate,
  projectConversationHistory,
} from '@/lib/conversations/acp-projection';

function history(status = 'completed'): ConversationExport {
  return {
    schema: 'clawx.conversation-export/v1',
    conversation: {
      id: asConversationId('conversation-one'),
      title: 'Canonical',
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:04.000Z',
    },
    turns: [
      {
        id: 'user-turn',
        role: 'user',
        position: 0,
        createdAt: '2026-08-24T00:00:00.000Z',
        blocks: [
          { id: 'prompt', type: 'text', visibility: 'portable', text: 'hello' },
          {
            id: 'blob',
            type: 'resource-link',
            visibility: 'portable',
            blobHash: 'a'.repeat(64),
            mimeType: 'text/plain',
          },
          {
            id: 'blob-name',
            type: 'metadata',
            visibility: 'portable',
            json: { attachment: { blockId: 'blob', fileName: 'notes.txt' } },
          },
        ],
      },
      ...(status === 'completed' ? [{
        id: 'assistant-turn',
        role: 'assistant',
        position: 1,
        createdAt: '2026-08-24T00:00:04.000Z',
        blocks: [
          { id: 'answer', type: 'text', visibility: 'portable', text: 'done' },
          {
            id: 'workspace-report',
            type: 'resource-link',
            visibility: 'kernel',
            kernelId: 'deepseek-harness',
            mimeType: 'text/plain',
            json: { uri: 'file:///workspace/report.txt', name: 'report.txt', size: 12 },
          },
        ],
      } as const] : []),
    ],
    runs: [{
      id: asRunId('run-one'),
      turnId: asTurnId('user-turn'),
      ...(status === 'completed' ? { assistantTurnId: asTurnId('assistant-turn') } : {}),
      kernelId: 'deepseek-harness',
      kernelVersion: '0.0.1+clawx.1',
      generation: 3,
      agentId: 'researcher',
      agentSnapshot: {
        agentId: 'researcher' as ConversationExport['runs'][number]['agentSnapshot']['agentId'],
        displayName: 'Research Agent',
        kernelId: 'deepseek-harness',
        workspaceUri: 'file:///tmp/research',
        canonicalVersion: 4,
      },
      providerId: 'deepseek',
      modelId: 'deepseek-chat',
      status,
      createdAt: '2026-08-24T00:00:00.000Z',
      startedAt: '2026-08-24T00:00:01.000Z',
      ...(status === 'completed' ? { completedAt: '2026-08-24T00:00:04.000Z' } : {}),
      events: [
        {
          eventSeq: 1,
          kind: 'reasoning.visibility',
          payload: { visibility: 'private', text: 'thinking' },
          emittedAt: '2026-08-24T00:00:01.000Z',
        },
        {
          eventSeq: 2,
          kind: 'tool.start',
          payload: { toolCallId: 'tool-one', title: 'Read', status: 'in_progress' },
          emittedAt: '2026-08-24T00:00:02.000Z',
        },
        {
          eventSeq: 3,
          kind: 'permission.request',
          payload: {
            requestId: 'permission-one',
            options: [{ optionId: 'allow_once', name: 'Allow', kind: 'allow_once' }],
          },
          emittedAt: '2026-08-24T00:00:02.100Z',
        },
        {
          eventSeq: 4,
          kind: 'permission.resolved',
          payload: { requestId: 'permission-one', decision: 'allow-once' },
          emittedAt: '2026-08-24T00:00:02.200Z',
        },
        {
          eventSeq: 5,
          kind: 'tool.result',
          payload: { toolCallId: 'tool-one', status: 'completed', content: [] },
          emittedAt: '2026-08-24T00:00:03.000Z',
        },
        {
          eventSeq: 6,
          kind: status === 'completed' ? 'assistant.final' : 'assistant.delta',
          payload: { text: status === 'completed' ? 'done' : 'partial' },
          emittedAt: '2026-08-24T00:00:03.500Z',
        },
      ],
    }],
    usage: [{
      runId: 'run-one',
      inputTokens: 10,
      outputTokens: 4,
    }],
  };
}

describe('canonical Conversation history projection', () => {
  it('projects durable tools, reasoning, permissions, attachments, timing, and provenance', () => {
    const projected = projectConversationHistory(history());
    expect(projected.steps.map(step => step.kind)).toEqual([
      'update',
      'update',
      'update',
      'permission-request',
      'permission-resolved',
      'update',
      'update',
    ]);
    const user = projected.steps[0];
    expect(user.kind === 'update' && user.event.notification).toMatchObject({
      update: {
        sessionUpdate: 'user_message',
        content: expect.arrayContaining([
          expect.objectContaining({
            type: 'resource_link',
            uri: `clawx-blob://${'a'.repeat(64)}`,
            name: 'notes.txt',
          }),
        ]),
      },
    });
    expect(projected.assistantMetadataByMessageId['assistant-turn:0']).toMatchObject({
      kernelId: 'deepseek-harness',
      kernelVersion: '0.0.1+clawx.1',
      agentId: 'researcher',
      agentName: 'Research Agent',
      runId: 'run-one',
      model: 'deepseek-chat',
      usage: { inputTokens: 10, outputTokens: 4 },
    });
    expect(projected.turnTimingsByUserMessageId['user-turn']).toEqual({
      source: 'transcript',
      status: 'complete',
      durationMs: 3_000,
    });
    expect(projected.steps).toContainEqual(expect.objectContaining({
      kind: 'update',
      event: expect.objectContaining({
        notification: expect.objectContaining({
          update: expect.objectContaining({
            sessionUpdate: 'agent_message',
            content: expect.arrayContaining([{
              type: 'resource_link',
              uri: 'file:///workspace/report.txt',
              name: 'report.txt',
              mimeType: 'text/plain',
              size: 12,
            }]),
          }),
        }),
      }),
    }));
  });

  it('restores partial assistant output only for a run without a durable assistant turn', () => {
    const projected = projectConversationHistory(history('running'));
    const updates = projected.steps.flatMap(step => (
      step.kind === 'update'
        ? [step.event.notification.update as unknown as Record<string, unknown>]
        : []
    ));
    expect(updates).toContainEqual(expect.objectContaining({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'run-one',
      content: { type: 'text', text: 'partial' },
    }));
  });

  it('keeps full canonical run identity on live event projection', () => {
    const event = kernelEventToAcpUpdate({
      protocol: 'clawx.kernel/v1',
      conversationId: 'conversation-one',
      turnId: 'turn-one',
      runId: 'run-one',
      kernelId: 'openclaw',
      generation: 2,
      eventSeq: 7,
      emittedAt: '2026-08-24T00:00:00.000Z',
      event: { kind: 'assistant.delta', payload: { text: 'stream' } },
    });
    expect(event).toMatchObject({
      sessionKey: 'conversation-one',
      conversationId: 'conversation-one',
      runId: 'run-one',
      kernelId: 'openclaw',
      generation: 2,
      eventSeq: 7,
      notification: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'stream' },
        },
      },
    });
  });

  it('projects a plain live assistant final as a complete ACP block array', () => {
    const event = kernelEventToAcpUpdate({
      protocol: 'clawx.kernel/v1',
      conversationId: 'conversation-one',
      turnId: 'turn-one',
      runId: 'run-one',
      kernelId: 'openclaw',
      generation: 2,
      eventSeq: 8,
      emittedAt: '2026-08-24T00:00:01.000Z',
      event: { kind: 'assistant.final', payload: { text: 'done' } },
    });
    expect(event?.notification.update).toMatchObject({
      sessionUpdate: 'agent_message',
      content: [{ type: 'text', text: 'done' }],
    });
  });

  it('projects live assistant resources without waiting for a history reload', () => {
    const event = kernelEventToAcpUpdate({
      protocol: 'clawx.kernel/v1',
      conversationId: 'conversation-one',
      turnId: 'turn-one',
      runId: 'run-one',
      kernelId: 'openclaw',
      generation: 2,
      eventSeq: 8,
      emittedAt: '2026-08-24T00:00:01.000Z',
      event: {
        kind: 'assistant.final',
        payload: {
          text: 'done',
          resources: [{
            uri: 'file:///workspace/report.xlsx',
            name: 'report.xlsx',
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            size: 42,
          }],
        },
      },
    });
    expect(event?.notification.update).toMatchObject({
      sessionUpdate: 'agent_message',
      content: [
        { type: 'text', text: 'done' },
        {
          type: 'resource_link',
          uri: 'file:///workspace/report.xlsx',
          name: 'report.xlsx',
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          size: 42,
        },
      ],
    });
  });

  it('projects standard live assistant images without a runtime-history fallback', () => {
    const event = kernelEventToAcpUpdate({
      protocol: 'clawx.kernel/v1',
      conversationId: 'conversation-one',
      turnId: 'turn-one',
      runId: 'run-one',
      kernelId: 'openclaw',
      generation: 2,
      eventSeq: 9,
      emittedAt: '2026-08-24T00:00:02.000Z',
      event: {
        kind: 'assistant.final',
        payload: {
          text: 'image ready',
          content: [{ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }],
        },
      },
    });
    expect(event?.notification.update).toMatchObject({
      sessionUpdate: 'agent_message',
      content: [
        { type: 'text', text: 'image ready' },
        { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
      ],
    });
  });
});
