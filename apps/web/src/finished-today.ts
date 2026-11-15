import { isTerminal, type Run } from '@asf/shared';

/** Runs that ended (any terminal state, halted included) on `now`'s local calendar day. */
export function finishedTodayCount(runs: Pick<Run, 'state' | 'finishedAt'>[], now: Date): number {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  return runs.filter((r) => {
    if (!isTerminal(r.state) || !r.finishedAt) return false;
    const t = Date.parse(r.finishedAt);
    return t >= start && t < end;
  }).length;
}

/** "N finished today" beside "All work"; nothing when none did. */
export function finishedTodayText(n: number): string | null {
  return n > 0 ? `${n} finished today` : null;
}

/** Milliseconds until the next local midnight, so the count can clear without an event. */
export function msUntilLocalMidnight(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime();
}
