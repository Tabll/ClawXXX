import type { CanonicalGeneratedAttachment } from '@shared/conversations/contracts';
import { createPendingAttachment } from '@/lib/acp/attachments';
import { appendSyntheticAssistantMessage } from '@/lib/acp/reducer';
import type { AcpTimelineSnapshot } from '@/lib/acp/timeline-types';

/** Called only after Main has committed the output Blobs to this Conversation. */
export function appendGeneratedAttachments(
  timeline: AcpTimelineSnapshot,
  input: { userMessageId: string; runId: string; attachments: CanonicalGeneratedAttachment[] },
): AcpTimelineSnapshot {
  if (!input.attachments.length) return timeline;
  const anchor = timeline.itemOrder.findIndex(id => {
    const item = timeline.itemsById[id];
    return item?.kind === 'message-segment' && item.role === 'user' && item.messageId === input.userMessageId;
  });
  if (anchor < 0) return timeline;
  const replaced = new Set(input.attachments.flatMap(value => value.sourceUri ? [value.sourceUri] : []));
  const itemsById = { ...timeline.itemsById };
  for (const id of timeline.itemOrder.slice(anchor + 1)) {
    const item = itemsById[id];
    if (item?.kind !== 'message-segment') continue;
    if (item.role === 'user') break;
    itemsById[id] = { ...item, parts: item.parts.filter(part => (
      part.kind === 'attachment' ? !replaced.has(part.reference.uri)
        : part.kind === 'image' ? !replaced.has(part.source) : true
    )) };
  }
  const messageId = `${input.runId}:generated`;
  return appendSyntheticAssistantMessage({ ...timeline, itemsById }, {
    messageId, evidenceId: input.runId, source: 'canonical-output',
    parts: input.attachments.map((attachment, blockIndex) => createPendingAttachment({
      messageId, segmentIndex: 0, blockIndex,
      uri: `clawx-blob://${attachment.blobHash}`,
      name: attachment.name ?? attachment.blockId,
      mimeType: attachment.mimeType,
    })),
  });
}
