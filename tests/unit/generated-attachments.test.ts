import { describe, expect, it } from 'vitest';
import { appendGeneratedAttachments } from '@/lib/conversations/generated-attachments';
import { createPendingAttachment } from '@/lib/acp/attachments';
import { createEmptyAcpTimeline } from '@/lib/acp/reducer';
import type { MessageSegmentItem } from '@/lib/acp/timeline-types';

describe('canonical generated attachment projection', () => {
  it('replaces only the current assistant transient reference and remains idempotent', () => {
    const attachment = createPendingAttachment({ messageId: 'old', segmentIndex: 0, blockIndex: 0, uri: '/workspace/image.png', name: 'image.png' });
    const segment = (id: string, role: 'assistant' | 'user'): MessageSegmentItem => ({ kind: 'message-segment', id, messageId: id, role, segmentIndex: 0, parts: [attachment] });
    const timeline = { ...createEmptyAcpTimeline('conversation', 1), itemOrder: ['old', 'prompt', 'reply'], itemsById: { old: segment('old', 'assistant'), prompt: segment('prompt', 'user'), reply: segment('reply', 'assistant') } };
    const input = { userMessageId: 'prompt', runId: 'run', attachments: [{ blockId: 'output', blobHash: 'a'.repeat(64), mimeType: 'image/png', name: 'image.png', sourceUri: '/workspace/image.png' }] };
    const result = appendGeneratedAttachments(timeline, input);
    expect((result.itemsById.old as MessageSegmentItem).parts).toHaveLength(1);
    expect((result.itemsById.prompt as MessageSegmentItem).parts).toHaveLength(1);
    expect((result.itemsById.reply as MessageSegmentItem).parts).toHaveLength(0);
    expect((result.itemsById['run:generated:0'] as MessageSegmentItem).parts).toMatchObject([{ reference: { uri: `clawx-blob://${'a'.repeat(64)}` } }]);
    expect(appendGeneratedAttachments(result, input)).toEqual(result);
    expect(appendGeneratedAttachments(timeline, { ...input, userMessageId: 'absent' })).toBe(timeline);
  });
});
