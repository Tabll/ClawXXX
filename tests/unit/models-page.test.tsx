import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenUsageSettings } from '@/components/settings/TokenUsageSettings';

const hostApiFetchMock = vi.fn();
const trackUiEventMock = vi.fn();

const { settingsState } = vi.hoisted(() => ({
  settingsState: {
    devModeUnlocked: false,
  },
}));

vi.mock('@/stores/settings', () => ({
  useSettingsStore: (selector: (state: typeof settingsState) => unknown) => selector(settingsState),
}));

vi.mock('@/lib/host-api', () => ({
  hostApi: {
    usage: {
      recentTokenHistory: () => hostApiFetchMock(),
    },
  },
}));

vi.mock('@/lib/telemetry', () => ({
  trackUiEvent: (...args: unknown[]) => trackUiEventMock(...args),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | { count?: number }) => {
      if (typeof fallback === 'string') return fallback;
      return key;
    },
  }),
}));

function createUsageEntry(totalTokens: number) {
  return {
    timestamp: '2026-04-01T12:00:00.000Z',
    sessionId: `session-${totalTokens}`,
    agentId: 'main',
    model: 'gpt-5',
    provider: 'openai',
    inputTokens: totalTokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens,
  };
}

describe('Token usage settings auto refresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    hostApiFetchMock.mockResolvedValue([createUsageEntry(27)]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('refreshes token usage while the page stays open', async () => {
    render(<TokenUsageSettings />);

    await act(async () => {
      await Promise.resolve();
    });
    expect(hostApiFetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(15_000);
      await Promise.resolve();
    });

    expect(hostApiFetchMock).toHaveBeenCalledTimes(2);
  });
});
