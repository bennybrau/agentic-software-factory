import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, subscribeEvents } from '../api';
import type { Run } from '@asf/shared';
import { PAGE as TITLES, OUTCOME_LABEL, runStateLabel } from '../words';
import { runResultLabel } from '../review-view';
import { ActiveWork } from '../components/ActiveWork';

const RUN_STATES = ['queued', 'running', 'awaiting_checkpoint', 'succeeded', 'failed', 'cancelled', 'stale', 'halted'];
const OUTCOMES = Object.entries(OUTCOME_LABEL).map(([v, label]) => ({ v, label }));
const RANGES: Array<{ v: string; label: string; days: number | null }> = [
  { v: '7', label: 'Last 7 days', days: 7 },
  { v: '30', label: 'Last 30 days', days: 30 },
  { v: '90', label: 'Last 90 days', days: 90 },
  { v: 'all', label: 'All time', days: null },
];
const PAGE = 25;

function sinceFor(rangeV: string): string | undefined {
  const r = RANGES.find((x) => x.v === rangeV);
  if (!r || r.days == null) return undefined;
  return new Date(Date.now() - r.days * 86_400_000).toISOString();
}

export function Runs() {
  const navigate = useNavigate();
  const [runs, setRuns] = useState<Run[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [state, setState] = useState('');
  const [team, setTeam] = useState('');
  const [outcome, setOutcome] = useState('');
  const [search, setSearch] = useState('');
  const [range, setRange] = useState('30'); // default: last 30 days — legacy runs drop off
  const [loading, setLoading] = useState(false);

  const query = useMemo(() => ({
    state: state || undefined, teamName: team || undefined, deliveryOutcome: outcome || undefined,
    search: search.trim() || undefined, since: sinceFor(range), limit: PAGE, offset,
  }), [state, team, outcome, search, range, offset]);

  const load = useCallback(() => {
    setLoading(true);
    api.runs(query).then((d) => { setRuns(d.runs); setTotal(d.total); }).catch(() => {}).finally(() => setLoading(false));
  }, [query]);
  // Reload whenever a filter or the page changes; SSE also refreshes the current view.
  useEffect(() => { load(); return subscribeEvents(() => load()); }, [load]);
  // Any filter change resets to page 1.
  const resetTo = (setter: (v: string) => void) => (v: string) => { setter(v); setOffset(0); };

  // Team options: distinct teams on the current page plus the always-present default.
  const teamOptions = useMemo(() => Array.from(new Set(runs.map((r) => r.teamName).filter(Boolean))).sort(), [runs]);

  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + runs.length, total);
  const hasPrev = offset > 0;
  const hasNext = offset + PAGE < total;

  return (
    <div>
      <h2>{TITLES.activity}</h2>
      <div className="muted" style={{ marginBottom: 12 }}>What the factory is doing now, what's up next, and what it has finished.</div>
      <ActiveWork />

      <div className="row between" style={{ marginBottom: 12 }}>
        <h3 style={{ margin: 0 }}>All work</h3>
        <span className="muted">{total > 0 ? `${from}–${to} of ${total}` : loading ? 'Loading…' : 'Nothing yet'}</span>
      </div>

      <div className="card row" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        <input placeholder="Search ticket key…" value={search} onChange={(e) => resetTo(setSearch)(e.target.value)} style={{ width: '100%', maxWidth: 180 }} />
        <select value={state} onChange={(e) => resetTo(setState)(e.target.value)}>
          <option value="">Any status</option>
          {RUN_STATES.map((s) => <option key={s} value={s}>{runStateLabel(s)}</option>)}
        </select>
        <select value={team} onChange={(e) => resetTo(setTeam)(e.target.value)}>
          <option value="">All teams</option>
          {teamOptions.map((t) => <option key={t} value={t}>{t}</option>)}
          {team && !teamOptions.includes(team) && <option value={team}>{team}</option>}
        </select>
        <select value={outcome} onChange={(e) => resetTo(setOutcome)(e.target.value)}>
          <option value="">Any result</option>
          {OUTCOMES.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
        </select>
        <select value={range} onChange={(e) => resetTo(setRange)(e.target.value)}>
          {RANGES.map((r) => <option key={r.v} value={r.v}>{r.label}</option>)}
        </select>
        {(state || team || outcome || search || range !== '30') && (
          <button className="btn ghost" onClick={() => { setState(''); setTeam(''); setOutcome(''); setSearch(''); setRange('30'); setOffset(0); }}>Reset</button>
        )}
      </div>

      <div className="card table-wrap" style={{ padding: 0 }}>
        <table>
          <thead><tr><th>Ticket</th><th>Status</th><th>Team</th><th>Result</th><th>Cost</th><th>Started</th></tr></thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} className="clickable" onClick={() => navigate(`/run/${r.id}`)}>
                <td className="mono">{r.ticketKey}</td>
                <td><span className={`pill ${r.state}`}>{runStateLabel(r.state)}</span></td>
                <td className="muted">{r.teamName}</td>
                <td className="muted">{runResultLabel(r)}</td>
                <td className="muted">${r.costUsd.toFixed(2)}</td>
                <td className="muted">{r.startedAt ? new Date(r.startedAt).toLocaleString() : '—'}</td>
              </tr>
            ))}
            {runs.length === 0 && <tr><td colSpan={6} className="muted" style={{ padding: 24, textAlign: 'center' }}>{loading ? 'Loading…' : 'Nothing matches these filters.'}</td></tr>}
          </tbody>
        </table>
      </div>

      {(hasPrev || hasNext) && (
        <div className="row between" style={{ marginTop: 12 }}>
          <button className="btn ghost" disabled={!hasPrev} onClick={() => setOffset(Math.max(0, offset - PAGE))}>← Prev</button>
          <span className="muted">{from}–{to} of {total}</span>
          <span className="row">
            <button className="btn ghost" disabled={!hasNext} onClick={() => setOffset(offset + PAGE)}>Next →</button>
          </span>
        </div>
      )}
    </div>
  );
}
