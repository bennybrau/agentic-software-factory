import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { describeSchedule, scheduleSchema, type RecurringTask } from '@asf/shared/ui';
import { api } from '../api';
import {
  browserTimeZone, DEFAULT_SCHEDULE_FORM, findRepo, formatNextRun, formToSchedule, lastRunView, recurringFormProblem,
  repoLabel, repoOptionId, scheduleToForm, TITLE_MAX, WEEKDAY_SHORT, type RecurringForm, type ScheduleKind,
} from '../recurring';

const KINDS: { kind: ScheduleKind; label: string }[] = [
  { kind: 'daily', label: 'Every day' },
  { kind: 'weekly', label: 'On certain weekdays' },
  { kind: 'monthly', label: 'Once a month' },
];

const blankForm = (repoId: string): RecurringForm =>
  ({ title: '', body: '', repoId, timezone: browserTimeZone(), schedule: DEFAULT_SCHEDULE_FORM });

// A task stored with a bare repoId opens with the matching (qualified) option selected.
const taskToForm = (t: RecurringTask, repos: { id: string }[]): RecurringForm =>
  ({ title: t.title, body: t.body, repoId: repoOptionId(repos, t.repoId), timezone: t.timezone, schedule: scheduleToForm(t.schedule) });

/**
 * Recurring tasks (#188): work the factory adds to Planned tasks on a schedule, e.g.
 * "every Monday at 9, bump the dependencies". A list of the schedules with when each
 * runs next and how the last one went, and one form for adding or editing one.
 */
export function Recurring() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['recurring'], queryFn: api.listRecurring, refetchInterval: 30_000 });
  const { data: readiness } = useQuery({ queryKey: ['start-readiness'], queryFn: api.startReadiness, refetchInterval: 30_000 });
  const repos = readiness?.ok ? readiness.repos : [];
  const tasks = data?.tasks ?? [];

  // null: no form open; 'new': adding; otherwise the id being edited.
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<RecurringForm>(blankForm(''));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => qc.invalidateQueries({ queryKey: ['recurring'] });

  const openNew = () => { setForm(blankForm(repos.length === 1 ? repos[0].id : '')); setEditing('new'); setErr(null); };
  const openEdit = (t: RecurringTask) => { setForm(taskToForm(t, repos)); setEditing(t.id); setErr(null); };
  const close = () => { setEditing(null); setErr(null); };

  const act = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try { await fn(); } catch (e) { setErr(String(e)); }
    await refresh();
  };

  const togglePaused = (t: RecurringTask) => act(() => api.setRecurringPaused(t.id, !t.paused));
  const remove = (t: RecurringTask) => {
    if (!confirm(`Delete “${t.title}”? It won’t be added again. Work it already started is kept.`)) return;
    void act(async () => {
      const res = await api.deleteRecurring(t.id);
      if (res.status !== 204 && res.status !== 404) throw new Error(`Couldn’t delete it (${res.status}).`);
      if (editing === t.id) close();
    });
  };

  const problem = recurringFormProblem(form);
  const preview = scheduleSchema.safeParse(formToSchedule(form.schedule));
  const save = async () => {
    if (problem) { setErr(problem); return; }
    setBusy(true); setErr(null);
    const input = { title: form.title.trim(), body: form.body, repoId: form.repoId, timezone: form.timezone.trim(), schedule: formToSchedule(form.schedule) };
    try {
      const res = editing === 'new'
        ? await api.createRecurring({ ...input, paused: false })
        : await api.updateRecurring(editing!, input);
      if (res.status === 200 || res.status === 201) { close(); await refresh(); }
      else setErr(res.body.reason ?? `Couldn’t save it (${res.status}).`);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const setSchedule = (patch: Partial<RecurringForm['schedule']>) => setForm((f) => ({ ...f, schedule: { ...f.schedule, ...patch } }));
  const toggleDay = (d: number) => setSchedule({
    weekdays: form.schedule.weekdays.includes(d) ? form.schedule.weekdays.filter((x) => x !== d) : [...form.schedule.weekdays, d],
  });

  return (
    <div>
      <div className="row between" style={{ margin: '12px 0' }}>
        <h2 style={{ margin: 0 }}>Recurring tasks</h2>
        {editing === null && <button className="btn" onClick={openNew}>New recurring task</button>}
      </div>
      <p className="muted" style={{ marginTop: 0 }}>Work that comes round on a schedule. Each time it’s due, the factory adds it to Planned tasks as a new task, in the repository you choose.</p>

      {readiness && !readiness.ok && (
        <div className="card muted">{readiness.reason} <Link to={readiness.link}>Fix it</Link></div>
      )}

      {editing !== null && (
        <div className="card">
          <b>{editing === 'new' ? 'New recurring task' : 'Edit recurring task'}</b>

          <label className="muted" htmlFor="rt-title" style={{ display: 'block', marginTop: 12 }}>Title</label>
          <input id="rt-title" value={form.title} maxLength={TITLE_MAX} onChange={(e) => setForm({ ...form, title: e.target.value })}
            placeholder="e.g. Bump the dependencies" style={{ width: '100%', marginBottom: 12 }} autoFocus />

          <label className="muted" htmlFor="rt-body">Description <span className="small">(Markdown)</span></label>
          <textarea id="rt-body" value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} rows={6}
            placeholder="What should be done each time, and how to tell it worked." />

          <label className="muted" htmlFor="rt-repo" style={{ display: 'block', marginTop: 12 }}>Repository</label>
          <select id="rt-repo" value={form.repoId} onChange={(e) => setForm({ ...form, repoId: e.target.value })}>
            <option value="">Choose…</option>
            {repos.map((r) => <option key={r.id} value={r.id}>{r.path}</option>)}
            {form.repoId && !findRepo(repos, form.repoId) && <option value={form.repoId}>{repoLabel(repos, form.repoId)} (not reachable)</option>}
          </select>

          <fieldset style={{ border: 0, padding: 0, margin: '12px 0 0' }}>
            <legend className="muted">When</legend>
            <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
              {KINDS.map((k) => (
                <label key={k.kind} className="row" style={{ gap: 4 }}>
                  <input type="radio" name="rt-kind" checked={form.schedule.kind === k.kind} onChange={() => setSchedule({ kind: k.kind })} />
                  {k.label}
                </label>
              ))}
            </div>

            {form.schedule.kind === 'weekly' && (
              <div className="row" role="group" aria-label="Weekdays" style={{ gap: 4, marginTop: 8, flexWrap: 'wrap' }}>
                {WEEKDAY_SHORT.map((name, d) => {
                  const on = form.schedule.weekdays.includes(d);
                  return <button key={d} type="button" className={`btn sm${on ? '' : ' ghost'}`} aria-pressed={on} onClick={() => toggleDay(d)}>{name}</button>;
                })}
              </div>
            )}

            <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              {form.schedule.kind === 'monthly' && (
                <label className="row" style={{ gap: 4 }}>
                  On day
                  <input type="number" min={1} max={31} value={form.schedule.day} style={{ width: 64 }}
                    onChange={(e) => setSchedule({ day: Number(e.target.value) })} />
                </label>
              )}
              <label className="row" style={{ gap: 4 }}>
                at
                <input type="time" value={form.schedule.time} onChange={(e) => setSchedule({ time: e.target.value })} />
              </label>
              <label className="row" style={{ gap: 4 }}>
                time zone
                <input value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} placeholder="Europe/London" style={{ width: '100%', maxWidth: 180 }} />
              </label>
            </div>
            {form.schedule.kind === 'monthly' && form.schedule.day >= 29 && (
              <p className="muted small" style={{ margin: '4px 0 0' }}>In shorter months it runs on the last day.</p>
            )}
            {preview.success && (
              <p className="muted small" style={{ margin: '4px 0 0' }}>{describeSchedule(preview.data)} ({form.timezone})</p>
            )}
          </fieldset>

          <div className="row" style={{ gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
            <button className="btn ghost" onClick={close} disabled={busy}>Cancel</button>
            <button className="btn" onClick={save} disabled={busy || Boolean(problem)} title={problem ?? undefined}>
              {busy ? 'Saving…' : editing === 'new' ? 'Add' : 'Save'}
            </button>
          </div>
        </div>
      )}

      {err && <div className="card" style={{ color: 'var(--bad)' }}>{err}</div>}

      <div className="card table-wrap" style={{ padding: 0 }}>
        <table>
          <thead><tr><th>Task</th><th>When</th><th>Next run</th><th>Last run</th><th /></tr></thead>
          <tbody>
            {tasks.map((t) => {
              const last = lastRunView(t);
              return (
                <tr key={t.id}>
                  <td>
                    <div>{t.title} {t.paused && <span className="pill">Paused</span>}</div>
                    <div className="muted small mono">{repoLabel(repos, t.repoId)}</div>
                  </td>
                  <td>{describeSchedule(t.schedule)}<div className="muted small">{t.timezone}</div></td>
                  <td className="muted">{t.paused ? '—' : formatNextRun(t.nextRunAt, t.timezone)}</td>
                  <td>
                    {last
                      ? (last.href
                        ? <Link to={last.href}><span className={`pill ${last.pill}`}>{last.label}</span></Link>
                        : <span className={`pill ${last.pill}`}>{last.label}</span>)
                      : <span className="muted">Not run yet</span>}
                  </td>
                  <td>
                    <span className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                      <button className="btn ghost sm" onClick={() => togglePaused(t)}>{t.paused ? 'Resume' : 'Pause'}</button>
                      <button className="btn ghost sm" onClick={() => openEdit(t)}>Edit</button>
                      <button className="btn ghost sm" onClick={() => remove(t)}>Delete</button>
                    </span>
                  </td>
                </tr>
              );
            })}
            {tasks.length === 0 && (
              <tr><td colSpan={5} className="muted" style={{ padding: 24, textAlign: 'center' }}>
                {isLoading ? 'Loading…' : 'No recurring tasks yet. Add one for work that comes round regularly, like dependency bumps or a weekly clean-up.'}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
