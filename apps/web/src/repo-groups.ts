import { connectionLabel, parseRef } from '@asf/shared/ui';

/**
 * Several code hosts and trackers (M12 WP5b): which host a repository is on and
 * which tracker a run came from, in words. With one of each the page shows no
 * host or source at all, so a single-provider install looks as it did.
 */

export interface RepoGroup<R> { connection: string; label: string; repos: R[] }

/**
 * The repositories grouped by code host, in `scm` (connection) order. A bare id
 * belongs to the first host. Hosts not in `scm` come last; empty groups are dropped.
 */
export function groupReposByHost<R extends { id: string }>(repos: readonly R[], scm: readonly string[]): RepoGroup<R>[] {
  const groups = new Map<string, R[]>(scm.map((c) => [c, []]));
  for (const r of repos) {
    const c = parseRef(r.id, scm[0] ?? '').connection;
    groups.set(c, [...(groups.get(c) ?? []), r]);
  }
  return [...groups].filter(([, rs]) => rs.length).map(([connection, rs]) => ({ connection, label: connectionLabel(connection), repos: rs }));
}

/** The tracker a run came from, when there are several to tell apart. Ad-hoc tasks have no tracker. */
export function sourceBadge(ticketProvider: string | null | undefined, trackers: readonly string[]): string | null {
  if (!ticketProvider || ticketProvider === 'adhoc' || trackers.length <= 1) return null;
  return connectionLabel(ticketProvider);
}

/** The code host a repository is on, when there are several to tell apart. */
export function hostBadge(repoId: string | null | undefined, scm: readonly string[]): string | null {
  if (!repoId || scm.length <= 1) return null;
  return connectionLabel(parseRef(repoId, scm[0]).connection);
}
