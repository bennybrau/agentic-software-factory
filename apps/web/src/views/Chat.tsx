import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ADHOC_DEFAULT_LIMITS, type AdhocLimits } from '@asf/shared/ui';
import { api, subscribeEvents, type RunDetail } from '../api';
import { chatProblem, chatTitle, pickChatRepo } from '../new-task';
import { chatStatus } from '../chat-status';
import { PAGE } from '../words';
import { useMe } from '../useMe';
import { SetupNotice } from '../components/q/SetupNotice';
import { AttachmentList, pickedMeta, useAttachments } from '../components/Attachments';
import { PlanChat } from '../components/PlanChat';
import { NoRepo } from './Dispatch';

/** Why a chat couldn't start. `saved` = the task was created, so it waits in To-do. */
interface Failure { reason: string; blocker?: { reason: string; link: string } | null; saved: boolean }

/**
 * The landing page: say what we should work on, in plain words with any
 * screenshots or files. Sending saves it as an ad-hoc task, starts it in the
 * suggested repository and opens the conversation with the Orchestrator.
 */
export function Chat() {
  const navigate = useNavigate();
  const me = useMe();
  const [text, setText] = useState('');
  const [limits, setLimits] = useState<AdhocLimits>(ADHOC_DEFAULT_LIMITS);
  const [err, setErr] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const att = useAttachments(limits, setErr);

  useEffect(() => { api.adhocLimits().then(setLimits).catch(() => {}); }, []);
  // The composer grows with what's typed (the CSS caps its height).
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  const problem = chatProblem(text, att.files.map(pickedMeta), limits);

  const send = async () => {
    if (problem) { setErr(problem); return; }
    setBusy(true); setErr(null); setFailure(null);
    try {
      const files = await att.payload();
      const created = await api.createAdhoc({ title: chatTitle(text), body: text, files, chat: true });
      const task = created.body.task;
      if (created.status !== 201 || !task) { setFailure({ reason: created.body.reason ?? `Couldn’t save it (${created.status}).`, saved: false }); return; }
      setText(''); att.clear();
      const preview = await api.dispatchPreview(task.id).catch((e) => { setFailure({ reason: String(e), saved: true }); return null; });
      if (!preview) return;
      if (preview.blocker) { setFailure({ reason: preview.blocker.reason, blocker: preview.blocker, saved: true }); return; }
      const { status, body } = await api.dispatch(task.id, { repoId: pickChatRepo(preview) ?? undefined, by: me.user });
      if (status === 201) navigate(`/chat/${body.run.id}`);
      else setFailure({ reason: body.reason || `Couldn’t start it (${status}).`, saved: true });
    } catch (e) {
      setFailure({ reason: String(e), saved: false });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="chat-empty">
      <SetupNotice />
      <h2>What should we work on?</h2>
      <p className="muted">Describe it as you would to a colleague. The Orchestrator plans it with you, then proposes the tasks to queue.</p>

      <div className={`card chat-composer${att.dragging ? ' dragging' : ''}`} {...att.dropProps}>
        <textarea ref={box} value={text} rows={4} autoFocus disabled={busy} aria-label="What should we work on?"
          placeholder={'What should change, and why? Paste or drop screenshots here.'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} />
        <AttachmentList files={att.files} onRemove={att.remove} />
        <div className="row between">
          <button className="btn ghost sm" onClick={att.pick} disabled={busy || att.files.length >= limits.maxFiles}
            title={`Up to ${limits.maxFiles} files, ${limits.maxFileMb} MB each: images, plain text or PDF`}>Add files</button>
          {att.fileInput}
          <button className="btn" onClick={send} disabled={busy || Boolean(problem)} title={problem ?? 'Enter sends, Shift+Enter adds a line'}>
            {busy ? 'Starting…' : 'Send'}
          </button>
        </div>
      </div>

      {err && <div style={{ color: 'var(--bad)' }}>{err}</div>}
      {failure && (
        <div style={{ marginTop: 8 }}>
          {failure.blocker ? <NoRepo reason={failure.blocker.reason} link={failure.blocker.link} /> : <div style={{ color: 'var(--bad)' }}>{failure.reason}</div>}
          {failure.saved && <div className="muted" style={{ marginTop: 6 }}>Saved to <Link to="/backlog">{PAGE.todo}</Link>, so you can start it from there.</div>}
        </div>
      )}
    </div>
  );
}

/** The conversation with the Orchestrator for one run, until its tasks are queued. */
export function ChatRun() {
  const { runId = '' } = useParams();
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [repos, setRepos] = useState<{ id: string; path: string }[]>([]);
  const load = useCallback(() => { api.run(runId).then(setDetail).catch(() => {}); }, [runId]);

  useEffect(() => {
    load();
    return subscribeEvents((e) => { if (e.runId === runId) load(); });
  }, [runId, load]);
  useEffect(() => { api.startReadiness().then((r) => { if (r.ok) setRepos(r.repos); }).catch(() => {}); }, []);

  // While a task runs, refresh every 5s in case a quiet stretch sends no events.
  const anyRunning = detail?.tasks.some((t) => t.state === 'running') ?? false;
  useEffect(() => {
    if (!anyRunning) return;
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [anyRunning, load]);

  if (!detail) return <p className="muted">Loading…</p>;
  const { run, tasks, gates } = detail;
  const planGate = gates.find((g) => g.state === 'open' && g.gateName === 'after_plan') ?? null;
  const plannerTask = [...tasks].filter((t) => String(t.role) === 'planner').sort((a, b) => b.seq - a.seq)[0] ?? null;
  const repo = repos.find((r) => r.id === run.repoId)?.path ?? run.repoId;

  return (
    <div>
      <Link to="/">← New chat</Link>
      <h2 style={{ margin: '6px 0 12px' }}><span className="mono">{run.ticketKey}</span></h2>
      <PlanChat runId={runId} ticketId={run.ticketId} ticketKey={run.ticketKey} messages={detail.messages ?? []}
        gate={planGate} plannerTask={plannerTask} onDone={load} who="Orchestrator" variant="page" repo={repo}
        status={chatStatus(detail, repo)} opening={detail.request} />
    </div>
  );
}
