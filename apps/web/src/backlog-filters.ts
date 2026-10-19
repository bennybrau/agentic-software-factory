/**
 * The Planned tasks filters, kept in localStorage so they're still set the next
 * time you open the site: team, board, sprint, statuses, where it is on the board,
 * and whether done work is shown. The search box is not kept.
 *
 * Team/board/sprint name things in the tracker, which can change between visits,
 * so they're checked against what exists before being applied (restoreScope).
 * Storage can throw (private mode, disabled storage, quota); every access is
 * guarded, and then the filters just aren't kept.
 */
import type { TicketScope } from '@asf/shared';

export const BACKLOG_FILTERS_KEY = 'asf.backlog.filters';
export const BUCKETS = ['backlog', 'inflight', 'review'] as const;

export interface BacklogFilters {
  team: string;
  scope: string;     // board/project id; '' = all
  sprint: string;    // '' = all issues, 'active', 'backlog', or a sprint id
  status: string[];
  bucket: string;    // '' = anywhere on the board, else one of BUCKETS
  showDone: boolean;
}

export const NO_FILTERS: BacklogFilters = { team: '', scope: '', sprint: '', status: [], bucket: '', showDone: false };

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
  return {
    team: str(v.team),
    scope: str(v.scope),
    sprint: str(v.sprint),
    status: Array.isArray(v.status) ? v.status.filter((s): s is string => typeof s === 'string') : [],
    bucket: (BUCKETS as readonly string[]).includes(bucket) ? bucket : '',
    showDone: v.showDone === true,
  };
}

export function saveBacklogFilters(f: BacklogFilters, store: FilterStore | null = local()): void {
  try { store?.setItem(BACKLOG_FILTERS_KEY, JSON.stringify(f)); } catch { /* storage unavailable or full */ }
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
