import { nativeId } from '@asf/shared/ui';

/**
 * Which repository each ticket queued from Planned tasks starts in. With several
 * repositories connected, ASF preselects one per ticket (the tracker's own, or the
 * one the ticket names) and a person confirms or picks the rest before anything is
 * queued: a queued run starts unattended, so it never guesses. With one repository
 * there is nothing to choose and nothing is shown.
 */

export interface RepoPreview { ticketId: string; repoId: string | null; reason: string; mentionedRepoIds: string[] }

/** A selected ticket in the confirm panel, with the repository it starts in ('' = not chosen yet). */
export interface QueueChoice { ticketId: string; ticketKey: string; title: string; repoId: string; reason: string }

/** Only ask when there is more than one repository to choose from. */
export function needsRepoConfirm(repoCount: number): boolean {
  return repoCount > 1;
}

/** The panel's rows: each ticket with ASF's suggestion preselected, or blank when it couldn't tell. */
export function initialChoices(tickets: { id: string; key: string; title: string }[], previews: RepoPreview[]): QueueChoice[] {
  // By native id: the browser doesn't know the default connection, so `PROJ-12` and `jira:PROJ-12` are one ticket.
  const byId = new Map(previews.map((p) => [nativeId(p.ticketId), p]));
  return tickets.map((t) => {
    const p = byId.get(nativeId(t.id));
    return { ticketId: t.id, ticketKey: t.key, title: t.title, repoId: p?.repoId ?? '', reason: p?.reason ?? 'Choose the repository.' };
  });
}

/** The tickets that still have no repository: Start stays off until this is empty. */
export function stillNeedRepo(choices: QueueChoice[]): QueueChoice[] {
  return choices.filter((c) => !c.repoId);
}

/** Set one ticket's repository. */
export function chooseRepo(choices: QueueChoice[], ticketId: string, repoId: string): QueueChoice[] {
  return choices.map((c) => (nativeId(c.ticketId) === nativeId(ticketId) ? { ...c, repoId } : c));
}

/** One repository for every ticket, overriding the suggestions. */
export function chooseForAll(choices: QueueChoice[], repoId: string): QueueChoice[] {
  return choices.map((c) => ({ ...c, repoId }));
}

/** What POST /api/queue gets: each ticket with its chosen repository. */
export function queueItems(choices: QueueChoice[]): { ticketId: string; ticketKey: string; ticketProvider: string; repoId: string | null }[] {
  return choices.map((c) => ({ ticketId: c.ticketId, ticketKey: c.ticketKey, ticketProvider: '', repoId: c.repoId || null }));
}
