import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { isAdhocId } from '@asf/shared/ui';
import { api, decodeTicketId, type TicketRow } from '../api';
import { gatesFor, isCustomised, modelsFor, overridesDiff, reconcileModel, roleLock, runtimeOptions, skipRolesPayload } from '../dispatch-roles';
import { setupFlags } from '../setup-flags';
import { useMe } from '../useMe';
import { GATE_MODE_LABEL, PAGE, runtimeLabel } from '../words';

const GATE_LABELS: Record<string, string> = {
  after_plan: 'After the plan is written',
  before_change_request: 'Before opening the pull request',
  before_merge: 'Before merging to the default branch',
};
const ROLE_LABEL: Record<string, string> = {
  planner: 'Plans', implementer: 'Writes the code', tester: 'Tests', reviewer: 'Reviews',
};

const ROLE_ORDER = ['planner', 'implementer', 'tester', 'reviewer'];

/**
 * The dispatch screen as a bookmarkable page (`/dispatch/:ticketId`). It pulls the
 * full ticket — including the description `body` the Backlog list omits — and the
 * dispatch preview (repos/models/efforts/gates), then lets the operator configure
 * and start a run. On success it navigates to the new run, mirroring the Backlog.
 */
export function Dispatch() {
  // Splat route (`dispatch/*`): the ticket id can carry '/' and an encoded '#'.
  const params = useParams();
  const ticketId = decodeTicketId(params['*'] ?? '');
  const navigate = useNavigate();
  const me = useMe();

  const [ticket, setTicket] = useState<TicketRow | null>(null);
  const [ticketErr, setTicketErr] = useState<string | null>(null);

  const [preview, setPreview] = useState<Awaited<ReturnType<typeof api.dispatchPreview>> | null>(null);
  const [repoId, setRepoId] = useState<string>('');
  const [maxCost, setMaxCost] = useState(15);
  const [gates, setGates] = useState<Record<string, string>>({});
  const [models, setModels] = useState<Record<string, string>>({});
  const [runtimes, setRuntimes] = useState<Record<string, string>>({});
  const [efforts, setEfforts] = useState<Record<string, string>>({});
  const [off, setOff] = useState<Record<string, boolean>>({});  // roles switched off for this run
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setTicket(null); setTicketErr(null);
    api.ticket(ticketId).then(setTicket).catch((e) => setTicketErr(String(e)));
  }, [ticketId]);

  useEffect(() => {
    setPreview(null); setErr(null);
    api.dispatchPreview(ticketId).then((p) => {
      setPreview(p);
      // Prefer the repo the ticket names (GitHub issue → its own repo); else the first known repo.
      setRepoId(p.suggestedRepoId ?? p.repos[0]?.id ?? '');
      setGates(Object.fromEntries(Object.entries(p.gates).map(([k, v]) => [k, v.mode])));
      setModels({ ...p.defaultModels });
      setRuntimes({ ...p.defaultRuntimes });
      setEfforts(Object.fromEntries(Object.entries(p.defaultEfforts).map(([k, v]) => [k, v ?? ''])));
      setOff(Object.fromEntries((p.orgDisabledRoles ?? []).map((r) => [r, true])));
    }).catch((e) => setErr(String(e)));
  }, [ticketId]);

  const submit = async () => {
    setBusy(true); setErr(null);
    const shownGates = gatesFor(Object.keys(gates), Boolean(off.planner));
    const overrides = Object.fromEntries(Object.entries(gates).filter(([k]) => shownGates.includes(k)).map(([k, mode]) => [k, { mode }]));
    const skipRoles = skipRolesPayload(off, preview?.orgDisabledRoles ?? []);
    // Send only the roles the operator changed off the default.
    const modelOverrides = overridesDiff(models, preview?.defaultModels ?? {});
    const runtimeOverrides = overridesDiff(runtimes, preview?.defaultRuntimes ?? {});
    const effortOverrides = Object.fromEntries(Object.entries(efforts).filter(([role, e]) => e && e !== (preview?.defaultEfforts[role] ?? '')));
    const { status, body } = await api.dispatch(ticketId, { repoId: repoId || undefined, maxCostUsd: maxCost, by: me.user, gateOverrides: overrides, modelOverrides, effortOverrides, runtimeOverrides, skipRoles });
    setBusy(false);
    if (status === 201) { setupFlags.markPipelineReviewed(); navigate(`/run/${body.run.id}`); }
    else setErr(body.reason || `Couldn’t start it (${status}).`);
  };

  // Header falls back to the preview's ticket (id/key/title) until the full ticket loads.
  const key = ticket?.key ?? preview?.ticket.key ?? '';
  const title = ticket?.title ?? preview?.ticket.title ?? '';

  return (
    <div>
      <Link to="/backlog">← {PAGE.todo}</Link>
      <div className="row between dispatch-head" style={{ margin: '12px 0' }}>
        <h2 style={{ margin: 0 }}>Start work on <span className="mono">{key}</span></h2>
        <span className="row dispatch-actions" style={{ gap: 8 }}>
          {ticket?.url && <a className="btn ghost" href={ticket.url} target="_blank" rel="noreferrer">Open in tracker ↗</a>}
          <button className="btn" disabled={!preview || busy || Boolean(preview.blocker)} onClick={submit}>{busy ? 'Starting…' : 'Start work'}</button>
        </span>
      </div>
      {title && <p className="muted" style={{ marginTop: 0 }}>{title}</p>}
      {preview?.blocker && <NoRepo reason={preview.blocker.reason} link={preview.blocker.link} />}

      <div className="card">
        <div className="row between"><b>Description</b>{ticket && <span className="pill">{ticket.status}</span>}</div>
        {ticketErr
          ? <div className="muted" style={{ color: 'var(--bad)', marginTop: 8 }}>Could not load the ticket: {ticketErr}</div>
          : !ticket
            ? <p className="muted">Loading…</p>
            : ticket.body.trim()
              ? <div className="ticket-desc"><ReactMarkdown remarkPlugins={[remarkGfm]}>{ticket.body}</ReactMarkdown></div>
              : <p className="muted">No description.</p>}
      </div>

      {!preview ? (
        <div className="card" style={{ marginTop: 12 }}>
          {err
            ? <div style={{ color: 'var(--bad)' }}>Couldn’t load the options: {err}</div>
            : <p className="muted">Loading…</p>}
        </div>
      ) : (
        <div className="card" style={{ marginTop: 12 }}>
          <label className="muted">Repository</label>
          <select value={repoId} onChange={(e) => setRepoId(e.target.value)} style={{ width: '100%', marginBottom: 4 }}>
            {preview.repos.map((r) => <option key={r.id} value={r.id}>{r.path}</option>)}
          </select>
          {preview.suggestedRepoId && repoId === preview.suggestedRepoId && (
            <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
              {isAdhocId(preview.ticket.id) ? 'Suggested: the repository the run that added it was working in' : 'Suggested — the issue\'s own repository.'}
            </div>
          )}

          <details className="advanced" style={{ marginBottom: 10 }}>
          <summary>Advanced: {isCustomised({ models, runtimes, efforts, gates, off }, preview) ? 'changed for this job' : 'using your defaults'}</summary>
          <label className="muted">Who does what: which AI, the model, and how hard it thinks</label>
          <div className="card" style={{ padding: '2px 10px', marginTop: 4, marginBottom: 4 }}>
            {ROLE_ORDER.filter((r) => r in models).map((role) => {
              const isOff = Boolean(off[role]);
              const lock = roleLock(role, preview.orgDisabledRoles ?? []);
              return (
              <div key={role} className={`row between role-row${isOff ? ' off' : ''}`} style={{ padding: '5px 0', gap: 8 }}>
                <button type="button" role="switch" className="switch" aria-checked={!isOff} aria-label={`${ROLE_LABEL[role] ?? role}: ${isOff ? 'off' : 'on'} for this job`}
                  disabled={Boolean(lock)} title={lock ?? (isOff ? 'Off for this job: switch on to include this step' : 'On: switch off to skip this step for this job')}
                  onClick={() => setOff({ ...off, [role]: !isOff })}>
                  <span className="switch-knob" aria-hidden="true" />
                </button>
                <span style={{ minWidth: 120 }}>{ROLE_LABEL[role] ?? role}</span>
                <fieldset className="role-picks" disabled={isOff}>
                <select value={runtimes[role]} disabled={preview.runtimes.length === 0} title={preview.runtimes.length === 0 ? 'No worker is online to offer another AI' : 'Which AI does this step'}
                  onChange={(e) => { const rt = e.target.value; setRuntimes({ ...runtimes, [role]: rt }); setModels({ ...models, [role]: reconcileModel(preview.models, rt, models[role]) }); }}>
                  {runtimeOptions(preview.runtimes, runtimes[role]).map((rt) => <option key={rt} value={rt}>{runtimeLabel(rt)}</option>)}
                </select>
                <select value={models[role]} onChange={(e) => setModels({ ...models, [role]: e.target.value })} style={{ flex: 1 }}>
                  {modelsFor(preview.models, runtimes[role]).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
                <select value={efforts[role] ?? ''} onChange={(e) => setEfforts({ ...efforts, [role]: e.target.value })} title="How hard it thinks">
                  {preview.efforts.map((e) => <option key={e} value={e}>{e}</option>)}
                </select>
                </fieldset>
              </div>
              );
            })}
          </div>
          <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>Defaults come from Settings; a different AI chosen here, or a step switched off, is for this ticket only. A more capable model, or thinking harder, costs more.</div>

          <label className="muted">When should it check with you?</label>
          <div className="card" style={{ padding: '2px 10px', marginTop: 4, marginBottom: 4 }}>
            {gatesFor(Object.keys(preview.gates), Boolean(off.planner)).map((g) => (
              <div key={g} className="row between" style={{ padding: '5px 0', gap: 8 }}>
                <span style={{ fontSize: 13 }}>{GATE_LABELS[g] ?? g}</span>
                <select value={gates[g]} disabled={g === 'before_merge'} onChange={(e) => setGates({ ...gates, [g]: e.target.value })}>
                  {Object.entries(GATE_MODE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
            ))}
          </div>
          <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>The merge check-in can only be changed in Settings, not for a single ticket.</div>
          </details>

          <label className="muted">Spending limit for this ticket (USD)</label>
          <input type="number" value={maxCost} onChange={(e) => setMaxCost(Number(e.target.value))} style={{ width: '100%' }} />

          {err && <div className="card" style={{ color: 'var(--bad)', margin: '12px 0 8px' }}>{err}</div>}
          <div className="row between" style={{ marginTop: 12 }}>
            <span className="muted" style={{ fontSize: 12 }}>{preview.whyNot.join(' · ')}</span>
            <button className="btn" disabled={busy || Boolean(preview.blocker)} onClick={submit}>{busy ? 'Starting…' : 'Start work'}</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Nothing can start without a repository to put the work in: say so, and link to the fix. */
export function NoRepo({ reason, link }: { reason: string; link: string }) {
  return (
    <div className="card" style={{ borderColor: 'var(--bad)', margin: '8px 0 12px' }}>
      <b>Connect a repository first</b>
      <div className="muted" style={{ marginTop: 4 }}>{reason}</div>
      <Link className="btn" to={link} style={{ marginTop: 8, display: 'inline-block' }}>Connect a repository</Link>
    </div>
  );
}
