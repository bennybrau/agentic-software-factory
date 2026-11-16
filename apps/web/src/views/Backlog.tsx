import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { AdhocTask, TicketScope, TicketSprint, WorkQueueEntry } from '@asf/shared';
import { connectionLabel, keyPrefixes, looksLikeTicketRef, nativeId, ticketMatches } from '@asf/shared/ui';
import { api, encodeTicketId, subscribeEvents, type Fleet, type TicketRow } from '../api';
import { useQuery } from '@tanstack/react-query';
import { removeAdhoc } from '../new-task';
import { BUCKETS, latestOnly, loadBacklogFilters, nextSort, restoreScope, restoreSource, saveBacklogFilters, sortTickets, sourceStatusLine, trackerInEffect, type SortKey, type SourceState } from '../backlog-filters';
import { checkedAgo } from '../updates-view';
import { NoRepo } from './Dispatch';
import { chooseForAll, chooseRepo, initialChoices, needsRepoConfirm, queueItems, stillNeedRepo, type QueueChoice } from '../queue-repos';
import { PAGE as TITLES, bucketLabel, queueModeLabel } from '../words';
import { budgetReachedText, queuePollInterval, refusalFor, upNextCountText, wherePill } from '../refusal-words';
import { AddedHere } from '../components/AddedHere';
import { RepoSelect } from '../components/RepoSelect';

// Done is excluded from the default load; the bucket sub-filter (BUCKETS) is over active work only.
const PAGE = 10;
const DONE_WINDOW_DAYS = 7;

export function Backlog() {
  const navigate = useNavigate();
  const [tickets, setTickets] = useState<TicketRow[]>([]);   // active only (done excluded server-side)
  const [loading, setLoading] = useState(true);              // active load in flight (starts true: we fetch on mount)
  // The filters are kept between visits (backlog-filters.ts). Team/board/sprint wait
  // for the tracker's boards to be checked; the rest apply straight away.
  const [saved] = useState(() => loadBacklogFilters());
  const [search, setSearch] = useState('');
  const [bucket, setBucket] = useState(saved.bucket); // '' = all active buckets
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState({ sortBy: saved.sortBy, sortDir: saved.sortDir });
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

  // Tickets the queue couldn't start (shown in their pill), and whether the monthly budget is spent.
  // A refusal sends no run event, so the queue is checked every few seconds while
  // something waits to start; a run event (the ticket's run starting) or a queue:changed
  // event (an entry refused or dispatched) refetches too, on the one stream connection.
  const { data: today, refetch: refetchToday } = useQuery({ queryKey: ['today'], queryFn: api.today, refetchInterval: (q) => queuePollInterval(q.state.data) });
  const refused = today?.refused ?? []; // older apis send no refused
  const [fleet, setFleet] = useState<Fleet | null>(null);
  const loadRefusals = () => {
    void refetchToday();
    api.fleet().then(setFleet).catch(() => {});
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => subscribeEvents(() => { void refetchToday(); }, undefined, { onQueue: () => loadRefusals() }), [refetchToday]);
  useEffect(() => { api.fleet().then(setFleet).catch(() => {}); }, []);
  const upNextCount = upNextCountText(today?.queued.length ?? 0);
  const budgetLine = fleet ? budgetReachedText(fleet.monthCostUsd, fleet.monthlyBudgetUsd) : null;

  // Done is fetched lazily and only for the recent window, on demand.
  const [showDone, setShowDone] = useState(saved.showDone);
  const [done, setDone] = useState<TicketRow[]>([]);
  const [doneLoading, setDoneLoading] = useState(false);

  // The connected trackers, re-read so one added in Settings shows up without a reload.
  // With one tracker (or an api that doesn't say) the page and its requests are as before;
  // with several there is a Source filter, and All lists each tracker side by side.
  const { data: conns, isSuccess: connsLoaded, isError: connsFailed } = useQuery({ queryKey: ['connections'], queryFn: api.connections, refetchInterval: 30_000 });
  const connsReady = connsLoaded || connsFailed;
  const trackersKey = (conns?.tickets ?? []).join(',');
  const trackers = useMemo(() => (trackersKey ? trackersKey.split(',') : []), [trackersKey]);
  const several = trackers.length > 1;
  const [source, setSource] = useState(saved.source); // '' = all trackers
  // A saved (or chosen) tracker that is no longer connected falls back to All.
  useEffect(() => { if (connsLoaded) setSource((cur) => restoreSource(cur, trackers)); }, [connsLoaded, trackers]);
  const inEffect = trackerInEffect(source, trackers);
  const allSources = several && !inEffect;
  // The tracker discovery asks: only named when several are connected, so one tracker's requests don't change.
  const discoveryConn = several && inEffect ? inEffect : undefined;
  // Which tracker's boards the board/sprint/status state belongs to (null until the trackers are known).
  const discoveryKey = connsReady ? (allSources ? '*' : discoveryConn ?? '') : null;
  const [sourceStates, setSourceStates] = useState<SourceState[]>([]);
  const statusLine = several ? sourceStatusLine(sourceStates) : '';

  // Scope discovery (empty when the tracker doesn't support boards).
  const [scopes, setScopes] = useState<TicketScope[]>([]);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [sprints, setSprints] = useState<TicketSprint[]>([]);
  const [team, setTeam] = useState('');
  const [scope, setScope] = useState('');       // selected board/project id ('' = all in team/scope)
  const [sprint, setSprint] = useState('');      // '' = all board issues, 'active', 'backlog', or a sprint id
  const [statusSel, setStatusSel] = useState<Set<string>>(() => new Set(saved.status));
  // False until the saved team/board/sprint are applied to the tracker in effect: saving
  // before then would overwrite them with the blank starting values. Kept per tracker
  // (discoveryKey), so a change of source waits for that tracker's boards again.
  const [restoredKey, setRestoredKey] = useState<string | null>(null);
  const scopeRestored = discoveryKey !== null && restoredKey === discoveryKey;
  // True once the tracker's boards have been checked (restored, or the tracker
  // didn't answer). Tickets aren't loaded before then: a load with the blank
  // starting board would fetch every board and could answer after the filtered one.
  const [checkedKey, setCheckedKey] = useState<string | null>(null);
  const scopesChecked = discoveryKey !== null && checkedKey === discoveryKey;
  // The last team/board/sprint chosen (or saved), restored against the next tracker's boards.
  const where = useRef({ team: saved.team, scope: saved.scope, sprint: saved.sprint });

  const selectedScope = useMemo(() => scopes.find((s) => s.id === scope), [scopes, scope]);
  const isScrum = selectedScope?.kind === 'board' && selectedScope.boardType === 'scrum';
  const teams = useMemo(() => [...new Set(scopes.map((s) => s.team).filter((t): t is string => Boolean(t)))], [scopes]);
  const boardOptions = useMemo(() => (team ? scopes.filter((s) => s.team === team) : scopes), [scopes, team]);

  const scopeIds = useMemo(() => {
    if (scope) return [scope];
    if (team) return scopes.filter((s) => s.team === team).map((s) => s.id);
    return [];
  }, [scope, team, scopes]);

  // Discover the tracker in effect's scopes, then restore the persisted selection (validated
  // against what exists now). Again whenever the tracker in effect changes. With several
  // trackers listed together there is no one tracker's boards to choose from.
  useEffect(() => {
    if (discoveryKey === null) return;
    if (discoveryKey === '*') {
      setScopes([]); setStatuses([]);
      setRestoredKey(discoveryKey); setCheckedKey(discoveryKey);
      return;
    }
    let alive = true;
    void api.ticketScopes(discoveryConn).then((sc) => {
      if (!alive) return;
      setScopes(sc);
      const r = restoreScope(where.current, sc);
      setTeam(r.team); setScope(r.scope); setSprint(r.sprint);
      setRestoredKey(discoveryKey);
    }).catch(() => { if (alive) setScopes([]); }) // the tracker didn't answer: keep the saved board for next time
      .finally(() => { if (alive) setCheckedKey(discoveryKey); });
    return () => { alive = false; };
  }, [discoveryKey, discoveryConn]);

  // The status choices follow the board selection: one board offers only the
  // statuses on its columns; no single board (all, or a team) offers the union
  // over the configured boards. A checked status the new list doesn't have is
  // dropped, so a hidden filter can't silently empty the board.
  useEffect(() => {
    if (!scopeRestored || allSources) return;
    let alive = true;
    void api.ticketStatuses(scope || undefined, discoveryConn).then((st) => {
      if (!alive) return;
      setStatuses(st);
      // With several trackers, a tracker with no statuses drops the other one's choices too.
      if (st.length || several) setStatusSel((cur) => { const kept = [...cur].filter((x) => st.includes(x)); return kept.length === cur.size ? cur : new Set(kept); });
    }).catch(() => { if (alive) setStatuses([]); });
    return () => { alive = false; };
  }, [scope, scopeRestored, allSources, discoveryConn, several]);

  // Load the sprint list for a Scrum board; drop a persisted sprint id that no longer exists back to 'active'.
  useEffect(() => {
    if (!isScrum || !scope || !scopeRestored) { setSprints([]); return; }
    let alive = true;
    void api.ticketSprints(scope, discoveryConn).then((sp) => {
      if (!alive) return;
      setSprints(sp);
      setSprint((cur) => (['', 'active', 'backlog'].includes(cur) || sp.some((s) => s.id === cur) ? cur : 'active'));
    }).catch(() => { if (alive) setSprints([]); });
    return () => { alive = false; };
  }, [scope, isScrum, scopeRestored, discoveryConn]);

  // Save the filters whenever they change.
  useEffect(() => {
    // A tracker without boards (or All) keeps the last board chosen, for when that tracker is back.
    if (scopeRestored && scopes.length) where.current = { team, scope, sprint };
    saveBacklogFilters({ source, ...where.current, status: [...statusSel], bucket, showDone, ...sort });
  }, [source, scopeRestored, scopes, team, scope, sprint, statusSel, bucket, showDone, sort]);

  const statusKey = useMemo(() => [...statusSel].sort().join(','), [statusSel]);
  // Board, sprint and status belong to one tracker: none apply when several are listed together.
  const scopeQuery = useMemo(() => (allSources ? {} : {
    ...(discoveryConn ? { connection: [discoveryConn] } : {}),
    scope: scopeIds,
    sprint: isScrum && sprint ? [sprint] : undefined,
    status: statusSel.size ? [...statusSel] : undefined,
  }), [allSources, discoveryConn, scopeIds, isScrum, sprint, statusSel]);

  // Active work only — done is excluded server-side so the board doesn't pay to fetch
  // (and ADF-convert) finished issues. Search/bucket/paging are client-side over this set.
  // Only the newest load may update the list: an older one still in flight (an
  // earlier filter) is ignored when it answers.
  const nextLoad = useRef(latestOnly()).current;
  const load = () => {
    const isLatest = nextLoad();
    setLoading(true); setErr(null);
    if (!allSources) {
      if (several && inEffect) setSourceStates([{ connection: inEffect, state: 'loading' }]);
      return api.tickets({ ...scopeQuery, excludeDone: true, limit: 200 })
        .then((d) => {
          if (!isLatest()) return;
          setTickets(d.tickets); setPage(0);
          setSourceStates((d.sources ?? []).map((s): SourceState => (s.ok ? { connection: s.connection, state: 'ok' } : { connection: s.connection, state: 'failed', reason: s.reason ?? 'unknown error' })));
        })
        .catch((e) => { if (isLatest()) { setErr(String(e)); setSourceStates([]); } })
        .finally(() => { if (isLatest()) setLoading(false); });
    }
    // All trackers: one request each, in parallel, so a slow one doesn't hold up the
    // others and a failed one doesn't empty them. Rows merge in connection order.
    const got = new Map<string, TicketRow[]>();
    const states = new Map<string, SourceState>(trackers.map((c) => [c, { connection: c, state: 'loading' }]));
    const show = () => {
      setTickets(trackers.flatMap((c) => got.get(c) ?? []));
      setSourceStates(trackers.map((c) => states.get(c)!));
      setLoading(false);
    };
    setSourceStates([...states.values()]); setPage(0);
    return Promise.all(trackers.map((c) => api.tickets({ connection: [c], excludeDone: true, limit: 200 })
      .then((d) => {
        const s = d.sources?.find((x) => x.connection === c);
        got.set(c, d.tickets);
        states.set(c, s && !s.ok ? { connection: c, state: 'failed', reason: s.reason ?? 'unknown error' } : { connection: c, state: 'ok' });
      })
      .catch((e) => { got.set(c, []); states.set(c, { connection: c, state: 'failed', reason: (e as Error).message }); })
      .finally(() => { if (isLatest()) show(); })));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (scopesChecked) load(); }, [scopesChecked, discoveryKey, trackersKey, scope, team, sprint, statusKey, scopes]);

  // Done, fetched only when asked and only for the recent window.
  useEffect(() => {
    if (!showDone) { setDone([]); return; }
    if (!scopesChecked) return;
    let alive = true;
    setDoneLoading(true);
    api.tickets({ ...scopeQuery, updatedWithinDays: DONE_WINDOW_DAYS, limit: 200 })
      .then((d) => { if (alive) setDone(d.tickets.filter((t) => t.bucket === 'done')); })
      .catch((e) => { if (alive) setErr(String(e)); })
      .finally(() => { if (alive) setDoneLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showDone, scopesChecked, discoveryKey, scope, team, sprint, statusKey, scopes]);

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
    const rows = tickets.filter((t) => (!bucket || t.bucket === bucket) && (!q || ticketMatches(t, q)));
    return sortTickets(rows, sort.sortBy, sort.sortDir);
  }, [tickets, search, bucket, sort]);

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
        // Find looks in every tracker; with a source chosen, only that tracker's answers are shown.
        .then((d) => { if (alive) setElsewhere(d.tickets.filter((t) => (!discoveryConn || t.connection === discoveryConn) && !tickets.some((x) => nativeId(x.id) === nativeId(t.id)))); })
        .catch(() => { if (alive) setElsewhere([]); })
        .finally(() => { if (alive) setFinding(false); });
    }, 300);
    return () => { alive = false; clearTimeout(timer); };
  }, [search, tickets, discoveryConn]);
  useEffect(() => { setPage(0); }, [search, bucket, sort]);

  // A sortable column header: click to sort by it, click again to flip the direction.
  const sortHeader = (by: SortKey, label: string) => {
    const on = sort.sortBy === by;
    return (
      <th aria-sort={on ? (sort.sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}>
        <button type="button" className="th-sort" onClick={() => setSort((s) => nextSort(s, by))} title={`Sort by ${label.toLowerCase()}`}>
          {label}<span aria-hidden="true">{on ? (sort.sortDir === 'asc' ? ' ▲' : ' ▼') : ''}</span>
        </button>
      </th>
    );
  };

  const total = filtered.length;
  const from = total === 0 ? 0 : page * PAGE + 1;
  const to = Math.min((page + 1) * PAGE, total);
  const pageRows = filtered.slice(page * PAGE, (page + 1) * PAGE);
  const hasPrev = page > 0;
  const hasNext = (page + 1) * PAGE < total;

  // With several repositories, each ticket's repository is shown (and the unclear ones
  // chosen) before anything is queued: a queued run starts unattended, so it never guesses.
  const [confirm, setConfirm] = useState<{ mode: 'serial' | 'parallel'; choices: QueueChoice[]; repos: { id: string; path: string }[] } | null>(null);
  const [checking, setChecking] = useState(false);
  const enqueue = async (mode: 'serial' | 'parallel', items: ReturnType<typeof queueItems>) => {
    const res = await api.enqueue(items, mode);
    if (res.status === 201) {
      setMsg(`Added ${res.body.added ?? 0} to Up next, ${queueModeLabel(mode)}${res.body.skipped ? ` (${res.body.skipped} already there)` : ''}.`);
      setSelected(new Set());
      setConfirm(null);
      load();
      loadRefusals();
    } else setErr(res.body.reason ?? `Couldn’t add them (${res.status}).`);
  };
  const queue = async (mode: 'serial' | 'parallel') => {
    setErr(null); setMsg(null);
    const picked = filtered.filter((t) => selected.has(t.id));
    const repos = readiness?.ok ? readiness.repos : [];
    if (!needsRepoConfirm(repos.length)) return enqueue(mode, queueItems(initialChoices(picked, [])));
    setChecking(true);
    try {
      const p = await api.repoPreview(picked.map((t) => t.id));
      setConfirm({ mode, repos: p.repos, choices: initialChoices(picked, p.previews) });
    } catch (e) {
      setErr(`Couldn’t check which repository each ticket goes to: ${(e as Error).message}`);
    } finally { setChecking(false); }
  };
  // A changed selection makes the panel's list stale: ask again on the next Start.
  useEffect(() => { setConfirm(null); }, [selected]);
  const unresolved = confirm ? stillNeedRepo(confirm.choices).length : 0;

  return (
    <div>
      <div className="row between" style={{ marginBottom: 4 }}>
        <span className="row" style={{ gap: 8, alignItems: 'baseline' }}>
          <h2 style={{ margin: 0 }}>{TITLES.todo}</h2>
          {upNextCount && <span className="muted" style={{ whiteSpace: 'nowrap' }}>{upNextCount}</span>}
        </span>
        {/* With a Source select too, the controls wrap rather than widen the page on a phone. */}
        <span className="row" style={several ? { gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' } : { gap: 8 }}>
          {several && (
            <select value={source} onChange={(e) => setSource(e.target.value)} title="Source" aria-label="Source">
              <option value="">All sources</option>
              {trackers.map((c) => <option key={c} value={c}>{connectionLabel(c)}</option>)}
            </select>
          )}
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
      <div className="muted" style={{ marginBottom: 12 }}>Tickets from your trackers and tasks you've written. Pick some and start them.</div>
      {blocked && <NoRepo reason={blocked.reason} link={blocked.link} />}
      {err && <div className="card" style={{ color: 'var(--bad)' }}>{err}</div>}
      {msg && <div className="card" style={{ color: 'var(--good, #2a7)' }}>{msg} <button className="btn ghost" onClick={() => navigate('/runs')}>See {TITLES.activity} →</button></div>}

      {selected.size > 0 && (
        <div className="card row between" style={{ marginBottom: 12, alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          {budgetLine && (
            <div className="muted" style={{ flexBasis: '100%', overflowWrap: 'anywhere' }}>
              {budgetLine} <Link to="/settings#spending">Spending settings</Link>
            </div>
          )}
          <span>{selected.size} selected</span>
          <span className="row" style={{ flexWrap: 'wrap' }}>
            <button className="btn" disabled={Boolean(blocked) || checking || Boolean(confirm)} onClick={() => queue('parallel')} title={blocked ? 'Connect a repository first' : 'Work on all of them at the same time'}>Start all at once</button>
            <button className="btn" disabled={Boolean(blocked) || checking || Boolean(confirm)} onClick={() => queue('serial')} title={blocked ? 'Connect a repository first' : 'Finish each one before starting the next'}>Start one at a time</button>
            <button className="btn ghost" onClick={() => { setSelected(new Set()); setConfirm(null); }}>Clear</button>
          </span>
        </div>
      )}

      {confirm && (
        <div className="card queue-confirm" style={{ marginBottom: 12 }}>
          <div className="row between" style={{ alignItems: 'center', marginBottom: 8 }}>
            <b>Which repository each one works in</b>
            <label className="row" style={{ gap: 6 }}>
              <span className="muted">Use one for all:</span>
              <RepoSelect repos={confirm.repos} scm={conns?.scm ?? []} value="" placeholder="Choose…"
                onChange={(id) => id && setConfirm({ ...confirm, choices: chooseForAll(confirm.choices, id) })} />
            </label>
          </div>
          <table>
            <tbody>
              {confirm.choices.map((c) => (
                <tr key={c.ticketId}>
                  <td className="mono" style={{ whiteSpace: 'nowrap' }}>{c.ticketKey}</td>
                  <td>{c.title}<div className="muted" style={{ fontSize: '0.85em' }}>{c.reason}</div></td>
                  <td style={{ width: '45%' }}>
                    <RepoSelect wide repos={confirm.repos} scm={conns?.scm ?? []} value={c.repoId} aria-label={`Repository for ${c.ticketKey}`}
                      placeholder="Choose a repository…" onChange={(id) => setConfirm({ ...confirm, choices: chooseRepo(confirm.choices, c.ticketId, id) })} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row" style={{ marginTop: 8, gap: 8, alignItems: 'center' }}>
            <button className="btn" disabled={unresolved > 0} onClick={() => enqueue(confirm.mode, queueItems(confirm.choices))}>
              Start {confirm.mode === 'parallel' ? 'all at once' : 'one at a time'}
            </button>
            <button className="btn ghost" onClick={() => setConfirm(null)}>Cancel</button>
            {unresolved > 0 && <span className="muted">Choose a repository for {unresolved === 1 ? '1 ticket' : `${unresolved} tickets`} first.</span>}
          </div>
        </div>
      )}

      <AddedHere tasks={adhoc} repos={readiness?.ok ? readiness.repos : []} refused={refused} blocked={Boolean(blocked)}
        onStart={(id) => navigate(`/dispatch/${encodeTicketId(id)}`)}
        onRemove={(id) => removeAdhoc({ delete: api.deleteAdhoc, refetch: loadAdhoc }, id)} />

      <div className="row between" style={{ marginBottom: 6 }}>
        <span className="muted row" style={{ gap: 6 }}>
          {loading && <span className="spinner" aria-label="Loading" />}
          {loading ? 'Loading tickets…' : total > 0 ? `${from}–${to} of ${total} open` : 'No open tickets'}
          {statusLine && <span className="source-status" style={{ overflowWrap: 'anywhere' }}>· {statusLine}</span>}
        </span>
      </div>
      <div className="card table-wrap" style={{ padding: 0 }}>
        <table className="ticket-table">
          <thead><tr><th></th>{sortHeader('key', 'Ticket')}<th>Title</th><th>Where it is</th>{sortHeader('priority', 'Priority')}{sortHeader('updated', 'Updated')}</tr></thead>
          <tbody>
            {pageRows.map((t) => {
              const open = () => navigate(`/dispatch/${encodeTicketId(t.id)}`);
              return (
                <tr key={t.id} className="clickable" tabIndex={0} role="link" onClick={open}
                  onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) open(); }}>
                  <td onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={selected.has(t.id)} onChange={() => toggle(t.id)} /></td>
                  <td className="mono">{t.key}{several && t.connection && <> <span className="pill source">{connectionLabel(t.connection)}</span></>}</td>
                  <td>{t.title}</td>
                  <td><WherePill bucket={t.bucket} refused={refusalFor(refused, t.id)} /></td>
                  <td className="muted">{t.priority ?? '—'}</td>
                  <td className="muted" title={t.updatedAt ? new Date(t.updatedAt).toLocaleString() : undefined}>{t.updatedAt ? checkedAgo(t.updatedAt) : '—'}</td>
                </tr>
              );
            })}
            {elsewhere.map((t) => {
              const open = () => navigate(`/dispatch/${encodeTicketId(t.id)}`);
              return (
                <tr key={`found:${t.id}`} className="clickable" tabIndex={0} role="link" onClick={open}
                  onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) open(); }}>
                  <td />
                  <td className="mono">{t.key}{several && t.connection && <> <span className="pill source">{connectionLabel(t.connection)}</span></>}</td>
                  <td>{t.title} <span className="muted">(not in this view)</span></td>
                  <td>{t.bucket === 'done' ? <span className="pill done">{t.status}</span> : <WherePill bucket={t.bucket} refused={refusalFor(refused, t.id)} />}</td>
                  <td className="muted">{t.priority ?? '—'}</td>
                  <td className="muted">{t.updatedAt ? checkedAgo(t.updatedAt) : '—'}</td>
                </tr>
              );
            })}
            {total === 0 && elsewhere.length === 0 && (
              <tr><td colSpan={6} className="muted" style={{ padding: 32, textAlign: 'center' }}>
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
                  <td className="mono"><a href={t.url} target="_blank" rel="noreferrer">{t.key}</a>{several && t.connection && <> <span className="pill source">{connectionLabel(t.connection)}</span></>}</td>
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

/** A ticket row's "Where it is": its board bucket, or "Couldn't start" with the reason wrapping under it (the column is nowrap). */
function WherePill({ bucket, refused }: { bucket: string; refused?: WorkQueueEntry }) {
  const { label, note } = wherePill(bucket, refused);
  return (
    <>
      <span className="pill">{label}</span>
      {note && <div className="muted" style={{ fontSize: '0.85em', whiteSpace: 'normal', overflowWrap: 'anywhere', maxWidth: 220, marginTop: 4 }}>{note}</div>}
    </>
  );
}
