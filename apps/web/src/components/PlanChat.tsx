import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { GateWire, RunMessageWire, RunTask } from '@asf/shared';
import { parseSplit, isNotNeeded, notNeededReason } from '@asf/shared/ui';
import { NotNeededActions } from './NotNeededActions';
import { api } from '../api';
import { useMe } from '../useMe';
import { chatTitle } from '../new-task';

/**
 * The plan stage as a conversation. The planner either asks what blocks it or
 * proposes a plan; you reply in plain words until it's right, then approve and
 * the rest of the team (build, test, review) just goes. Replaces the plan-gate
 * approve/reject form and the planner's needs-human card.
 *
 * `variant="page"` is the Orchestrator chat (/chat/:runId): a tall thread with the
 * composer stuck to the bottom, and the plan shown as the tasks it would queue.
 */
export function PlanChat({ runId, ticketId, ticketKey, messages, gate, plannerTask, onDone, who = 'Planner', variant = 'card', repo = null }: {
  runId: string;
  ticketId: string;
  ticketKey: string;
  messages: RunMessageWire[];
  gate: GateWire | null;            // the open after_plan gate, if the plan is waiting on you
  plannerTask: RunTask | null;      // the latest planner task (running / needs_human / done)
  onDone: () => void;
  who?: string;                     // who the agent's messages are from
  variant?: 'card' | 'page';
  repo?: string | null;             // the run's repository, for parts that don't name one (page variant)
}) {
  const me = useMe();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [edited, setEdited] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const thinking = plannerTask?.state === 'running' || plannerTask?.state === 'pending';
  const asking = plannerTask?.state === 'needs_human';
  // The planner checked and found the work isn't needed: offer to cancel instead of a plan.
  const notNeeded = asking && isNotNeeded(plannerTask?.reason);
  const canReply = Boolean(gate) || asking;
  // A plan that splits the ticket: approving creates and queues the parts instead of building it.
  const planText = editing && edited != null ? edited : gate?.artifact ?? null;
  const split = parseSplit(planText);

  // A run from before the chat existed has no messages: show its question from the task.
  const thread: Array<Pick<RunMessageWire, 'id' | 'author' | 'kind' | 'body' | 'by'>> = messages.length
    ? messages
    : asking && plannerTask?.reason ? [{ id: 'legacy', author: 'agent', kind: 'question', body: plannerTask.reason, by: null }] : [];

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest' }); }, [thread.length, thinking]);

  const send = async () => {
    if (!text.trim()) return;
    setBusy(true); setErr(null);
    const res = await api.chat(runId, text, me.user);
    setBusy(false);
    if (res.status >= 400) { setErr(res.body?.reason ?? `failed (${res.status})`); return; }
    setText(''); onDone();
  };
  const approve = async () => {
    if (!gate) return;
    setBusy(true); setErr(null);
    await api.resolveGate(gate.id, 'approve', me.user, undefined, editing && edited != null ? edited : undefined)
      .catch((e) => setErr(String(e).replace(/^Error: 409 /, '').replace(/^\{.*"reason":"(.*)"\}$/s, '$1')));
    setBusy(false); onDone();
  };
  const skip = async () => {
    setBusy(true); setErr(null);
    const res = await api.skipRole(runId, me.user);
    setBusy(false);
    if (res.status >= 400) { setErr(res.body?.reason ?? `failed (${res.status})`); return; }
    onDone();
  };

  const threadView = (
    <div className="chat-thread">
      {thread.map((m) => (
        <div key={m.id} className={`chat-msg ${m.author}`}>
          <div className="chat-who">{m.author === 'agent' ? (isNotNeeded(m.body) ? `${who}: not needed` : m.kind === 'question' ? `${who} asks` : who) : (m.by || 'You')}</div>
          {m.author === 'agent'
            ? <div className="chat-body ticket-desc chat-md"><ReactMarkdown remarkPlugins={[remarkGfm]}>{isNotNeeded(m.body) ? notNeededReason(m.body) : m.body}</ReactMarkdown></div>
            : <div className="chat-body">{isNotNeeded(m.body) ? notNeededReason(m.body) : m.body}</div>}
        </div>
      ))}
      {thinking && <div className="chat-msg agent"><div className="chat-who">{who}</div><div className="chat-body muted">Thinking…</div></div>}
      <div ref={endRef} />
    </div>
  );

  if (variant === 'page') {
    // One proposed task per split part, or the whole plan as one.
    const proposed = split.kind === 'ok'
      ? split.subtasks.map((s) => ({ title: s.title, repo: s.repo ?? repo, after: s.dependsOn }))
      : [{ title: chatTitle(planText ?? '').replace(/^Plan:\s*/i, ''), repo, after: [] as number[] }];
    return (
      <div className="chat-page">
        {threadView}

        {gate && split.kind !== 'invalid' && (
          <div className="card chat-proposed">
            <b>Proposed tasks</b>
            <ol>
              {proposed.map((p, i) => (
                <li key={i}>
                  <span>{p.title}</span>
                  <span className="muted small">
                    {p.repo && <span className="mono">{p.repo}</span>}
                    {p.after.length > 0 && <span>after {p.after.map((d) => `#${d}`).join(', ')}</span>}
                  </span>
                </li>
              ))}
            </ol>
            <details className="chat-plan">
              <summary className="muted small">The full plan</summary>
              <pre className="artifact">{gate.artifact}</pre>
            </details>
            <button className="btn good" onClick={approve} disabled={busy}>
              {split.kind === 'ok' ? `Queue these ${split.subtasks.length} tasks` : 'Queue this task'}
            </button>
          </div>
        )}
        {gate && split.kind === 'invalid' && (
          <div style={{ color: 'var(--bad)' }}>The proposed tasks can't be used: {split.reason}. Ask the {who.toLowerCase()} to fix them.</div>
        )}

        {notNeeded && <NotNeededActions runId={runId} ticketId={ticketId} ticketKey={ticketKey} onDone={onDone} />}

        {canReply && (
          <div className="chat-composer">
            {err && <div style={{ color: 'var(--bad)' }}>{err}</div>}
            <div className="row">
              <textarea rows={2} disabled={busy} value={text} aria-label={`Message the ${who.toLowerCase()}`}
                placeholder={asking ? `Answer the ${who.toLowerCase()}…` : 'Ask a question or ask for a change…'}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} />
              <button className="btn" onClick={send} disabled={busy || !text.trim()}>Send</button>
              {asking && !gate && !notNeeded && <button className="btn ghost" onClick={skip} disabled={busy} title="Go on without a plan">Skip planning</button>}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="card chat" style={canReply ? { borderColor: 'var(--warn)' } : undefined}>
      <div className="row between">
        <b>💬 Plan it with the planner</b>
        {canReply ? <span className="pill awaiting_checkpoint">waiting on you</span>
          : thinking ? <span className="pill running">thinking…</span> : null}
      </div>
      <div className="muted" style={{ fontSize: 13, margin: '6px 0 10px' }}>
        Talk it through until the plan is right. Once you approve it, the team builds, tests and reviews it on its own.
      </div>

      {threadView}

      {gate?.artifact != null && (
        <details open className="chat-plan">
          <summary><b>The plan</b> <span className="muted">(plan.md)</span></summary>
          {editing
            ? <textarea rows={12} value={edited ?? gate.artifact} onChange={(e) => setEdited(e.target.value)} />
            : <pre className="artifact">{gate.artifact}</pre>}
          <button type="button" className="btn ghost" style={{ marginTop: 6 }} onClick={() => { setEditing(!editing); if (!editing) setEdited(gate.artifact); }}>
            {editing ? 'Stop editing' : 'Edit it myself'}
          </button>
        </details>
      )}

      {gate && split.kind === 'ok' && (
        <div className="split-card">
          <b>The planner suggests splitting this into {split.subtasks.length} tasks</b>
          <div className="muted" style={{ fontSize: 13, margin: '4px 0 8px' }}>
            Approving adds each one to Up next. Each gets its own plan and pull request, and starts only after the tasks it depends on are merged.
          </div>
          <ol className="split-parts">
            {split.subtasks.map((s, i) => (
              <li key={i}>
                <span>{s.title}</span>
                <span className="muted">{s.dependsOn.length ? ` · after ${s.dependsOn.map((d) => `#${d}`).join(', ')} is merged` : ' · can start right away'}</span>
              </li>
            ))}
          </ol>
          <div className="muted" style={{ fontSize: 13 }}>Rather keep it as one? Say so below, or edit the plan and remove the split.</div>
        </div>
      )}
      {gate && split.kind === 'invalid' && (
        <div style={{ color: 'var(--bad)', marginTop: 8 }}>The plan's split can't be used: {split.reason}. Ask the planner to fix it, or edit the plan.</div>
      )}

      {notNeeded && <NotNeededActions runId={runId} ticketId={ticketId} ticketKey={ticketKey} onDone={onDone} />}

      {canReply && (
        <>
          <textarea rows={3} style={{ marginTop: 10 }} disabled={busy} value={text}
            placeholder={notNeeded ? 'Still needed? Say why and the planner plans it…' : asking ? 'Answer the planner…' : 'Ask a question or ask for a change…'}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send(); }} />
          {err && <div style={{ color: 'var(--bad)', marginTop: 6 }}>{err}</div>}
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn" onClick={send} disabled={busy || !text.trim()}>Send</button>
            {gate && <button className="btn good" onClick={approve} disabled={busy || split.kind === 'invalid'}>
              {split.kind === 'ok' ? `Approve & create ${split.subtasks.length} tasks`
                : editing && edited != null && edited !== gate.artifact ? 'Approve my edited plan' : 'Approve plan & build it'}
            </button>}
            {asking && !gate && !notNeeded && <button className="btn ghost" onClick={skip} disabled={busy} title="Go on without a plan">Skip planning</button>}
          </div>
        </>
      )}
    </div>
  );
}
