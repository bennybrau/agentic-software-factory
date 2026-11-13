import type { Run } from '@asf/shared';
import { durationText } from './duration-words';

/**
 * The Activity page's "Took" column (#133): how long a run took, or "… so far" while it is
 * still going. A stale run never gets a finishedAt (the sweeper only marks it stale), so it
 * is measured to its last event instead.
 */
type TookRun = Pick<Run, 'state' | 'startedAt' | 'finishedAt' | 'lastEventAt'>;

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'halted']);

/** True while the run's "so far" figure keeps growing. */
export function tookIsLive(run: Pick<Run, 'state' | 'startedAt'>): boolean {
  return !!run.startedAt && !TERMINAL.has(run.state) && run.state !== 'stale';
}

export function tookText(run: TookRun, now = Date.now()): string {
  const start = run.startedAt ? Date.parse(run.startedAt) : NaN;
  if (Number.isNaN(start)) return '—';
  const until = (iso: string | null) => {
    const end = iso ? Date.parse(iso) : NaN;
    return Number.isNaN(end) ? '—' : durationText(end - start);
  };
  if (run.finishedAt) return until(run.finishedAt);
  if (run.state === 'stale') return until(run.lastEventAt);
  if (TERMINAL.has(run.state)) return '—';
  return `${durationText(now - start)} so far`;
}
