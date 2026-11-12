import type { ReviewThread } from '@asf/shared';
import type { ReviewThreadsWire } from './api';

export interface ButtonState { label: string; disabled: boolean; reason: string | null }

const LABEL = 'Address review comments';

/** The button for a review-threads response: null = still loading, 'error' = the fetch failed. */
export function buttonState(res: ReviewThreadsWire | 'error' | null): ButtonState {
  if (res === null) return { label: LABEL, disabled: true, reason: null };
  if (res === 'error') return { label: LABEL, disabled: true, reason: "Couldn't read review threads" };
  const label = `${LABEL} (${res.threads.length})`;
  if (!res.eligible) return { label, disabled: true, reason: capitalise(res.reason ?? 'not available on this run') };
  return { label, disabled: false, reason: null };
}

function capitalise(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/** What Confirm sends: the ids still ticked, in thread order, and the note trimmed (left out when blank). */
export function addressPayload(threads: ReviewThread[], unticked: Set<string>, note: string): { threadIds: string[]; note?: string } {
  const threadIds = threads.map((t) => t.id).filter((id) => !unticked.has(id));
  const n = note.trim();
  return n ? { threadIds, note: n } : { threadIds };
}

/** The first `lines` lines of a comment body, and whether anything was cut. */
export function clip(body: string, lines = 3): { text: string; clipped: boolean } {
  const all = body.trimEnd().split('\n');
  if (all.length <= lines) return { text: all.join('\n'), clipped: false };
  return { text: all.slice(0, lines).join('\n'), clipped: true };
}

/** Where a thread sits in the diff: `path:line`, `path`, or '' for a general comment. */
export function where(t: Pick<ReviewThread, 'path' | 'line'>): string {
  if (!t.path) return '';
  return t.line != null ? `${t.path}:${t.line}` : t.path;
}
