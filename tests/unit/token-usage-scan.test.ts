import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { testHome, testUserData } = vi.hoisted(() => {
  const suffix = Math.random().toString(36).slice(2);
  return {
    testHome: `/tmp/clawx-token-usage-${suffix}`,
    testUserData: `/tmp/clawx-token-usage-user-data-${suffix}`,
  };
});

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  const mocked = {
    ...actual,
    homedir: () => testHome,
  };
  return {
    ...mocked,
    default: mocked,
  };
});

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => testUserData,
    getVersion: () => '0.0.0-test',
  },
}));

describe('token usage session scan', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.restoreAllMocks();
    await rm(testHome, { recursive: true, force: true });
    await rm(testUserData, { recursive: true, force: true });
  });

  it('includes transcripts from agent directories that exist on disk but are not configured', async () => {
    const openclawDir = join(testHome, '.openclaw');
    await mkdir(openclawDir, { recursive: true });
    await writeFile(join(openclawDir, 'openclaw.json'), JSON.stringify({
      agents: {
        list: [
          { id: 'main', name: 'Main', default: true },
        ],
      },
    }, null, 2), 'utf8');

    const diskOnlySessionsDir = join(openclawDir, 'agents', 'custom-custom25', 'sessions');
    await mkdir(diskOnlySessionsDir, { recursive: true });
    await writeFile(
      join(diskOnlySessionsDir, 'f8e66f77-0125-4e2f-b750-9c4de01e8f5a.jsonl'),
      [
        JSON.stringify({
          type: 'message',
          timestamp: '2026-03-12T12:19:00.000Z',
          message: {
            role: 'assistant',
            model: 'gpt-5.2-2025-12-11',
            provider: 'openai',
            usage: {
              input: 17649,
              output: 107,
              total: 17756,
            },
          },
        }),
      ].join('\n'),
      'utf8',
    );

    const { getRecentTokenUsageHistory } = await import('@electron/utils/token-usage');
    const entries = await getRecentTokenUsageHistory();

    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentId: 'custom-custom25',
          sessionId: 'f8e66f77-0125-4e2f-b750-9c4de01e8f5a',
          model: 'gpt-5.2-2025-12-11',
          totalTokens: 17756,
        }),
      ]),
    );
  });

  it('attaches system prompt report context from sessions.json to usage entries', async () => {
    const openclawDir = join(testHome, '.openclaw');
    const sessionsDir = join(openclawDir, 'agents', 'agent', 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(
      join(sessionsDir, 'sessions.json'),
      JSON.stringify({
        'agent:thread': {
          label: 'Context Session',
          sessionId: 'context-session',
          channel: 'cli',
          chatType: 'direct',
          status: 'done',
          runtimeMs: 1250,
          providerOverride: 'openai',
          modelOverride: 'gpt-5.2-2025-12-11',
          usageFamilySessionIds: ['context-session', 'context-session-reset'],
          usage: {
            messageCounts: {
              total: 4,
              user: 2,
              assistant: 2,
              toolCalls: 1,
              toolResults: 1,
              errors: 0,
            },
            toolUsage: {
              totalCalls: 1,
              uniqueTools: 1,
              tools: [
                { name: 'shell', count: 1 },
              ],
            },
          },
          systemPromptReport: {
            systemPrompt: {
              chars: 12000,
              projectContextChars: 4000,
              nonProjectContextChars: 8000,
            },
            skills: {
              promptChars: 4000,
              entries: [
                { name: 'skill-a', blockChars: 2400 },
              ],
            },
            tools: {
              listChars: 500,
              schemaChars: 1500,
              entries: [
                { name: 'tool-a', summaryChars: 100, schemaChars: 900 },
              ],
            },
            injectedWorkspaceFiles: [
              { name: 'AGENTS.md', injectedChars: 1000 },
            ],
          },
        },
      }, null, 2),
      'utf8',
    );
    await writeFile(
      join(sessionsDir, 'context-session.jsonl'),
      [
        JSON.stringify({
          type: 'message',
          timestamp: '2026-03-12T12:19:00.000Z',
          message: {
            role: 'assistant',
            model: 'gpt-5.2-2025-12-11',
            provider: 'openai',
            usage: {
              input: 10000,
              output: 100,
              total: 10100,
            },
          },
        }),
      ].join('\n'),
      'utf8',
    );

    const { getRecentTokenUsageHistory } = await import('@electron/utils/token-usage');
    const entries = await getRecentTokenUsageHistory();
    const entry = entries.find((candidate) => candidate.sessionId === 'context-session');

    expect(entry?.contextWeight).toEqual(expect.objectContaining({
      systemPrompt: expect.objectContaining({ chars: 12000 }),
      skills: expect.objectContaining({ promptChars: 4000 }),
      tools: expect.objectContaining({ schemaChars: 1500 }),
    }));
    expect(entry?.contextWeight?.injectedWorkspaceFiles[0]).toEqual(expect.objectContaining({
      name: 'AGENTS.md',
      injectedChars: 1000,
    }));
    expect(entry?.sessionMeta).toEqual(expect.objectContaining({
      key: 'agent:thread',
      label: 'Context Session',
      channel: 'cli',
      chatType: 'direct',
      status: 'done',
      runtimeMs: 1250,
      providerOverride: 'openai',
      modelOverride: 'gpt-5.2-2025-12-11',
      includedSessionIds: ['context-session', 'context-session-reset'],
    }));
    expect(entry?.sessionMeta?.messageCounts).toEqual(expect.objectContaining({
      total: 1,
      assistant: 1,
    }));
    expect(entry?.sessionMeta?.toolUsage).toEqual(expect.objectContaining({
      totalCalls: 1,
      uniqueTools: 1,
      tools: [{ name: 'shell', count: 1 }],
    }));
  });
});
