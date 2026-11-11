import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RunEvent, RunTask } from '@asf/shared';
import { api } from '../api';
import { buildLines, mergeEvents, reportsActivity, type ActivityLine } from '../activity';

export const NO_ACTIVITY_NOTE = 'This runtime does not report activity.';

const MARK: Partial<Record<ActivityLine['state'], string>> = {
  running: '…', failed: '✕ failed', denied: '⊘ denied', unfinished: 'did not finish',
};
function msText(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * One task's tool calls, a line each (#107). Loads the latest page on mount, then
 * appends the SSE `tool:*` events the page passes in (`sseEvents`, already this
 * task's). When the stream reconnects (`connectEpoch` changes) it fetches what came
 * after the last seq. Follows the tail only while you're scrolled to the bottom.
 */
export function ActivityStrip({ runId, task, worktree, sseEvents, connectEpoch, initialEvents }: {
  runId: string;
  task: RunTask;
  worktree: string | null;
  sseEvents: RunEvent[];
  connectEpoch: number;
  /** Events already in hand, so a static render (tests) shows lines; the mount fetch still runs. */
  initialEvents?: RunEvent[];
}) {
  const reports = reportsActivity(task.runtime);
  const [fetched, setFetched] = useState<RunEvent[]>(initialEvents ?? []);
  const [loaded, setLoaded] = useState(initialEvents !== undefined);
  const [hasEarlier, setHasEarlier] = useState(false);
  const running = task.state === 'running';
  const all = useMemo(() => mergeEvents(fetched, sseEvents), [fetched, sseEvents]);
  const lines = useMemo(() => buildLines(all, { running, worktree, runId }), [all, running, worktree, runId]);
  const lastSeq = useRef(0);
  lastSeq.current = all.length ? all[all.length - 1].seq : 0;

  // The latest page, once.
  useEffect(() => {
    if (!reports) return;
    let live = true;
    api.taskActivity(runId, task.id).then((r) => {
      if (!live) return;
      setFetched((prev) => mergeEvents(prev, r.events));
      setHasEarlier(r.hasEarlier);
    }).catch(() => {}).finally(() => { if (live) setLoaded(true); });
    return () => { live = false; };
  }, [runId, task.id, reports]);

  // After a (re)connect: whatever was missed while the stream was down.
  const firstEpoch = useRef(connectEpoch);
  useEffect(() => {
    if (!reports || connectEpoch === firstEpoch.current) return;
    let live = true;
    api.taskActivity(runId, task.id, { after: lastSeq.current })
      .then((r) => { if (live) setFetched((prev) => mergeEvents(prev, r.events)); })
      .catch(() => {});
    return () => { live = false; };
  }, [connectEpoch, runId, task.id, reports]);

  const showEarlier = () => {
    if (!all.length) return;
    api.taskActivity(runId, task.id, { before: all[0].seq }).then((r) => {
      setFetched((prev) => mergeEvents(r.events, prev));
      setHasEarlier(r.hasEarlier);
    }).catch(() => {});
  };

  // Tail-follow: stick to the bottom only if the reader was already there.
  const box = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  useLayoutEffect(() => {
    if (box.current && atBottom.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines]);
  const onScroll = () => {
    const el = box.current;
    if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
  };

  if (!reports || (loaded && !running && lines.length === 0)) return <div className="activity-note muted">{NO_ACTIVITY_NOTE}</div>;
  if (lines.length === 0) return null;
  return (
    <div className="activity">
      {hasEarlier && <button className="btn ghost sm" onClick={showEarlier}>Show earlier</button>}
      <div className="activity-lines" ref={box} onScroll={onScroll}>
        {lines.map((l) => (
          <div key={l.key} className={`act-line ${l.state}`}>
            <span className="act-kind">{l.kind}</span>
            <span className="mono act-target" title={l.target}>{l.target}</span>
            <span className="muted">{l.ms != null ? msText(l.ms) : ''}</span>
            {MARK[l.state] && <span className="act-mark">{MARK[l.state]}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
