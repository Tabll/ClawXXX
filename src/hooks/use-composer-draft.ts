import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { EMPTY_COMPOSER_DRAFT, useComposerDraftStore, type ComposerDraft } from '@/stores/composer-drafts';

/** The composer subtree is keyed by Conversation, so callbacks retain their owner. */
export function useComposerDraftField<K extends keyof ComposerDraft>(
  conversationId: string | undefined,
  field: K,
): [ComposerDraft[K], Dispatch<SetStateAction<ComposerDraft[K]>>] {
  const [local, setLocal] = useState<ComposerDraft[K]>(EMPTY_COMPOSER_DRAFT[field]);
  const generation = useRef(conversationId
    ? useComposerDraftStore.getState().generations[conversationId] ?? 0
    : 0).current;
  const value = useComposerDraftStore(state => (
    conversationId ? (state.drafts[conversationId] ?? EMPTY_COMPOSER_DRAFT)[field] : EMPTY_COMPOSER_DRAFT[field]
  ));
  const setValue = useCallback((update: SetStateAction<ComposerDraft[K]>) => {
    if (conversationId) useComposerDraftStore.getState().setField(conversationId, generation, field, update);
    else setLocal(update);
  }, [conversationId, field, generation]);
  return [conversationId ? value : local, setValue];
}
