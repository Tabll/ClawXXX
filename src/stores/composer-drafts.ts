import { create } from 'zustand';
import type { SetStateAction } from 'react';
import type { QuickAccessSkill } from '@/types/skill';

export interface ComposerAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  stagedPath: string;
  preview: string | null;
  status: 'staging' | 'ready' | 'error';
  error?: string;
}

export type ComposerSelection = {
  start: number;
  end: number;
  direction: 'forward' | 'backward' | 'none';
};

export type ComposerDraft = {
  text: string;
  attachments: ComposerAttachment[];
  targetAgentId: string | null;
  selectedSkill: QuickAccessSkill | null;
  selection: ComposerSelection | null;
};

export const EMPTY_COMPOSER_DRAFT: ComposerDraft = {
  text: '', attachments: [], targetAgentId: null, selectedSkill: null, selection: null,
};

type ComposerDraftState = {
  drafts: Record<string, ComposerDraft>;
  generations: Record<string, number>;
  setField<K extends keyof ComposerDraft>(
    conversationId: string, generation: number, field: K, update: SetStateAction<ComposerDraft[K]>,
  ): void;
  removeDraft(conversationId: string): void;
};

/** Ephemeral UI drafts only. Canonical Conversation ids survive kernel changes. */
export const useComposerDraftStore = create<ComposerDraftState>((set) => ({
  drafts: {},
  generations: {},
  setField: (conversationId, generation, field, update) => {
    if (!conversationId) return;
    set(state => {
      if ((state.generations[conversationId] ?? 0) !== generation) return state;
      const draft = state.drafts[conversationId] ?? EMPTY_COMPOSER_DRAFT;
      const value = typeof update === 'function' ? update(draft[field]) : update;
      if (Object.is(value, draft[field])) return state;
      return { drafts: { ...state.drafts, [conversationId]: { ...draft, [field]: value } } };
    });
  },
  removeDraft: (conversationId) => set(state => {
    const drafts = { ...state.drafts };
    delete drafts[conversationId];
    return {
      drafts,
      // Reject attachment/voice callbacks still holding the deleted draft's lease.
      generations: { ...state.generations, [conversationId]: (state.generations[conversationId] ?? 0) + 1 },
    };
  }),
}));
