// @vitest-environment node

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { OpenClawAcpChatAdapter } from '@electron/kernels/openclaw/acp-chat-adapter';
import type { AcpChatService } from '@electron/services/acp-chat-service';
import type { AcpPermissionRequestEnvelope, AcpSessionUpdateEnvelope } from '@shared/acp-chat/types';
import { asConversationId, asRunId, asTurnId } from '@shared/conversations/contracts';
import type { KernelRunRequest } from '@shared/kernels/contracts';
import { createFakeHost } from './driver-contract-kit';

function request(id: string): KernelRunRequest {
  return {
    conversationId: asConversationId(`conversation-${id}`),
    turnId: asTurnId(`turn-${id}`),
    runId: asRunId(`run-${id}`),
    kernelId: 'openclaw',
    generation: 1,
    agentId: 'main',
    workspaceUri: 'file:///workspace',
    context: [{
      id: `text-${id}`,
      turnId: asTurnId(`turn-${id}`),
      role: 'user',
      position: 0,
      type: 'text',
      visibility: 'portable',
      text: id,
    }],
  };
}

function fixture(overrides: Partial<Record<string, unknown>> = {}) {
  let updateObserver: ((event: AcpSessionUpdateEnvelope) => Promise<void> | void) | undefined;
  let permissionObserver: ((event: AcpPermissionRequestEnvelope) => Promise<void> | void) | undefined;
  const acp = {
    observeSessionUpdates: vi.fn((observer) => {
      updateObserver = observer;
      return () => { updateObserver = undefined; };
    }),
    observePermissionRequests: vi.fn((observer) => {
      permissionObserver = observer;
      return () => { permissionObserver = undefined; };
    }),
    loadSession: vi.fn(async () => ({ success: true, generation: 1 })),
    setSessionConfigOption: vi.fn(async () => ({ success: true, generation: 1, configOptions: [] })),
    sendPrompt: vi.fn(async () => ({ success: true, generation: 1 })),
    cancelSession: vi.fn(async () => ({ success: true, generation: 1 })),
    respondPermission: vi.fn(async () => ({ success: true, generation: 1 })),
    shutdown: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as AcpChatService;
  return {
    acp,
    update: (event: AcpSessionUpdateEnvelope) => updateObserver?.(event),
    permission: (event: AcpPermissionRequestEnvelope) => permissionObserver?.(event),
  };
}

function runtime() {
  const root = mkdtempSync(join(tmpdir(), 'clawx-openclaw-acp-adapter-'));
  const tempRoot = join(root, 'tmp');
  mkdirSync(tempRoot, { recursive: true });
  return {
    kernelId: 'openclaw' as const,
    artifactVersion: 'test+clawx.1',
    installRoot: root,
    packageDir: root,
    entryPath: join(root, 'openclaw.mjs'),
    nodeExecutable: process.execPath,
    stateRoot: join(root, 'state'),
    configRoot: join(root, 'state'),
    cacheRoot: join(root, 'cache'),
    tempRoot,
    managed: true as const,
    source: 'installed-artifact' as const,
  };
}

describe('OpenClaw ACP execution adapter', () => {
  it('normalizes live ACP events and materializes grant-scoped attachments only for the prompt', async () => {
    let fixtureRef: ReturnType<typeof fixture>;
    let stagedPath = '';
    fixtureRef = fixture({
      sendPrompt: vi.fn(async (payload: { sessionKey: string; media?: Array<{ filePath: string }> }) => {
        stagedPath = payload.media?.[0]?.filePath ?? '';
        expect(readFileSync(stagedPath, 'utf8')).toBe('canonical attachment');
        await fixtureRef.update({
          sessionKey: payload.sessionKey,
          generation: 1,
          notification: {
            sessionId: payload.sessionKey,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: [
                { type: 'text', text: 'answer' },
                {
                  type: 'resource_link',
                  uri: 'file:///workspace/report.txt',
                  name: 'report.txt',
                  mimeType: 'text/plain',
                },
                {
                  type: 'image',
                  data: 'aW1hZ2U=',
                  mimeType: 'image/png',
                },
              ],
            },
          },
        } as never);
        await fixtureRef.update({
          sessionKey: payload.sessionKey,
          generation: 1,
          notification: {
            sessionId: payload.sessionKey,
            update: { sessionUpdate: 'usage_update', inputTokens: 3, outputTokens: 2 },
          },
        } as never);
        await fixtureRef.permission({
          sessionKey: payload.sessionKey,
          generation: 1,
          requestId: 'permission-one',
          request: { sessionId: payload.sessionKey, options: [] },
        } as never);
        return { success: true, generation: 1 };
      }),
    });
    const host = createFakeHost();
    host.store.readAttachment = vi.fn(async () => new TextEncoder().encode('canonical attachment'));
    const adapter = new OpenClawAcpChatAdapter(fixtureRef.acp);
    await adapter.initialize({ host, generation: 1, runtime: runtime() });
    const input = request('events');
    input.context.push(
      {
        id: 'blob-block', turnId: input.turnId, role: 'user', position: 1,
        type: 'resource-link', visibility: 'portable', mimeType: 'text/plain', blobHash: 'a'.repeat(64),
      },
      {
        id: 'blob-name', turnId: input.turnId, role: 'user', position: 2,
        type: 'metadata', visibility: 'portable', json: { attachment: { blockId: 'blob-block', fileName: 'notes.txt' } },
      },
    );
    input.attachments = [{ blockId: 'blob-block', blobHash: 'a'.repeat(64), accessGrantId: 'grant-one' }];

    await adapter.execute(input);

    expect(host.events.map(event => event.event.kind)).toEqual([
      'assistant.delta', 'usage', 'permission.request', 'run.terminal',
    ]);
    expect(host.events[0]?.event.payload).toEqual({
      text: 'answer',
      messageId: undefined,
      resources: [{
        uri: 'file:///workspace/report.txt',
        name: 'report.txt',
        mimeType: 'text/plain',
      }],
      content: [{
        type: 'image',
        data: 'aW1hZ2U=',
        mimeType: 'image/png',
      }],
    });
    expect(host.events.map(event => event.eventSeq)).toEqual([1, 2, 3, 4]);
    expect(existsSync(stagedPath)).toBe(false);
  });

  it('serializes the single OpenClaw ACP connection and can cancel a queued run', async () => {
    const gate = Promise.withResolvers<void>();
    const calls: string[] = [];
    const f = fixture({
      loadSession: vi.fn(async (payload: { sessionKey: string }) => {
        calls.push(`load:${payload.sessionKey}`);
        return { success: true, generation: 1 };
      }),
      sendPrompt: vi.fn(async (payload: { sessionKey: string }) => {
        calls.push(`prompt:${payload.sessionKey}`);
        await gate.promise;
        return { success: true, generation: 1 };
      }),
    });
    const host = createFakeHost();
    const adapter = new OpenClawAcpChatAdapter(f.acp);
    await adapter.initialize({ host, generation: 1, runtime: runtime() });
    const firstInput = request('first');
    const secondInput = request('second');
    const first = adapter.execute(firstInput);
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    const second = adapter.execute(secondInput);
    await expect(adapter.cancel(secondInput)).resolves.toEqual({ acknowledged: true });
    gate.resolve();
    await Promise.all([first, second]);

    expect(calls).toEqual([
      expect.stringContaining('load:'),
      expect.stringContaining('prompt:'),
    ]);
    expect(host.events.filter(event => event.runId === secondInput.runId).map(event => event.event.kind))
      .toEqual(['cancel.acknowledged', 'run.terminal']);
  });
});
