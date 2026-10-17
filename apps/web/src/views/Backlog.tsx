import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AdhocTask, TicketScope, TicketSprint } from '@asf/shared';
import { keyPrefixes, looksLikeTicketRef, ticketMatches } from '@asf/shared/ui';
import { api, encodeTicketId, type TicketRow } from '../api';
import { useQuery } from '@tanstack/react-query';
import { removeAdhoc } from '../new-task';
import { NoRepo } from './Dispatch';
import { PAGE as TITLES, bucketLabel, queueModeLabel } from '../words';

// Done is excluded from the default load; the bucket sub-filter is over active work only.
const BUCKETS = ['backlog', 'inflight', 'review'];
const PAGE = 10;
const DONE_WINDOW_DAYS = 7;

// The user's scope selection persists between sessions so a team's default sticks.
const LS_KEY = 'asf.backlog.filters';
type Filters = { team: string; scope: string; sprint: string; status: string[] };
function loadFilters(): Filters {
  try {
    const v = JSON.parse(localStorage.getItem(LS_KEY) ?? '') as Partial<Filters>;
    return { team: v.team ?? '', scope: v.scope ?? '', sprint: v.sprint ?? '', status: Array.isArray(v.status) ? v.status : [] };
  } catch { return { team: '', scope: '', sprint: '', status: [] }; }
}

export function Backlog() {
  const navigate = useNavigate();
  const [tickets, setTickets] = useState<TicketRow[]>([]);   // active only (done excluded server-side)
  const [loading, setLoading] = useState(true);              // active load in flight (starts true: we fetch on mount)
  const [search, setSearch] = useState('');
  const [bucket, setBucket] = useState(''); // '' = all active buckets
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Nothing can start until there is a repository to put the work in (the api refuses too).
  const { data: readiness } = useQuery({ queryKey: ['start-readiness'], queryFn: api.startReadiness, refetchInterval: 30_000 });
  const blocked = readiness && !readiness.ok ? readiness : null;
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Ad-hoc tasks added here (no tracker ticket), shown above the board.
  const [adhoc, setAdhoc] = useState<AdhocTask[]>([]);
  const loadAdhoc = () => api.listAdhoc().then((d) => setAdhoc(d.tasks)).catch(() => {});
  useEffect(() => { loadAdhoc(); }, []);

  // Done is fetched lazily and only for the recent window, on demand.
  const [showDone, setShowDone] = useState(false);
  const [done, setDone] = useState<TicketRow[]>([]);
  const [doneLoading, setDoneLoading] = useState(false);

  // Scope discovery (empty when the tracker doesn't support boards).
  const [scopes, setScopes] = useState<TicketScope[]>([]);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [sprints, setSprints] = useState<TicketSprint[]>([]);
  const [team, setTeam] = useState('');
  const [scope, setScope] = useState('');       // selected board/project id ('' = all in team/scope)
  const [sprint, setSprint] = useState('');      // '' = all board issues, 'active', 'backlog', or a sprint id
  const [statusSel, setStatusSel] = useState<Set<string>>(new Set());

  const selectedScope = useMemo(() => scopes.find((s) => s.id === scope), [scopes, scope]);
  const isScrum = selectedScope?.kind === 'board' && selectedScope.boardType === 'scrum';
  const teams = useMemo(() => [...new Set(scopes.map((s) => s.team).filter((t): t is string => Boolean(t)))], [scopes]);
  const boardOptions = useMemo(() => (team ? scopes.filter((s) => s.team === team) : scopes), [scopes, team]);

  const scopeIds = useMemo(() => {
    if (scope) return [scope];
    if (team) return scopes.filter((s) => s.team === team).map((s) => s.id);
    return [];
  }, [scope, team, scopes]);

  // Discover scopes + statuses once, then restore the persisted selection (validated against what exists now).
  useEffect(() => {
    void api.ticketStatuses().then(setStatuses).catch(() => setStatuses([]));
    void api.ticketScopes().then((sc) => {
      setScopes(sc);
      const f = loadFilters();
      const validScope = sc.some((s) => s.id === f.scope) ? f.scope : '';
      setScope(validScope);
      setTeam(validScope ? (sc.find((s) => s.id === validScope)?.team ?? '') : (f.team && sc.some((s) => s.team === f.team) ? f.team : ''));
      setSprint(f.sprint);
      setStatusSel(new Set(f.status));
    }).catch(() => setScopes([]));
  }, []);

  // Load the sprint list for a Scrum board; drop a persisted sprint id that no longer exists back to 'active'.
  useEffect(() => {
    if (!isScrum || !scope) { setSprints([]); return; }
    let alive = true;
    void api.ticketSprints(scope).then((sp) => {
      if (!alive) return;
      setSprints(sp);
      setSprint((cur) => (['', 'active', 'backlog'].includes(cur) || sp.some((s) => s.id === cur) ? cur : 'active'));
    }).catch(() => { if (alive) setSprints([]); });
    return () => { alive = false; };
  }, [scope, isScrum]);

  // Persist the selection whenever it changes.
  useEffect(() => {
    localStorage.setItem(LS_KEY, JSON.stringify({ team, scope, sprint, status: [...statusSel] } satisfies Filters));
  }, [team, scope, sprint, statusSel]);

  const statusKey = useMemo(() => [...statusSel].sort().join(','), [statusSel]);
  const scopeQuery = useMemo(() => ({
    scope: scopeIds,
    sprint: isScrum && sprint ? [sprint] : undefined,
    status: statusSel.size ? [...statusSel] : undefined,
  }), [scopeIds, isScrum, sprint, statusSel]);

  // Active work only — done is excluded server-side so the board doesn't pay to fetch
  // (and ADF-convert) finished issues. Search/bucket/paging are client-side over this set.
  const load = () => {
    setLoading(true); setErr(null);
    return api.tickets({ ...scopeQuery, excludeDone: true, limit: 200 })
      .then((d) => { setTickets(d.tickets); setPage(0); })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [scope, team, sprint, statusKey, scopes]);

  // Done, fetched only when asked and only for the recent window.
  useEffect(() => {
    if (!showDone) { setDone([]); return; }
    let alive = true;
    setDoneLoading(true);
    api.tickets({ ...scopeQuery, updatedWithinDays: DONE_WINDOW_DAYS, limit: 200 })
      .then((d) => { if (alive) setDone(d.tickets.filter((t) => t.bucket === 'done')); })
      .catch((e) => { if (alive) setErr(String(e)); })
      .finally(() => { if (alive) setDoneLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showDone, scope, team, sprint, statusKey, scopes]);

  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleStatus = (name: string) => setStatusSel((s) => { const n = new Set(s); if (n.has(name)) n.delete(name); else n.add(name); return n; });

  const onTeam = (t: string) => { setTeam(t); setScope(''); setSprint(''); };
  const onBoard = (id: string) => {
    setScope(id);
    const s = scopes.find((x) => x.id === id);
    setSprint(s?.kind === 'board' && s.boardType === 'scrum' ? 'active' : '');
  };

  // Search + bucket filter the already-loaded active set — no round trip per keystroke.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tickets.filter((t) => (!bucket || t.bucket === bucket) && (!q || ticketMatches(t, q)));
  }, [tickets, search, bucket]);

  // A ticket number that isn't in the loaded list (another board/sprint, done, or past
  // the first 200) is looked up in the tracker directly, after a short pause in typing.
  const [elsewhere, setElsewhere] = useState<TicketRow[]>([]);
  const [finding, setFinding] = useState(false);
  useEffect(() => {
    const q = search.trim();
    setElsewhere([]);
    if (!looksLikeTicketRef(q)) { setFinding(false); return; }
    let alive = true;
    setFinding(true);
    const timer = setTimeout(() => {
      api.findTickets(q, keyPrefixes(tickets.map((t) => t.key)))
        .then((d) => { if (alive) setElsewhere(d.tickets.filter((t) => !tickets.some((x) => x.id === t.id))); })
        .catch(() => { if (alive) setElsewhere([]); })
        .finally(() => { if (alive) setFinding(false); });
    }, 300);
    return () => { alive = false; clearTimeout(timer); };
  }, [search, tickets]);
  useEffect(() => { setPage(0); }, [search, bucket]);

  const total = filtered.length;
  const from = total === 0 ? 0 : page * PAGE + 1;
  const to = Math.min((page + 1) * PAGE, total);
  const pageRows = filtered.slice(page * PAGE, (page + 1) * PAGE);
  const hasPrev = page > 0;
  const hasNext = (page + 1) * PAGE < total;

  const queue = async (mode: 'serial' | 'parallel') => {
    const items = filtered.filter((t) => selected.has(t.id)).map((t) => ({ ticketId: t.id, ticketKey: t.key, ticketProvider: '' }));
    const res = await api.enqueue(items, mode);
    if (res.status === 201) {
      setMsg(`Added ${res.body.added ?? 0} to Up next, ${queueModeLabel(mode)}${res.body.skipped ? ` (${res.body.skipped} already there)` : ''}.`);
      setSelected(new Set());
      load();
    } else setErr(res.body.reason ?? `Couldn’t add them (${res.status}).`);
  };

  return (
    <div>
      <div className="row between" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>{TITLES.todo}</h2>
        <span className="row" style={{ gap: 8 }}>
          {teams.length > 0 && (
            <select value={team} onChange={(e) => onTeam(e.target.value)} title="Team">
              <option value="">All teams</option>
              {teams.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          )}
          {scopes.length > 0 && (
            <select value={scope} onChange={(e) => onBoard(e.target.value)} title="Board">
              <option value="">{team ? 'All boards in team' : 'All boards'}</option>
              {boardOptions.map((s) => <option key={s.id} value={s.id}>{s.name}{s.boardType ? ` (${s.boardType})` : ''}</option>)}
            </select>
          )}
          {isScrum && (
            <select value={sprint} onChange={(e) => setSprint(e.target.value)} title="Sprint">
              <option value="active">Active sprint</option>
              <option value="backlog">Not in a sprint</option>
              <option value="">All issues</option>
              {sprints.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.state})</option>)}
            </select>
          )}
          {statuses.length > 0 && (
            <span style={{ position: 'relative' }}>
              <details className="status-filter">
                <summary className="btn ghost" style={{ listStyle: 'none', cursor: 'pointer' }}>
                  {statusSel.size ? `Status (${statusSel.size})` : 'Status'}
                </summary>
                <div className="card" style={{ position: 'absolute', right: 0, zIndex: 10, maxHeight: 260, overflow: 'auto', minWidth: 180 }}>
                  {statusSel.size > 0 && (
                    <button className="btn ghost" style={{ width: '100%', marginBottom: 6 }} onClick={() => setStatusSel(new Set())}>Clear</button>
                  )}
                  {statuses.map((s) => (
                    <label key={s} className="row" style={{ gap: 6, padding: '2px 0' }}>
                      <input type="checkbox" checked={statusSel.has(s)} onChange={() => toggleStatus(s)} /> {s}
                    </label>
                  ))}
                </div>
              </details>
            </span>
          )}
          <select value={bucket} onChange={(e) => setBucket(e.target.value)} title="Where it is on your board">
            <option value="">Anywhere on the board</option>
            {BUCKETS.map((b) => <option key={b} value={b}>{bucketLabel(b)}</option>)}
          </select>
          <input placeholder="Ticket number or title…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: '100%', maxWidth: 220 }} />
          <button className="btn" onClick={() => navigate('/')} title="Describe work that has no ticket in your tracker">New chat</button>
        </span>
      </div>
      {blocked && <NoRepo reason={blocked.reason} link={blocked.link} />}
      {err && <div className="card" style={{ color: 'var(--bad)' }}>{err}</div>}
      {msg && <div className="card" style={{ color: 'var(--good, #2a7)' }}>{msg} <button className="btn ghost" onClick={() => navigate('/runs')}>See {TITLES.history} →</button></div>}

      {selected.size > 0 && (
        <div className="card row between" style={{ marginBottom: 12, alignItems: 'center' }}>
          <span>{selected.size} selected</span>
          <span className="row">
            <button className="btn" disabled={Boolean(blocked)} onClick={() => queue('parallel')} title={blocked ? 'Connect a repository first' : 'Work on all of them at the same time'}>Start all at once</button>
            <button className="btn" disabled={Boolean(blocked)} onClick={() => queue('serial')} title={blocked ? 'Connect a repository first' : 'Finish each one before starting the next'}>Start one at a time</button>
            <button className="btn ghost" onClick={() => setSelected(new Set())}>Clear</button>
          </span>
        </div>
      )}

      {adhoc.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div className="row between" style={{ marginBottom: 6 }}>
            <span className="muted">Added here</span>
          </div>
          <div className="card table-wrap" style={{ padding: 0 }}>
            <table>
              <thead><tr><th>Title</th><th>Added by</th><th></th></tr></thead>
              <tbody>
                {adhoc.map((t) => (
                  <tr key={t.id}>
                    <td>{t.title}</td>
                    <td className="muted">{t.createdBy ?? '—'}</td>
                    <td className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
                      <button className="btn" disabled={Boolean(blocked)} onClick={() => navigate(`/dispatch/${encodeTicketId(t.id)}`)}
                        title={blocked ? 'Connect a repository first' : 'Choose the repository and models, then run it'}>Start</button>
                      <button className="btn ghost" onClick={() => removeAdhoc({ delete: api.deleteAdhoc, refetch: loadAdhoc }, t.id)} title={`Remove from ${TITLES.todo}`}>Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="row between" style={{ marginBottom: 6 }}>
        <span className="muted row" style={{ gap: 6 }}>
          {loading && <span className="spinner" aria-label="Loading" />}
          {loading ? 'Loading tickets…' : total > 0 ? `${from}–${to} of ${total} open` : 'No open tickets'}
        </span>
      </div>
      <div className="card table-wrap" style={{ padding: 0 }}>
        <table>
          <thead><tr><th></th><th>Ticket</th><th>Title</th><th>Where it is</th><th>Priority</th></tr></thead>
          <tbody>
            {pageRows.map((t) => {
              const open = () => navigate(`/dispatch/${encodeTicketId(t.id)}`);
              return (
                <tr key={t.id} className="clickable" tabIndex={0} role="link" onClick={open}
                  onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) open(); }}>
                  <td onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={selected.has(t.id)} onChange={() => toggle(t.id)} /></td>
                  <td className="mono">{t.key}</td>
                  <td>{t.title}</td>
                  <td><span className="pill">{bucketLabel(t.bucket)}</span></td>
                  <td className="muted">{t.priority ?? '—'}</td>
                </tr>
              );
            })}
            {elsewhere.map((t) => {
              const open = () => navigate(`/dispatch/${encodeTicketId(t.id)}`);
              return (
                <tr key={`found:${t.id}`} className="clickable" tabIndex={0} role="link" onClick={open}
                  onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) open(); }}>
                  <td />
                  <td className="mono">{t.key}</td>
                  <td>{t.title} <span className="muted">(not in this view)</span></td>
                  <td><span className={t.bucket === 'done' ? 'pill done' : 'pill'}>{t.bucket === 'done' ? t.status : bucketLabel(t.bucket)}</span></td>
                  <td className="muted">{t.priority ?? '—'}</td>
                </tr>
              );
            })}
            {total === 0 && elsewhere.length === 0 && (
              <tr><td colSpan={5} className="muted" style={{ padding: 32, textAlign: 'center' }}>
                {loading || finding ? <span className="spinner lg" aria-label="Loading" />
                  : search.trim() ? `No ticket matches “${search.trim()}”.` : 'No open tickets.'}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {(hasPrev || hasNext) && (
        <div className="row between" style={{ marginTop: 12 }}>
          <button className="btn ghost" disabled={!hasPrev} onClick={() => setPage(page - 1)}>← Prev</button>
          <span className="muted">{from}–{to} of {total}</span>
          <button className="btn ghost" disabled={!hasNext} onClick={() => setPage(page + 1)}>Next →</button>
        </div>
      )}

      <div className="row" style={{ marginTop: 24, gap: 8, alignItems: 'center' }}>
        <label className="row" style={{ gap: 6 }}>
          <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} />
          Show Done (last {DONE_WINDOW_DAYS} days)
        </label>
        {showDone && <span className="muted">{doneLoading ? 'loading…' : `${done.length} done`}</span>}
      </div>
      {showDone && done.length > 0 && (
        <div className="card table-wrap" style={{ padding: 0, marginTop: 8 }}>
          <table>
            <thead><tr><th>Ticket</th><th>Title</th><th>Status</th></tr></thead>
            <tbody>
              {done.map((t) => (
                <tr key={t.id}>
                  <td className="mono"><a href={t.url} target="_blank" rel="noreferrer">{t.key}</a></td>
                  <td>{t.title}</td>
                  <td><span className="pill done">{t.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
