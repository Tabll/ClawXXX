import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { KernelId } from '@shared/kernels/contracts';

type ConversationKernelState = {
  selectedByConversation: Record<string, KernelId>;
  select(conversationId: string, kernelId: KernelId): void;
  forget(conversationId: string): void;
};

/**
 * A local next-run preference only. Run provenance and history remain in
 * canonical SQLite; changing this value never mutates or clears a Conversation.
 */
export const useConversationKernelStore = create<ConversationKernelState>()(
  persist(
    set => ({
      selectedByConversation: {},
      select: (conversationId, kernelId) => set(state => ({
        selectedByConversation: { ...state.selectedByConversation, [conversationId]: kernelId },
      })),
      forget: conversationId => set(state => ({
        selectedByConversation: Object.fromEntries(
          Object.entries(state.selectedByConversation).filter(([id]) => id !== conversationId),
        ),
      })),
    }),
    { name: 'clawx-conversation-next-kernel' },
  ),
);
