import { describe, expect, it } from 'vitest';
import {
  aggregateUsageSessions,
  filterUsageHistoryByWindow,
  groupUsageHistory,
  matchesUsageSession,
  resolveStableUsageHistory,
  resolveVisibleUsageHistory,
  type UsageHistoryEntry,
} from '@/lib/usage-history';

function createEntry(day: number, totalTokens: number): UsageHistoryEntry {
  return {
    timestamp: `2026-03-${String(day).padStart(2, '0')}T12:00:00.000Z`,
    sessionId: `session-${day}`,
    agentId: 'main',
    model: 'gpt-5',
    inputTokens: totalTokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens,
  };
}

describe('token usage history helpers', () => {
  it('keeps all day buckets instead of truncating to the first eight', () => {
    const entries = Array.from({ length: 12 }, (_, index) => createEntry(index + 1, index + 1));

    const groups = groupUsageHistory(entries, 'day');

    expect(groups).toHaveLength(12);
    expect(groups[0]?.totalTokens).toBe(1);
    expect(groups[11]?.totalTokens).toBe(12);
  });

  it('uses the requested IANA timezone for day aggregation boundaries', () => {
    const entries = [
      { ...createEntry(1, 10), timestamp: '2026-03-01T07:30:00.000Z' },
      { ...createEntry(1, 20), timestamp: '2026-03-01T08:30:00.000Z' },
    ];

    const losAngeles = groupUsageHistory(entries, 'day', { timeZone: 'America/Los_Angeles' });
    const shanghai = groupUsageHistory(entries, 'day', { timeZone: 'Asia/Shanghai' });

    expect(losAngeles).toHaveLength(2);
    expect(losAngeles.map(group => group.totalTokens)).toEqual([10, 20]);
    expect(shanghai).toHaveLength(1);
    expect(shanghai[0]?.totalTokens).toBe(30);
  });

  it('tracks missing token and cost fields as unknown instead of inventing zero observations', () => {
    const unknown: UsageHistoryEntry = {
      timestamp: '2026-03-12T12:00:00.000Z',
      sessionId: 'unknown-usage',
      agentId: 'main',
      kernelId: 'deepseek-harness',
      usageStatus: 'missing',
    };

    const [group] = groupUsageHistory([unknown], 'model');
    const [session] = aggregateUsageSessions([unknown]);

    expect(group).toMatchObject({
      label: 'Unknown',
      count: 1,
      unknownTokenEntries: 1,
      unknownCostEntries: 1,
    });
    expect(session).toMatchObject({
      unknownTokenEntries: 1,
      unknownCostEntries: 1,
      missingEntries: 1,
    });
    expect(unknown).not.toHaveProperty('totalTokens');
    expect(unknown).not.toHaveProperty('costUsd');
  });

  it('limits model buckets to the top eight by total tokens', () => {
    const entries = Array.from({ length: 10 }, (_, index) => ({
      ...createEntry(index + 1, index + 1),
      model: `model-${index + 1}`,
    }));

    const groups = groupUsageHistory(entries, 'model');

    expect(groups).toHaveLength(8);
    expect(groups[0]?.label).toBe('model-10');
    expect(groups[7]?.label).toBe('model-3');
  });

  it('filters the last 30 days relative to now instead of calendar month boundaries', () => {
    const now = Date.parse('2026-03-12T12:00:00.000Z');
    const entries = [
      {
        ...createEntry(12, 12),
        timestamp: '2026-03-12T12:00:00.000Z',
      },
      {
        ...createEntry(11, 11),
        timestamp: '2026-02-11T12:00:00.000Z',
      },
      {
        ...createEntry(10, 10),
        timestamp: '2026-02-10T11:59:59.000Z',
      },
    ];

    const filtered = filterUsageHistoryByWindow(entries, '30d', now);

    expect(filtered).toHaveLength(2);
    expect(filtered.map((entry) => entry.totalTokens)).toEqual([12, 11]);
  });

  it('clears the stable usage snapshot when a successful refresh returns empty', () => {
    const stable = [createEntry(12, 12)];

    expect(resolveStableUsageHistory(stable, [])).toEqual([]);
  });

  it('can preserve the last stable usage snapshot while a refresh is still in flight', () => {
    const stable = [createEntry(12, 12)];

    expect(resolveStableUsageHistory(stable, [], { preservePreviousOnEmpty: true })).toEqual(stable);
  });

  it('prefers fresh usage entries over the cached snapshot when available', () => {
    const stable = [createEntry(12, 12)];
    const fresh = [createEntry(13, 13)];

    expect(resolveVisibleUsageHistory([], stable)).toEqual([]);
    expect(resolveVisibleUsageHistory([], stable, { preferStableOnEmpty: true })).toEqual(stable);
    expect(resolveVisibleUsageHistory(fresh, stable, { preferStableOnEmpty: true })).toEqual(fresh);
  });

  it('aggregates multiple usage records from one agent session into a single summary', () => {
    const entries: UsageHistoryEntry[] = [
      {
        ...createEntry(12, 20),
        sessionId: 'session-a',
        timestamp: '2026-03-12T12:00:00.000Z',
        inputTokens: 12,
        outputTokens: 8,
        totalTokens: 20,
        costUsd: 0.01,
        inputCostUsd: 0.002,
        outputCostUsd: 0.008,
        sessionMeta: {
          label: 'Usage refactor',
          channel: 'cli',
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
            tools: [{ name: 'shell', count: 1 }],
          },
        },
      },
      {
        ...createEntry(12, 30),
        sessionId: 'session-a',
        timestamp: '2026-03-12T12:02:00.000Z',
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
        costUsd: 0.02,
        inputCostUsd: 0.004,
        outputCostUsd: 0.016,
      },
    ];

    const sessions = aggregateUsageSessions(entries);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sessionId).toBe('session-a');
    expect(sessions[0]?.entries).toHaveLength(2);
    expect(sessions[0]?.totalTokens).toBe(50);
    expect(sessions[0]?.costUsd).toBeCloseTo(0.03);
    expect(sessions[0]?.inputCostUsd).toBeCloseTo(0.006);
    expect(sessions[0]?.outputCostUsd).toBeCloseTo(0.024);
    expect(sessions[0]?.lastTimestamp).toBe('2026-03-12T12:02:00.000Z');
    expect(sessions[0]?.sessionMeta).toEqual(expect.objectContaining({
      label: 'Usage refactor',
      channel: 'cli',
    }));
    expect(sessions[0]?.messageCounts?.total).toBe(4);
    expect(sessions[0]?.toolUsage?.tools[0]).toEqual({ name: 'shell', count: 1 });
  });

  it('keeps identical session ids separated across agents', () => {
    const entries: UsageHistoryEntry[] = [
      {
        ...createEntry(12, 20),
        agentId: 'main',
        sessionId: 'shared-session',
      },
      {
        ...createEntry(12, 30),
        agentId: 'reviewer',
        sessionId: 'shared-session',
      },
    ];

    const sessions = aggregateUsageSessions(entries);

    expect(sessions).toHaveLength(2);
    expect(sessions.map((session) => session.agentId).sort()).toEqual(['main', 'reviewer']);
  });

  it('matches session search against entry content and breakdown metadata', () => {
    const [session] = aggregateUsageSessions([
      {
        ...createEntry(12, 20),
        sessionId: 'session-with-content',
        provider: 'openai',
        content: 'Refactor usage dialog',
      },
    ]);

    expect(session).toBeTruthy();
    expect(matchesUsageSession(session!, 'dialog')).toBe(true);
    expect(matchesUsageSession(session!, 'openai')).toBe(true);
    expect(matchesUsageSession(session!, 'missing')).toBe(false);
  });
});
