/**
 * The New chat draft: what's typed in the composer but not sent yet. Kept in
 * sessionStorage, so it survives going to Settings or Activity and back (and a
 * reload), stays in this tab, and is gone when the tab closes. Attachments are
 * not kept: files don't fit in storage.
 *
 * Storage can throw (private mode, disabled storage, quota); every access is
 * guarded, and then the draft just isn't kept.
 */
export const CHAT_DRAFT_KEY = 'asf.chat.draft';

/** The part of Storage this needs (tests pass a Map-backed one). */
export type DraftStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function session(): DraftStore | null {
  try { return typeof sessionStorage === 'undefined' ? null : sessionStorage; } catch { return null; }
}

/** The saved draft, or '' when there is none or storage is unavailable. */
export function loadChatDraft(store: DraftStore | null = session()): string {
  try { return store?.getItem(CHAT_DRAFT_KEY) ?? ''; } catch { return ''; }
}

/** Save the draft; a blank one (only whitespace) is removed, not kept. */
export function saveChatDraft(text: string, store: DraftStore | null = session()): void {
  try {
    if (text.trim()) store?.setItem(CHAT_DRAFT_KEY, text);
    else store?.removeItem(CHAT_DRAFT_KEY);
  } catch { /* storage unavailable or full: the draft just isn't kept */ }
}
