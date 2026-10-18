import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, subscribeEvents } from '../api';
import type { TodayWire, WaitingRunWire, WorkQueueEntry } from '@asf/shared';
import { useMe } from '../useMe';
import { PAGE, gateTitle, queueModeLabel } from '../words';
import { comingUpText } from '../coming-up';
import { MiniHive } from './MiniHive';

/**
 * The "Now and next" block at the top of Activity (it was the Today page). Its buckets
 * answer "what needs me, what is the factory doing, and what will it do next":
 *   Waiting on you · Working on now · Up next (+ Coming up).
 * What got done is the "All work" list below it. It refreshes on every run event
 * so a gate that opens or a run that finishes moves buckets without a reload.
 */
export function ActiveWork() {
  const navigate = useNavigate();
  const [data, setData] = useState<TodayWire | null>(null);
  const me = useMe();
  const load = () => api.today().then(setData).catch(() => {});
  useEffect(() => { load(); return subscribeEvents(() => load()); }, []);

  if (!data) return <div className="muted" style={{ marginBottom: 16 }}>Loading…</div>;
  const { waitingOnYou, running, queued } = data;
  const comingUp = data.comingUp ?? []; // older apis send no comingUp

  const decide = async (gateId: string, decision: 'approve' | 'reject') => {
    await api.resolveGate(gateId, decision, me.user).catch(() => {});
    load();
  };
  const dequeue = async (id: string) => { await api.removeQueueEntry(id).catch(() => {}); load(); };

  return (
    <div>
      <h3>Now and next</h3>
      <Section title="Waiting on you" count={waitingOnYou.length} accent>
        {waitingOnYou.length === 0 && <Empty>Nothing needs you right now.</Empty>}
        {waitingOnYou.map((w) => <WaitingRow key={w.run.id} w={w} onDecide={decide} />)}
      </Section>

      <Section title="Working on now" count={running.length}>
        {running.length === 0 && <Empty>Nothing is being worked on.</Empty>}
        {running.map((r) => (
          <div key={r.id} className="row between clickable" style={rowStyle} onClick={() => navigate(`/run/${r.id}`)}>
            <span className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
              <span><span className="mono">{r.ticketKey}</span> <span className="muted">· {r.teamName}</span></span>
              <span className="muted" style={{ fontSize: 13 }}><MiniHive run={r} /></span>
            </span>
            <span className="muted">${r.costUsd.toFixed(2)} · started {r.startedAt ? new Date(r.startedAt).toLocaleTimeString() : '—'}</span>
          </div>
        ))}
      </Section>

      <Section title={PAGE.upNext} count={queued.length}>
        {queued.length === 0 && <Empty>Nothing lined up. Pick tickets from <Link to="/backlog">{PAGE.todo}</Link>.</Empty>}
        {queued.map((q, i) => <QueueRow key={q.id} q={q} n={i + 1} onRemove={dequeue} />)}
      </Section>
      {comingUp.length > 0 && (
        <div className="muted" style={{ fontSize: 13, margin: '-8px 0 16px' }}>
          <Link to="/recurring">Coming up:</Link> {comingUpText(comingUp, new Date())}
        </div>
      )}
    </div>
  );
}

const rowStyle = { padding: '10px 14px', borderTop: '1px solid var(--border, #eee)' } as const;

function Section({ title, count, accent, children }: { title: string; count: number; accent?: boolean; children: React.ReactNode }) {
  return (
    <div className="card" style={{ padding: 0, marginBottom: 16, ...(accent && count > 0 ? { outline: '2px solid #c96442' } : {}) }}>
      <div className="row between" style={{ padding: '10px 14px', fontWeight: 600 }}>
        <span>{title}</span><span className="muted">{count}</span>
      </div>
      {children}
    </div>
  );
}
function Empty({ children }: { children: React.ReactNode }) {
  return <div className="muted" style={{ padding: '14px', borderTop: '1px solid var(--border, #eee)' }}>{children}</div>;
}

function WaitingRow({ w, onDecide }: { w: WaitingRunWire; onDecide: (gateId: string, d: 'approve' | 'reject') => void }) {
  const navigate = useNavigate();
  return (
    <div className="row between" style={rowStyle}>
      <span className="clickable" onClick={() => navigate(`/run/${w.run.id}`)}>
        <span className="mono">{w.run.ticketKey}</span>{' '}
        {w.reason === 'gate'
          ? <span className="muted">· {w.gateName ? gateTitle(w.gateName) : 'Needs your approval'}</span>
          : <span className="muted">· the AI has a question for you</span>}
      </span>
      {w.reason === 'gate' && w.gateId ? (
        <span className="row">
          <button className="btn good" onClick={() => onDecide(w.gateId!, 'approve')}>Approve</button>
          <button className="btn bad" onClick={() => onDecide(w.gateId!, 'reject')}>Reject</button>
        </span>
      ) : (
        <button className="btn ghost" onClick={() => navigate(`/run/${w.run.id}`)}>Open</button>
      )}
    </div>
  );
}

function QueueRow({ q, n, onRemove }: { q: WorkQueueEntry; n: number; onRemove: (id: string) => void }) {
  return (
    <div className="row between" style={rowStyle}>
      <span><span className="muted">{n}.</span> <span className="mono">{q.ticketKey}</span> <span className="pill">{queueModeLabel(q.mode)}</span>
        {q.dependsOn.length > 0 && <span className="muted" style={{ fontSize: 13 }}> · waits for {q.dependsOn.length} earlier part{q.dependsOn.length === 1 ? '' : 's'} to merge</span>}</span>
      <button className="btn ghost" onClick={() => onRemove(q.id)}>Remove</button>
    </div>
  );
}
