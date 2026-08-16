import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AcpAssistantHoverBar } from '@/pages/Chat/AcpMessageSegment';
import {
  alignAssistantMessageMetadata,
  applyAssistantMessageMetadata,
} from '@/lib/acp/assistant-metadata';
import type { AcpTimelineSnapshot } from '@/lib/acp/timeline-types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: (key: string, values?: Record<string, unknown>) => {
      const labels: Record<string, string> = {
        'acp.copy': 'Copy response',
        'acp.copied': 'Copied',
        'acp.metadata.input': `In ${String(values?.count ?? '')}`,
        'acp.metadata.output': `Out ${String(values?.count ?? '')}`,
        'acp.metadata.cache': `Cache ${String(values?.count ?? '')}`,
      };
      return labels[key] ?? key;
    },
  }),
}));

function snapshot(): AcpTimelineSnapshot {
  return {
    sessionId: 'agent:main:metadata',
    loadGeneration: 1,
    itemOrder: ['user-1:0', 'assistant-1:0', 'user-2:0', 'assistant-2:0'],
    itemsById: {
      'user-1:0': {
        kind: 'message-segment',
        id: 'user-1:0',
        role: 'user',
        messageId: 'user-1',
        segmentIndex: 0,
        parts: [{ kind: 'markdown', text: 'Repeat this' }],
      },
      'assistant-1:0': {
        kind: 'message-segment',
        id: 'assistant-1:0',
        role: 'assistant',
        messageId: 'assistant-1',
        segmentIndex: 0,
        parts: [{ kind: 'markdown', text: 'First answer' }],
      },
      'user-2:0': {
        kind: 'message-segment',
        id: 'user-2:0',
        role: 'user',
        messageId: 'user-2',
        segmentIndex: 0,
        parts: [{ kind: 'markdown', text: 'Repeat this' }],
      },
      'assistant-2:0': {
        kind: 'message-segment',
        id: 'assistant-2:0',
        role: 'assistant',
        messageId: 'assistant-2',
        segmentIndex: 0,
        parts: [{ kind: 'markdown', text: 'Second answer' }],
      },
    },
    metadata: {},
    openMessageSegments: {},
    segmentCounts: {},
  };
}

describe('ACP assistant metadata supplement', () => {
  it('aligns repeated transcript turns by user occurrence and assistant content', () => {
    const aligned = alignAssistantMessageMetadata(snapshot(), [
      { role: 'user', content: 'Repeat this' },
      {
        role: 'assistant',
        content: 'First answer\nMEDIA: /tmp/first.png',
        timestamp: 1_700_000_000,
        provider: 'openai',
        model: 'gpt-5.5',
        usage: { input: 100, output: 20, cacheRead: 10, cacheWrite: 5 },
      },
      { role: 'user', content: 'Repeat this' },
      {
        role: 'assistant',
        content: 'Second answer',
        timestamp: 1_800_000_000_000,
        modelRef: 'anthropic/claude-opus',
        usage: { input_tokens: 200, output_tokens: 40, cache_read_tokens: 30 },
      },
    ]);

    expect(aligned['assistant-1:0']).toEqual({
      timestamp: 1_700_000_000_000,
      provider: 'openai',
      model: 'gpt-5.5',
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 10, cacheWriteTokens: 5 },
    });
    expect(aligned['assistant-2:0']).toEqual({
      timestamp: 1_800_000_000_000,
      model: 'anthropic/claude-opus',
      usage: { inputTokens: 200, outputTokens: 40, cacheReadTokens: 30 },
    });

    const projected = applyAssistantMessageMetadata(snapshot(), aligned);
    expect(projected.itemsById['assistant-1:0']).toMatchObject({ assistantMetadata: aligned['assistant-1:0'] });
    expect(projected.itemsById['user-1:0']).not.toHaveProperty('assistantMetadata');
  });

  it('renders full timestamp, model, and token details beside the copy action', () => {
    render(
      <AcpAssistantHoverBar
        text="Answer"
        metadata={{
          timestamp: Date.UTC(2026, 7, 16, 12, 30, 45),
          provider: 'openai',
          model: 'gpt-5.6',
          usage: { inputTokens: 12_000, outputTokens: 640, cacheReadTokens: 2_000, cacheWriteTokens: 500 },
        }}
      />,
    );

    const metadata = screen.getByTestId('acp-assistant-metadata');
    expect(metadata).toHaveTextContent('openai/gpt-5.6');
    expect(metadata).toHaveTextContent(/12K/);
    expect(metadata).toHaveTextContent(/640/);
    expect(metadata).toHaveTextContent(/2.5K/);
    expect(metadata.querySelector('[title]')).toBeTruthy();
  });
});
