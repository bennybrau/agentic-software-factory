import { useEffect } from 'react';

/**
 * The browser tab title (#134). The layout (useThemeLook) is the only writer of
 * document.title; a page only says which ticket it shows, through this small
 * store, so the title is right whichever loads last, the run or the theme.
 */

/** `PROJ-123 · App` on a page about a ticket, else just the app title. */
export function pageTitle(appTitle: string, ticketKey?: string | null): string {
  const key = ticketKey?.trim();
  return key ? `${key} · ${appTitle}` : appTitle;
}

let subject: string | null = null;
const listeners = new Set<() => void>();

function set(next: string | null): void {
  subject = next;
  for (const fn of listeners) fn();
}

/** The ticket key the current page names, or null. */
export function getPageSubject(): string | null { return subject; }

/** Calls fn whenever the subject changes; returns the unsubscribe. */
export function subscribePageSubject(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * Names `key` as the page's subject. The returned release clears it only while
 * it is still this claim's key, so a late release from run A can't wipe run B.
 */
export function claimPageSubject(key: string | null): () => void {
  set(key);
  return () => { if (subject === key) set(null); };
}

/** For a page component: name this ticket in the tab title while mounted. */
export function usePageSubject(key: string | null): void {
  useEffect(() => claimPageSubject(key), [key]);
}
