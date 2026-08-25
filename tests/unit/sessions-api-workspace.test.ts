// @vitest-environment node

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClawXDataService, type ClawXDataClient } from '@electron/data/clawx-data-service';
import { createSessionsApi } from '@electron/services/sessions-api';
import { asConversationId, asRunId, asTurnId } from '@shared/conversations/contracts';
import { testAgentRouting } from '../helpers/canonical-agent';

const services: ClawXDataService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.close()));
});

function callClient(client: ClawXDataClient) {
  return {
    call<T>(method: string, ...args: unknown[]): Promise<T> {
      const fn = (client as unknown as Record<string, unknown>)[method];
      if (typeof fn !== 'function') return Promise.reject(new Error(`Unknown method: ${method}`));
      return Reflect.apply(fn, client, args) as Promise<T>;
    },
  };
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'clawx-canonical-sessions-'));
  const service = new ClawXDataService(join(root, 'data', 'clawx.sqlite'));
  services.push(service);
  const main = service.connect({ role: 'main' });
  const kernel = service.connect({ role: 'kernel', kernelId: 'openclaw', generation: 1 });
  const conversationId = asConversationId('conversation-canonical');
  const runId = asRunId('run-canonical');
  const userTurnId = asTurnId('turn-user');
  await main.createConversation({
    id: conversationId,
    title: 'Canonical title',
    createdAt: '2026-08-23T10:00:00.000Z',
  });
  await main.admitRun({
    conversationId,
    turnId: userTurnId,
    runId,
    routing: {
      kernelId: 'openclaw',
      kernelVersion: 'test',
      generation: 1,
      ...testAgentRouting('openclaw'),
      contextCompilerVersion: 'v1',
    },
    userBlocks: [{ id: 'user-text', type: 'text', visibility: 'portable', text: 'canonical prompt' }],
    createdAt: '2026-08-23T10:00:01.000Z',
  });
  await kernel.markRunStarted(runId, '2026-08-23T10:00:02.000Z');
  await kernel.commitTerminalRun({
    conversationId,
    userTurnId,
    assistantTurnId: asTurnId('turn-assistant'),
    runId,
    kernelId: 'openclaw',
    generation: 1,
    outcome: 'completed',
    assistantBlocks: [{ id: 'answer', type: 'text', visibility: 'portable', text: 'canonical answer' }],
    completedAt: '2026-08-23T10:00:06.000Z',
  });
  return { main, api: createSessionsApi({ dataClient: callClient(main) }), conversationId };
}

describe('sessions API canonical Conversation repository compatibility', () => {
  it('loads summaries, history and timings only from ClawX SQLite', async () => {
    const { api, conversationId } = await fixture();
    await expect(api.summaries({ sessionKeys: [conversationId] })).resolves.toEqual({
      success: true,
      summaries: [{
        sessionKey: conversationId,
        firstUserText: 'Canonical title',
        lastTimestamp: Date.parse('2026-08-23T10:00:06.000Z'),
        workspacePath: null,
        pinned: false,
      }],
    });
    await expect(api.history({ sessionKey: conversationId })).resolves.toMatchObject({
      success: true,
      messages: [
        { id: 'turn-user', role: 'user', content: 'canonical prompt' },
        { id: 'turn-assistant', role: 'assistant', content: 'canonical answer' },
      ],
    });
    await expect(api.turnTimings({ sessionKey: conversationId })).resolves.toEqual({
      success: true,
      timings: [{
        normalizedUserText: 'canonical prompt',
        userOccurrenceFromTail: 1,
        durationMs: 5_000,
      }],
    });
  });

  it('renames, pins and hard-deletes the canonical Conversation', async () => {
    const { main, api, conversationId } = await fixture();
    await expect(api.rename({ id: conversationId, title: 'Renamed' })).resolves.toEqual({ success: true });
    await expect(api.pin({ id: conversationId, pinned: true })).resolves.toEqual({ success: true });
    expect(await main.getConversation(conversationId)).toEqual(expect.objectContaining({
      title: 'Renamed',
      pinnedAt: expect.any(String),
    }));
    await expect(api.delete({ id: conversationId })).resolves.toEqual({ success: true });
    expect(await main.getConversation(conversationId)).toBeUndefined();
  });

  it('fails closed instead of falling back to a runtime transcript', async () => {
    const api = createSessionsApi();
    await expect(api.history({ sessionKey: 'agent:main:legacy' }))
      .rejects.toThrow(/Canonical Conversation DataService is unavailable/);
  });
});
