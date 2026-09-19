import { describe, expect, it } from 'vitest';
import { normalizeGatewayChatRuntimeEvent } from '@electron/gateway/chat-runtime-events';
import { kernelEventToAcpUpdate } from '@/lib/conversations/acp-projection';
import { applyAcpSessionUpdate, createEmptyAcpTimeline } from '@/lib/acp/reducer';

function notification(status: string, extra = {}) {
  return kernelEventToAcpUpdate({ protocol: 'clawx.kernel/v1', kernelId: 'openclaw', generation: 1,
    conversationId: 'conversation', turnId: 'turn', runId: 'run', eventSeq: 1, emittedAt: '2026-09-19T00:00:00Z',
    event: { kind: 'diagnostic', payload: { category: 'compaction', compactionId: 'run:compact', source: 'runtime', status, ...extra } },
  })!.notification;
}

describe('canonical compaction presentation', () => {
  it('updates one item through live and replayed lifecycle and preserves the final retry value', () => {
    let state = createEmptyAcpTimeline('conversation', 1);
    state = applyAcpSessionUpdate(state, notification('in_progress', { willRetry: false }));
    state = applyAcpSessionUpdate(state, notification('completed', { willRetry: true }), { historical: true });
    expect(state.itemOrder).toEqual(['compaction:run:compact']);
    expect(state.itemsById[state.itemOrder[0]]).toMatchObject({ status: 'completed', willRetry: true, historical: true });
  });
  it('rejects malformed metadata without adding a timeline item', () => {
    const state = createEmptyAcpTimeline('conversation', 1);
    expect(applyAcpSessionUpdate(state, notification('invented')).itemOrder).toEqual([]);
    expect(applyAcpSessionUpdate(state, notification('failed', { reason: 'x'.repeat(501) })).itemOrder).toEqual([]);
  });
  it('maps only explicit native outcomes; skipped compaction is not a failure', () => {
    const native = (data: unknown) => normalizeGatewayChatRuntimeEvent({ stream: 'compaction', runId: 'native', sessionKey: 'managed', data });
    expect(native({ phase: 'end', completed: false, outcome: 'skipped' })).toMatchObject({ status: 'skipped' });
    expect(native({ phase: 'end', completed: false, outcome: 'aborted' })).toMatchObject({ status: 'cancelled' });
    expect(native({ phase: 'end' })).toBeNull();
  });
});
