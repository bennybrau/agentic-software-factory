/** How long a run took (#132), for the run header. */
const FINISHED = ['succeeded', 'failed', 'cancelled', 'halted'];

/** "42 s" under a minute, "13 min" (rounded down), "1 h 5 min", or "2 h" on the hour. */
export function durationText(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

export function isRunFinished(state: string): boolean {
  return FINISHED.includes(state);
}

/** Whether the run's clock still counts up: not finished and not stale (a stale run stopped at its last event). */
export function isRunTicking(state: string): boolean {
  return !isRunFinished(state) && state !== 'stale';
}

/**
 * "Took 13 min" once finished, "Ran for 7 min" (to its last event) when stale, "Running for 4 min"
 * until then; null when it never started or the end time is missing.
 */
export function runDurationText(
  run: { state: string; startedAt: string | null; finishedAt: string | null; lastEventAt: string | null },
  now: number,
): string | null {
  if (!run.startedAt) return null;
  const start = new Date(run.startedAt).getTime();
  if (isRunFinished(run.state)) {
    return run.finishedAt ? `Took ${durationText(new Date(run.finishedAt).getTime() - start)}` : null;
  }
  if (run.state === 'stale') {
    const last = run.lastEventAt ? new Date(run.lastEventAt).getTime() : NaN;
    return Number.isNaN(last) ? null : `Ran for ${durationText(last - start)}`;
  }
  return `Running for ${durationText(now - start)}`;
}
