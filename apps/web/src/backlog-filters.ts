/**
 * The Planned tasks filters, kept in localStorage so they're still set the next
 * time you open the site: team, board, sprint, statuses, where it is on the board,
 * whether done work is shown, and the sort order. The search box is not kept.
 *
 * Team/board/sprint name things in the tracker, which can change between visits,
 * so they're checked against what exists before being applied (restoreScope).
 * Storage can throw (private mode, disabled storage, quota); every access is
 * guarded, and then the filters just aren't kept.
 */
import type { TicketScope } from '@asf/shared';

export const BACKLOG_FILTERS_KEY = 'asf.backlog.filters';
export const BUCKETS = ['backlog', 'inflight', 'review'] as const;
export const SORT_KEYS = ['updated', 'priority', 'key'] as const;
export type SortKey = typeof SORT_KEYS[number];
export type SortDir = 'asc' | 'desc';
/**
 * The direction a column sorts in when you first pick it: newest first, most
 * urgent first (priority 1 is the highest), and ticket numbers counting up.
 */
export const DEFAULT_DIR: Record<SortKey, SortDir> = { updated: 'desc', priority: 'asc', key: 'asc' };

export interface BacklogFilters {
  team: string;
  scope: string;     // board/project id; '' = all
  sprint: string;    // '' = all issues, 'active', 'backlog', or a sprint id
  status: string[];
  bucket: string;    // '' = anywhere on the board, else one of BUCKETS
  showDone: boolean;
  sortBy: SortKey;   // default 'updated' (newest first), the tracker's own order
  sortDir: SortDir;
}

export const NO_FILTERS: BacklogFilters = { team: '', scope: '', sprint: '', status: [], bucket: '', showDone: false, sortBy: 'updated', sortDir: 'desc' };

export type FilterStore = Pick<Storage, 'getItem' | 'setItem'>;

function local(): FilterStore | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** The saved filters, with anything missing or malformed replaced by "no filter". */
export function loadBacklogFilters(store: FilterStore | null = local()): BacklogFilters {
  let v: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(store?.getItem(BACKLOG_FILTERS_KEY) ?? '');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) v = parsed as Record<string, unknown>;
  } catch { /* nothing saved, unreadable, or storage unavailable */ }
  const bucket = str(v.bucket);
  const sortBy = (SORT_KEYS as readonly string[]).includes(str(v.sortBy)) ? str(v.sortBy) as SortKey : NO_FILTERS.sortBy;
  const sortDir: SortDir = v.sortDir === 'asc' || v.sortDir === 'desc' ? v.sortDir : DEFAULT_DIR[sortBy];
  return {
    team: str(v.team),
    scope: str(v.scope),
    sprint: str(v.sprint),
    status: Array.isArray(v.status) ? v.status.filter((s): s is string => typeof s === 'string') : [],
    bucket: (BUCKETS as readonly string[]).includes(bucket) ? bucket : '',
    showDone: v.showDone === true,
    sortBy,
    sortDir,
  };
}

/** Clicking a column header: the same column flips direction, a new one starts at its default. */
export function nextSort(cur: { sortBy: SortKey; sortDir: SortDir }, by: SortKey): { sortBy: SortKey; sortDir: SortDir } {
  if (cur.sortBy === by) return { sortBy: by, sortDir: cur.sortDir === 'asc' ? 'desc' : 'asc' };
  return { sortBy: by, sortDir: DEFAULT_DIR[by] };
}

export interface SortableTicket { key: string; priority: number | null; updatedAt?: string }

const keyCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const time = (iso?: string) => { const t = iso ? Date.parse(iso) : NaN; return Number.isNaN(t) ? null : t; };

/**
 * The tickets in the chosen order, as a new array. Ticket numbers compare
 * naturally (DCP-9 before DCP-10). A ticket with no priority or no date always
 * goes last, whichever way the column is sorted. Ties keep the tracker's order.
 */
export function sortTickets<T extends SortableTicket>(tickets: readonly T[], sortBy: SortKey, sortDir: SortDir): T[] {
  const sign = sortDir === 'asc' ? 1 : -1;
  const value = (t: T): number | string | null =>
    sortBy === 'priority' ? t.priority : sortBy === 'updated' ? time(t.updatedAt) : t.key;
  return tickets
    .map((t, i) => ({ t, i, v: value(t) }))
    .sort((a, b) => {
      if (a.v === null || b.v === null) return a.v === b.v ? a.i - b.i : a.v === null ? 1 : -1;
      const c = typeof a.v === 'string' ? keyCollator.compare(a.v, b.v as string) : a.v - (b.v as number);
      return c !== 0 ? sign * c : a.i - b.i;
    })
    .map((x) => x.t);
}

export function saveBacklogFilters(f: BacklogFilters, store: FilterStore | null = local()): void {
  try { store?.setItem(BACKLOG_FILTERS_KEY, JSON.stringify(f)); } catch { /* storage unavailable or full */ }
}

/**
 * Keeps only the newest of overlapping loads. Each call to the returned function
 * starts a load and hands back `isLatest()`, true until another load starts.
 * The Planned tasks list is refetched whenever a filter changes, and an older,
 * wider request (e.g. all boards) can answer after a newer, narrower one; without
 * this check the stale answer would replace the filtered list.
 */
export function latestOnly(): () => () => boolean {
  let current = 0;
  return () => {
    const id = ++current;
    return () => id === current;
  };
}

/**
 * The saved team/board/sprint, checked against the boards the tracker has now:
 * a board that's gone falls back to all boards (keeping the team if it still
 * exists), and a board's team always wins over a saved team.
 */
export function restoreScope(saved: Pick<BacklogFilters, 'team' | 'scope' | 'sprint'>, scopes: TicketScope[]): Pick<BacklogFilters, 'team' | 'scope' | 'sprint'> {
  const board = scopes.find((s) => s.id === saved.scope);
  if (board) return { team: board.team ?? '', scope: board.id, sprint: saved.sprint };
  const team = saved.team && scopes.some((s) => s.team === saved.team) ? saved.team : '';
  return { team, scope: '', sprint: '' };
}
