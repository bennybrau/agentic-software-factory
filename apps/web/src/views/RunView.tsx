import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, subscribeEvents, type RunDetail } from '../api';
import { GateCard } from '../components/GateCard';
import { NeedsHumanCard } from '../components/NeedsHumanCard';
import { PlanChat } from '../components/PlanChat';
import { SplitCard } from '../components/SplitCard';
import { MemberAvatar } from '../components/MemberAvatar';
import { HiveStage } from '../components/HiveStage';
import { useTheme } from '../useTheme';
import type { RunEvent, RunTask } from '@asf/shared';
import { parseMergeConflict } from '@asf/shared/ui';
import { PAGE, outcomeLabel, runStateLabel, taskStateLabel } from '../words';
import { groupStages, type Attempt } from '../stages';
import { crewName, laneLabel, memberName } from '../theme-view';
import { useMe } from '../useMe';
import { runCostText, taskCostText } from '../cost-words';

// Run page view preferences (#155), kept per browser. localStorage can throw
// (private mode, disabled storage), so every access is guarded.
const LS_ADVANCED_OPEN = 'asf.run.advancedOpen';
const LS_SHOW_COMMANDS = 'asf.run.showAgentCommands';
function useStoredFlag(key: string): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState(() => { try { return localStorage.getItem(key) === '1'; } catch { return false; } });
  const set = useCallback((v: boolean) => {
    setValue(v);
    try { localStorage.setItem(key, v ? '1' : '0'); } catch { /* storage unavailable — ignore */ }
  }, [key]);
  return [value, set];
}

export function RunView() {
  const { runId = '' } = useParams();
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [filter, setFilter] = useState<string>('all');
  const [openStage, setOpenStage] = useState<string | null>(null);
  const { theme } = useTheme();
  const [openTask, setOpenTask] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useStoredFlag(LS_ADVANCED_OPEN);
  const [showCommands, setShowCommands] = useStoredFlag(LS_SHOW_COMMANDS);
  const load = useCallback(() => { api.run(runId).then(setDetail).catch(() => {}); }, [runId]);

  useEffect(() => {
    load();
    return subscribeEvents((e) => { if (e.runId === runId) { setEvents((prev) => [...prev, e]); load(); } });
  }, [runId, load]);

  // While a task is running, refresh every 5s so the live ticker's elapsed time and
  // tool count advance even in a quiet stretch with no SSE events (M11 WP5).
  const anyRunning = detail?.tasks.some((t) => t.state === 'running') ?? false;
  useEffect(() => {
    if (!anyRunning) return;
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [anyRunning, load]);

  if (!detail) return <p className="muted">Loading…</p>;
  const { run, tasks, gates, artifacts } = detail;
  const openGate = gates.find((g) => g.state === 'open');
  const needsHumanTask = tasks.find((t) => t.state === 'needs_human');
  // The plan stage is a chat (PlanChat): the plan gate and the planner's questions are
  // answered there, not in the generic gate / needs-human cards.
  const messages = detail.messages ?? [];
  const planGate = openGate?.gateName === 'after_plan' ? openGate : null;
  const plannerTask = [...tasks].filter((t) => String(t.role) === 'planner').sort((a, b) => b.seq - a.seq)[0] ?? null;
  const plannerAsking = needsHumanTask && String(needsHumanTask.role) === 'planner' && !/^DISPUTE:/i.test(needsHumanTask.reason ?? '');
  const showChat = Boolean(planGate || plannerAsking || messages.length);
  const stages = groupStages(tasks);
  // A run that was split builds nothing itself: its remaining roles are "skipped" by
  // design. Show the parts instead and fold the team away so it doesn't look stuck.
  const wasSplit = run.deliveryOutcome === 'split';
  const split = detail.split ?? null;
  // The MR/PR is now a first-class run field (persisted); fall back to the event for older runs.
  const crEvent = [...events].reverse().find((e) => e.kind === 'change_request:opened');
  const crUrl = run.changeRequestUrl ?? (crEvent ? String(crEvent.payload.url) : null);
  const crState = run.changeRequestState;
  const awaitingExternal = run.deliveryOutcome === 'awaiting_external_merge';
  // Once the human acts on an awaiting-external CR, the watcher stamps its state;
  // the card should then reflect the landed/closed outcome, not the stale "awaiting" framing.
  const externalResolved = awaitingExternal && (crState === 'merged' || crState === 'closed');

  const groups: Record<string, (k: string) => boolean> = {
    all: () => true, tool: (k) => k.startsWith('tool:'), gate: (k) => k.startsWith('gate:'),
    git: (k) => k.startsWith('branch:') || k.startsWith('change_request:'), agent: (k) => k.startsWith('segment:') || k === 'needs_human',
  };

  return (
    <div>
      <div className="row between">
        <div><Link to="/runs">← {PAGE.activity}</Link>
          <h2 className="run-title" style={{ margin: '6px 0' }}><span className="mono">{run.ticketKey}</span><span className={`pill ${run.state}`}>{wasSplit ? outcomeLabel('split') : runStateLabel(run.state)}</span></h2>
          {detail.recurring && (
            <div className="muted" style={{ fontSize: 13 }}>
              {detail.recurring.title
                ? <>Started by a schedule: <Link to="/recurring">{detail.recurring.title}</Link></>
                : 'Started by a schedule (schedule deleted)'}
            </div>
          )}
        </div>
        <div className="row">
          <span className="muted">{runCostText(run, detail.tasks)}</span>
          {!['succeeded', 'failed', 'cancelled', 'halted'].includes(run.state) && <button className="btn ghost" onClick={() => api.cancel(runId).then(load)}>Cancel</button>}
          {run.state === 'stale' && <button className="btn" onClick={() => api.resume(runId).then(load)}>Resume</button>}
        </div>
      </div>

      {crUrl && (
        <div className="card" style={awaitingExternal && !externalResolved ? { borderColor: 'var(--good)' } : undefined}>
          <div className="row between">
            <b>{externalResolved ? (crState === 'merged' ? '✅ Merged' : 'Closed without merging') : awaitingExternal ? '✅ Ready for review' : 'Merge request'}</b>
            {crState && <span className={`pill ${crState === 'merged' ? 'succeeded' : crState === 'closed' ? 'failed' : 'awaiting_checkpoint'}`}>{crState}</span>}
          </div>
          <div style={{ marginTop: 8 }}>
            <a href={crUrl} target="_blank" rel="noreferrer">{crUrl}</a>
          </div>
          {awaitingExternal && !externalResolved && (
            <div className="muted" style={{ fontSize: 13, marginTop: 8 }}>
              ASF opened this change and marked it ready for review. A human needs to review and merge it in the source-control system to land the work — ASF did not merge (the merge stage is off).
            </div>
          )}
          {externalResolved && (
            <div className="muted" style={{ fontSize: 13, marginTop: 8 }}>
              {crState === 'merged'
                ? 'A human merged this change in the source-control system — the work has landed and the ticket was moved to Done.'
                : 'A human closed this change without merging. The ticket was left where it is.'}
            </div>
          )}
          {((awaitingExternal && !externalResolved) || openGate?.gateName === 'before_merge') && <RequestChanges runId={runId} onDone={load} />}
        </div>
      )}

      {run.team.reviewTarget && run.state === 'succeeded' && (
        <PostReview runId={runId} url={run.team.reviewTarget.url} posted={events.some((e) => e.kind === 'review:posted')} onDone={load} />
      )}

      {split && <SplitCard family={split} runId={runId} />}
      {wasSplit && !split && (
        <div className="card"><b>{outcomeLabel('split')}</b><div className="muted" style={{ fontSize: 13, marginTop: 4 }}>The planner divided this job into smaller tasks. Find them on the Activity page.</div></div>
      )}

      {showChat && !wasSplit && <PlanChat runId={runId} ticketId={run.ticketId} ticketKey={run.ticketKey} messages={messages} gate={planGate} plannerTask={plannerTask} onDone={load} />}
      {openGate && !planGate && <GateCard gate={openGate} onDone={load} changeRequestUrl={crUrl} />}
      {!openGate && needsHumanTask && !plannerAsking && <NeedsHumanCard runId={runId} ticketId={run.ticketId} ticketKey={run.ticketKey} task={needsHumanTask} onDone={load} />}

      <LoopBanner events={events} run={run} />

      {wasSplit && showChat && (
        <details className="card">
          <summary><b>The planning conversation</b> <span className="muted" style={{ fontSize: 13 }}>· how the split was agreed</span></summary>
          <PlanChat runId={runId} ticketId={run.ticketId} ticketKey={run.ticketKey} messages={messages} gate={null} plannerTask={plannerTask} onDone={load} />
        </details>
      )}

      <TeamWrap split={wasSplit}>
        {!wasSplit && <b>{crewName(theme)}</b>}
        <HiveStage run={run} tasks={tasks} gates={gates} events={events} />
        {stages.roles.filter((s) => !wasSplit || s.latest.state !== 'skipped').map((s) => {
          const t = s.latest;
          const open = openStage === s.role;
          return (
            <div key={s.role}>
              <div className={`lane${t.state === 'done' ? ' done' : ''}`} onClick={() => setOpenStage(open ? null : s.role)} style={{ cursor: 'pointer' }} title="Show each try at this stage">
                <span><MemberAvatar slot={s.role} state={t.state} />{laneLabel(theme, s.role)}{open ? ' ▾' : ' ▸'}</span>
                <span className="muted">{taskStateLabel(t.state)}{s.note ? ` · ${s.note}` : ''}{t.reason ? ` — ${t.reason}` : ''}</span>
                <span className="muted" style={{ textAlign: 'right' }}>{t.model ? <span className="mono" style={{ fontSize: 11 }}>{String(t.model).replace('claude-', '')}</span> : null} · ${s.totalCost.toFixed(2)}</span>
              </div>
              {t.state === 'running' && detail.taskProgress?.[t.id] && (showCommands
                ? <LiveTaskLine p={detail.taskProgress[t.id]} />
                : <WorkingLine role={String(t.role)} p={detail.taskProgress[t.id]} />)}
              {run.state === 'failed' && t.state === 'failed' && isConflictReason(t.reason) && (
                <div style={{ padding: '2px 0 6px 18px' }}>
                  <div className="muted" style={{ fontSize: 13, marginBottom: 4 }}>Work merged since this run started changed the same lines, so the branch can't be pushed. The implementer can merge the latest code in and resolve it; then it's re-tested and re-reviewed before pushing.</div>
                  <button className="btn primary" onClick={() => api.resolveConflict(runId).then(load).catch((e) => alert((e as Error).message))} title="Hand the conflict to the implementer, then re-test, re-review and push">Resolve the conflict</button>
                </div>
              )}
              {run.state === 'failed' && t.state === 'failed' && t.runtime !== 'publish' && (
                <div style={{ padding: '2px 0 6px 18px' }}>
                  <button className="btn" onClick={() => api.retry(runId).then(load)} title="Re-run this role from where it stopped; its partial work is preserved as a WIP commit">Retry role</button>
                </div>
              )}
              {open && (
                <div style={{ padding: '2px 0 6px 18px' }}>
                  {s.attempts.length === 0 && <div className="muted" style={{ fontSize: 13 }}>Not started yet.</div>}
                  {s.attempts.map((a) => (
                    <div key={a.task.id}>
                      <div onClick={() => setOpenTask(openTask === a.task.id ? null : a.task.id)} style={{ cursor: 'pointer', fontSize: 13, padding: '2px 0' }} title="Show what this try was asked, said, and changed">
                        <span className={`dot ${a.task.state}`} />Try {a.n} · {taskCostText(a.task)}{feedbackText(a)}{openTask === a.task.id ? ' ▾' : ' ▸'}
                      </div>
                      {openTask === a.task.id && <TaskPanel task={a.task} versions={detail.artifactVersions ?? []} events={events} />}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {stages.publish.map((s) => (
          <div className={`lane${s.latest.state === 'done' ? ' done' : ''}`} key={s.role}>
            <span><span className={`dot ${s.latest.state}`} />{s.role.replace('publish:', '📦 ')}</span>
            <span className="muted">{taskStateLabel(s.latest.state)}{s.latest.reason ? ` — ${s.latest.reason}` : ''}</span><span />
          </div>
        ))}
      </TeamWrap>

      <ArtifactVersions artifacts={artifacts} versions={detail.artifactVersions ?? []} tasks={tasks} />

      <details className="advanced" open={advancedOpen} onToggle={(e) => setAdvancedOpen(e.currentTarget.open)}>
        <summary>Advanced</summary>
        <label className="muted" style={{ fontSize: 13, display: 'block', marginBottom: 10 }}>
          <input type="checkbox" checked={showCommands} onChange={(e) => setShowCommands(e.target.checked)} /> Show agent commands
        </label>

        <ReportCard runId={runId} />

        <div className="card">
          <div className="row between"><b>Event log</b>
            <div className="row">{Object.keys(groups).map((g) => <a key={g} onClick={() => setFilter(g)} style={{ color: filter === g ? 'var(--accent)' : 'var(--muted)', cursor: 'pointer' }}>{g}</a>)}</div>
          </div>
          <div className="log">
            {events.filter((e) => groups[filter](e.kind)).map((e, i) => (
              <div className="ev" key={i}><span className="muted">{e.seq}</span> <b>{e.kind}</b> <span className="muted">{summarize(e)}</span></div>
            ))}
            {events.length === 0 && <div className="muted">Waiting for events…</div>}
          </div>
        </div>
      </details>
    </div>
  );
}

/** A push that failed on a merge conflict (new wording, or the pre-#conflict one). */
function isConflictReason(reason: string | null): boolean {
  return parseMergeConflict(reason) !== null || /conflict with work merged since the run started/.test(reason ?? '');
}

/** The Team card; on a split run, folded away (only the planner worked here). */
function TeamWrap({ split, children }: { split: boolean; children: React.ReactNode }) {
  const { theme } = useTheme();
  if (!split) return <div className="card">{children}</div>;
  return (
    <details className="card">
      <summary><b>{crewName(theme)}</b> <span className="muted" style={{ fontSize: 13 }}>· only the planner worked on this job; the rest happens in the tasks above</span></summary>
      {children}
    </details>
  );
}

const ARTIFACT_LABEL: Record<string, string> = {
  'plan.md': 'Plan (planner)',
  'test-report.md': 'Test report (tester)',
  'review.md': 'Review (reviewer)',
  'human-reply.md': 'Human reply',
};
function stageOrder(name: string): number {
  const order = ['plan.md', 'test-report.md', 'review.md', 'human-reply.md'];
  const i = order.indexOf(name);
  return i === -1 ? order.length : i;
}

type Version = NonNullable<RunDetail['artifactVersions']>[number];

/**
 * The run report (M11 WP6): the whole story of a run as Markdown, fetched on
 * demand, with a Copy button for pasting into a ticket or feeding to an agent.
 */
function ReportCard({ runId }: { runId: string }) {
  const [md, setMd] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const show = () => { setOpen(true); if (md === null) api.runReport(runId).then((r) => setMd(r.markdown)).catch(() => setMd('(report unavailable)')); };
  return (
    <div className="card">
      <div className="row between">
        <b>Report</b>
        <div className="row" style={{ gap: 8 }}>
          {!open && <button className="btn ghost" onClick={show}>Show report</button>}
          {open && md && <button className="btn ghost" onClick={() => { void navigator.clipboard.writeText(md); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? 'Copied ✓' : 'Copy as Markdown'}</button>}
        </div>
      </div>
      {open && (md === null ? <div className="muted">Loading…</div> : <pre className="artifact">{md}</pre>)}
    </div>
  );
}

const STALL_WARN_MS = 90_000;
function ago(iso: string | null): string {
  if (!iso) return '';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m${s % 60}s ago`;
}
function dur(iso: string | null): string {
  if (!iso) return '—';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
}

/**
 * The default line under a running task (#155): an animated indicator, who is on
 * it, elapsed time and the stall warning. The rotating quip moved up to the Hive
 * stage's caption (M12 WP4); the raw tool-call detail (LiveTaskLine) is behind
 * Advanced → "Show agent commands".
 */
function WorkingLine({ role, p }: { role: string; p: NonNullable<RunDetail['taskProgress']>[string] }) {
  const { theme } = useTheme();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const stalled = p.lastToolAt && now - new Date(p.lastToolAt).getTime() > STALL_WARN_MS;
  return (
    <div className={`working muted${stalled ? ' stalled' : ''}`} role="status">
      <span className="working-dots" aria-hidden="true"><i /><i /><i /></span>
      <span>{memberName(theme, role) ?? 'Working'} is on it · {dur(p.startedAt)} elapsed{stalled && ' · ⚠ no activity for a while'}</span>
    </div>
  );
}

/**
 * Live "what is it doing right now" line under a running task (M11 WP5): tool-call
 * count, elapsed / timeout, and the last tool + how long ago — with a stall warning
 * when nothing has happened for a while. Answers "why is this taking so long"
 * without waiting for the task to finish.
 */
function LiveTaskLine({ p }: { p: NonNullable<RunDetail['taskProgress']>[string] }) {
  const stalled = p.lastToolAt && Date.now() - new Date(p.lastToolAt).getTime() > STALL_WARN_MS;
  const timeoutMin = p.timeoutMs ? Math.round(p.timeoutMs / 60000) : null;
  return (
    <div className="muted" style={{ fontSize: 12, padding: '2px 0 6px 18px', color: stalled ? 'var(--warn,#b8860b)' : undefined }}>
      ⏳ {p.toolCalls} tool calls · {dur(p.startedAt)}{timeoutMin ? ` / ${timeoutMin}m` : ''} elapsed
      {p.lastTool ? <> · last: <span className="mono">{p.lastTool.slice(0, 60)}</span> ({ago(p.lastToolAt)})</> : ' · waiting for first tool call'}
      {stalled && ' · ⚠ no activity for a while'}
    </div>
  );
}

/**
 * Per-task panel (M11 WP2): what this task was Asked (its exact rendered prompt),
 * Said (final result text), Changed (files + patch), and Cost (turns/tokens/USD).
 * Everything comes from data already fetched — prompt/patch from artifactVersions
 * (by task_id), result/diff from the run's events — so no extra request.
 */
function TaskPanel({ task, versions, events }: { task: RunTask; versions: Version[]; events: RunEvent[] }) {
  const [tab, setTab] = useState<'asked' | 'said' | 'changed' | 'cost'>('asked');
  const forTask = (name: string) => versions.find((v) => v.taskId === task.id && v.name === name)?.content ?? null;
  const prompt = forTask(`${task.role}.prompt.md`);
  const patch = forTask(`${task.role}.patch`);
  const evForTask = (kind: string) => [...events].reverse().find((e) => e.kind === kind && e.taskId === task.id);
  const result = evForTask('segment:result')?.payload as Record<string, unknown> | undefined;
  const diff = evForTask('segment:diff')?.payload as Record<string, unknown> | undefined;
  const started = evForTask('segment:started')?.payload as Record<string, unknown> | undefined;
  // #41: the role didn't write its file, so its reply was saved as the artifact.
  const fromReply = evForTask('artifact:from_reply')?.payload as Record<string, unknown> | undefined;
  const usage = (result?.usage ?? null) as { inputTokens?: number; outputTokens?: number } | null;
  const files = (diff?.files ?? []) as Array<{ path: string; insertions: number; deletions: number }>;

  const Tab = ({ id, label }: { id: typeof tab; label: string }) => (
    <a onClick={() => setTab(id)} style={{ cursor: 'pointer', marginRight: 12, color: tab === id ? 'var(--accent)' : 'var(--muted)' }}>{label}</a>
  );
  return (
    <div className="card" style={{ margin: '4px 0 10px', background: 'var(--bg-subtle, rgba(0,0,0,0.02))' }}>
      <div className="row" style={{ marginBottom: 6 }}>
        <Tab id="asked" label="Asked" /><Tab id="said" label="Said" />{task.outputRef || diff ? <Tab id="changed" label="Changed" /> : null}<Tab id="cost" label="Cost" />
      </div>
      {tab === 'asked' && (prompt
        ? <pre className="artifact">{prompt}</pre>
        : <div className="muted">No prompt recorded for this attempt (older run, or the task hasn't started).</div>)}
      {tab === 'said' && fromReply && <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>This role didn't write <span className="mono">{String(fromReply.name)}</span>, so its reply below was saved as it.</div>}
      {tab === 'said' && (result
        ? <pre className="artifact">{String(result.text || '(no result text)')}{result.terminalReason ? `\n\n[stopped: ${result.terminalReason}]` : ''}</pre>
        : <div className="muted">No result recorded yet.</div>)}
      {tab === 'changed' && (diff
        ? <div>
            <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>{String(diff.filesChanged)} files · +{String(diff.insertions)} −{String(diff.deletions)} · <span className="mono">{String(diff.commit).slice(0, 8)}</span></div>
            {files.map((f) => <div key={f.path} className="mono" style={{ fontSize: 12 }}>{f.path} <span style={{ color: 'var(--good)' }}>+{f.insertions}</span> <span style={{ color: 'var(--bad)' }}>−{f.deletions}</span></div>)}
            {patch && <details style={{ marginTop: 6 }}><summary className="muted">patch</summary><pre className="artifact">{patch}</pre></details>}
          </div>
        : <div className="muted">This role made no committed changes.</div>)}
      {tab === 'cost' && (
        <div className="muted" style={{ fontSize: 13 }}>
          <div>model: <span className="mono">{task.model ?? '—'}</span></div>
          <div>turns: {result?.turns != null ? String(result.turns) : '—'}{started?.maxTurns ? ` / ${String(started.maxTurns)} ceiling` : ''}</div>
          <div>tokens: {usage ? `${usage.inputTokens ?? 0} in · ${usage.outputTokens ?? 0} out` : '—'}</div>
          <div>cost: {taskCostText(task, 4)}</div>
        </div>
      )}
    </div>
  );
}


/**
 * Stage output, now versioned (M11 WP1). Each artifact name that has more than
 * one stored version (a review loop produces review.md #1/#2/#3) gets a version
 * selector and a diff toggle against the previous version — so a repeated
 * REQUEST_CHANGES reads as three near-identical reviews at a glance, instead of
 * the single overwritten row the UI used to show.
 */
function ArtifactVersions({ artifacts, versions, tasks }: { artifacts: RunDetail['artifacts']; versions: Version[]; tasks: RunTask[] }) {
  // Fall back to the flat latest-only list when the api didn't send versions (older api).
  const names = versions.length
    ? [...new Set(versions.map((v) => v.name))]
    : artifacts.map((a) => a.name);
  if (names.length === 0) return null;
  const roleOfTask = (id: string | null) => (id ? String(tasks.find((t) => t.id === id)?.role ?? '') : '');
  return (
    <div className="card">
      <b>Stage output</b>
      <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>What each stage produced. Implementation and test code is in the change request's “files changed”.</div>
      {[...names].sort((a, b) => stageOrder(a) - stageOrder(b)).map((name) => {
        const forName = versions.filter((v) => v.name === name); // newest first (api order)
        const flat = artifacts.find((a) => a.name === name);
        return (
          <ArtifactBlock key={name} name={name} versions={forName} fallback={flat?.content ?? ''} roleOf={roleOfTask} open={name === 'review.md'} />
        );
      })}
    </div>
  );
}

function ArtifactBlock({ name, versions, fallback, roleOf, open }: { name: string; versions: Version[]; fallback: string; roleOf: (id: string | null) => string; open: boolean }) {
  const [idx, setIdx] = useState(0);        // 0 = newest
  const [showDiff, setShowDiff] = useState(false);
  const has = versions.length > 0;
  const cur = has ? versions[idx] : null;
  const prev = has && idx + 1 < versions.length ? versions[idx + 1] : null;
  const label = (v: Version, i: number) => {
    const role = roleOf(v.taskId) || (v.source === 'human' ? 'human' : 'stage');
    const when = new Date(v.createdAt).toLocaleTimeString();
    return `${role}${v.source === 'human' ? ' (edited)' : ''} · #${versions.length - i} · ${when}`;
  };
  return (
    <details style={{ marginTop: 8 }} open={open}>
      <summary className="mono">{ARTIFACT_LABEL[name] ?? name}{versions.length > 1 ? ` · ${versions.length} versions` : ''}</summary>
      {has && versions.length > 1 && (
        <div className="row" style={{ gap: 8, margin: '6px 0', flexWrap: 'wrap' }}>
          <select value={idx} onChange={(e) => setIdx(Number(e.target.value))}>
            {versions.map((v, i) => <option key={i} value={i}>{label(v, i)}</option>)}
          </select>
          {prev && <label className="muted" style={{ fontSize: 12 }}><input type="checkbox" checked={showDiff} onChange={(e) => setShowDiff(e.target.checked)} /> diff vs previous</label>}
        </div>
      )}
      {showDiff && prev
        ? <pre className="artifact">{renderLineDiff(prev.content, cur!.content)}</pre>
        : <pre className="artifact">{cur ? cur.content : fallback}</pre>}
    </details>
  );
}

/** Minimal LCS line diff → unified-ish text (+/-/space), no dependency. Good enough to spot a repeated review. */
function renderLineDiff(a: string, b: string): string {
  const x = a.split('\n'), y = b.split('\n');
  const n = x.length, m = y.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: string[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push('  ' + x[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push('- ' + x[i]); i++; }
    else { out.push('+ ' + y[j]); j++; }
  }
  while (i < n) out.push('- ' + x[i++]);
  while (j < m) out.push('+ ' + y[j++]);
  return out.join('\n');
}


const FEEDBACK_FROM: Record<string, string> = {
  gate_reject: 'you asked',
  loop_back: 'review asked',
  needs_human_answer: 'you answered',
  chat: 'you replied in the chat',
  retry: 'retried',
  merge_conflict: 'merge conflict',
  pr_feedback: 'PR feedback',
};
/** What came back on a try: `· you asked: "…"`, `· approved`, or nothing. */
function feedbackText(a: Attempt): string {
  if (!a.feedback) return '';
  if (!a.feedbackBy) return ` · ${a.feedback}`;
  return ` · ${FEEDBACK_FROM[a.feedbackBy] ?? a.feedbackBy.replace(/_/g, ' ')}: "${a.feedback}"`;
}

/**
 * Review-loop provenance (M11 WP3): show how many implementer↻reviewer cycles ran
 * against the bound, each verdict line, and whether the loop was EXHAUSTED (the
 * reviewer still wanted changes at the cap, so the run went to a gate rather than
 * looping again — the thing that used to be an invisible, money-burning surprise).
 */
/**
 * Ask for changes on the open MR/PR (#157). The same run re-plans with your feedback
 * as a planner chat turn — you talk the revised plan through in the chat above —
 * then the team re-runs and pushes onto this same PR. Styled like PlanChat's reply box.
 */
function RequestChanges({ runId, onDone }: { runId: string; onDone: () => void }) {
  const me = useMe();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const send = async () => {
    if (!text.trim()) return;
    setBusy(true); setErr(null);
    const res = await api.requestChanges(runId, text, me.user);
    setBusy(false);
    if (res.status >= 400) { setErr(res.body?.reason ?? `failed (${res.status})`); return; }
    setText(''); onDone();
  };
  return (
    <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
      <b>Request changes</b>
      <div className="muted" style={{ fontSize: 13, margin: '4px 0 0' }}>
        Say what should change. The planner revises the plan with you, then the team updates this same pull request.
      </div>
      <textarea rows={3} style={{ marginTop: 10 }} disabled={busy} value={text}
        placeholder="What should change?"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send(); }} />
      {err && <div style={{ color: 'var(--bad)', marginTop: 6 }}>{err}</div>}
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn" onClick={send} disabled={busy || !text.trim()}>Request changes</button>
      </div>
    </div>
  );
}

/**
 * A review-only run's review stays in ASF until you post it: line comments for each
 * `path:line` finding, plus one summary comment, on the pull request it reviewed.
 */
function PostReview({ runId, url, posted, onDone }: { runId: string; url: string; posted: boolean; onDone: () => void }) {
  const me = useMe();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const post = async () => {
    if (!confirm(`Post this review as comments on ${url}?`)) return;
    setBusy(true); setMsg(null);
    const res = await api.postReview(runId, me.user).catch(() => null);
    setBusy(false);
    if (!res || res.status >= 400) { setMsg({ ok: false, text: res?.body.reason ?? `failed (${res?.status ?? 'network'})` }); return; }
    const { anchored = 0, fallback = 0 } = res.body;
    setMsg({ ok: true, text: `Posted ${anchored} line comment${anchored === 1 ? '' : 's'}${fallback ? `; ${fallback} couldn't be anchored and went in the summary` : ''}.` });
    onDone();
  };
  // Once posted the card goes away, unless you just posted it here: then it shows the counts.
  if (posted && !msg) return null;
  return (
    <div className="card">
      <b>Review</b>
      <div className="muted" style={{ fontSize: 13, margin: '4px 0 0' }}>The review is only in ASF. Post it to <a href={url} target="_blank" rel="noreferrer">the pull request</a> as comments.</div>
      {msg && <div style={{ color: msg.ok ? 'var(--good)' : 'var(--bad)', marginTop: 6 }}>{msg.text}</div>}
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn primary" onClick={post} disabled={busy || msg?.ok}>Post comments to PR</button>
      </div>
    </div>
  );
}

function LoopBanner({ events, run }: { events: RunEvent[]; run: RunDetail['run'] }) {
  const loops = events.filter((e) => e.kind === 'review:loop');
  const exhausted = events.find((e) => e.kind === 'loop:exhausted');
  if (loops.length === 0 && !exhausted) return null;
  const max = run.team.loop?.maxIterations ?? 0;
  return (
    <div className="card" style={exhausted ? { borderColor: 'var(--warn, #b8860b)' } : undefined}>
      <b>Review loop {Math.min(loops.length, max)}/{max}{exhausted ? ' · exhausted' : ''}</b>
      <div className="log" style={{ marginTop: 6 }}>
        {loops.map((e, i) => (
          <div className="ev" key={i}><span className="muted">iter {String((e.payload as Record<string, unknown>).iteration ?? i + 1)}</span> {String((e.payload as Record<string, unknown>).verdictLine ?? 'REQUEST_CHANGES')}</div>
        ))}
        {exhausted && (
          <div className="ev" style={{ color: 'var(--warn, #b8860b)' }}>
            reviewer still requested changes after {String((exhausted.payload as Record<string, unknown>).iterations)} iterations — sent to a gate for a human decision instead of looping again.
          </div>
        )}
      </div>
    </div>
  );
}


function summarize(e: RunEvent): string {
  const p = e.payload as Record<string, unknown>;
  if (e.kind === 'tool:pre' || e.kind === 'tool:post') return String(p.summary ?? p.tool ?? '');
  if (e.kind.startsWith('gate:')) return String(p.gate ?? '');
  if (e.kind === 'task:finished' || e.kind === 'segment:finished') return `${p.role ?? ''} ${p.outcome ?? ''}`;
  if (e.kind === 'review:posted') return `posted to the PR: ${p.anchored ?? 0} line comments, ${p.fallback ?? 0} unanchored${p.by ? ` · by ${p.by}` : ''}`;
  return Object.entries(p).slice(0, 3).map(([k, v]) => `${k}=${v}`).join(' ');
}
