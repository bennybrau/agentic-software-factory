import { useState } from 'react';
import type { Run, RunTask } from '@asf/shared';
import { parseRef } from '@asf/shared/ui';
import { api } from '../api';
import { hostBadge } from '../repo-groups';
import { RepoSelect } from './RepoSelect';

type Repo = { id: string; path: string };

/**
 * Whether a run can move to another repo (M10 WP5): it is waiting (queued, or parked
 * at a gate or a question), has no PR open and isn't a review of one. The registry
 * checks the same and says why when it refuses anyway.
 */
export function canMove(run: Pick<Run, 'state' | 'changeRequestNumber' | 'team'>): boolean {
  return (run.state === 'queued' || run.state === 'awaiting_checkpoint') && run.changeRequestNumber == null && !run.team.reviewTarget;
}

/** The planner is asking a question: the likeliest moment to find the run is in the wrong repo. */
export function moveProminent(tasks: readonly Pick<RunTask, 'role' | 'state' | 'seq'>[]): boolean {
  const planner = [...tasks].filter((t) => String(t.role) === 'planner').sort((a, b) => b.seq - a.seq)[0];
  return planner?.state === 'needs_human';
}

/** A repository's path for a person: the connected one's, else the id without its host. */
export function repoPath(repoId: string, repos: readonly Repo[]): string {
  return repos.find((r) => r.id === repoId)?.path ?? parseRef(repoId, '').native;
}

/** Move the run; null when it moved, else the reason it was refused. */
export async function submitMove(runId: string, repoId: string, note: string): Promise<string | null> {
  try {
    const r = await api.moveRun(runId, repoId, note);
    return r.status === 200 ? null : r.body.reason ?? `the move failed (${r.status})`;
  } catch (e) {
    return (e as Error).message;
  }
}

/** The run's repository under the title, with its code host when there are several. */
export function RepoLine({ repoId, repos, scm }: { repoId: string | null; repos: readonly Repo[]; scm: readonly string[] }) {
  if (!repoId) return null;
  const host = hostBadge(repoId, scm);
  return (
    <div className="muted repo-line" style={{ fontSize: 13 }}>
      In <span className="mono">{repoPath(repoId, repos)}</span>{host && <span className="pill source">{host}</span>}
    </div>
  );
}

export interface MoveRepoViewProps {
  prominent: boolean; open: boolean; confirming: boolean; busy: boolean; err: string | null;
  repos: readonly Repo[]; scm: readonly string[]; currentRepoId: string | null; repoId: string; note: string;
  onOpen: () => void; onCancel: () => void; onRepo: (id: string) => void; onNote: (s: string) => void;
  onNext: () => void; onBack: () => void; onConfirm: () => void;
}

/** The move card: what moving does, the repo picker and note, then a Confirm step. */
export function MoveRepoView(p: MoveRepoViewProps) {
  if (!p.prominent && !p.open) return null;
  const choices = p.repos.filter((r) => r.id !== p.currentRepoId);
  const target = p.repoId ? repoPath(p.repoId, p.repos) : '';
  return (
    <div className="card move-repo" style={p.prominent ? { borderColor: 'var(--accent)' } : undefined}>
      <b>Move to another repo</b>
      <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
        {p.prominent ? 'If the planner is looking in the wrong repository, move the run. ' : ''}
        The work so far is set aside and the team starts again from the planner in the repository you choose.
      </div>
      {!p.open && <div style={{ marginTop: 8 }}><button className="btn primary" onClick={p.onOpen}>Move to another repo</button></div>}
      {p.open && !p.confirming && (
        <div className="move-repo-form" style={{ marginTop: 8 }}>
          {choices.length
            ? <RepoSelect wide repos={choices} scm={p.scm} value={p.repoId} onChange={p.onRepo} placeholder="Choose…" aria-label="Move to repository" />
            : <div className="muted" style={{ fontSize: 13 }}>No other repository is connected.</div>}
          <input value={p.note} onChange={(e) => p.onNote(e.target.value)} placeholder="Why (optional)" aria-label="Why move" style={{ minWidth: 0 }} />
          <div className="row">
            <button className="btn" disabled={!p.repoId} onClick={p.onNext}>Move…</button>
            <button className="btn ghost" onClick={p.onCancel}>Cancel</button>
          </div>
        </div>
      )}
      {p.open && p.confirming && (
        <div className="move-repo-form" style={{ marginTop: 8 }}>
          <div style={{ fontSize: 13, overflowWrap: 'anywhere' }}>Move this run to <span className="mono">{target}</span> and start again from the planner?</div>
          <div className="row">
            <button className="btn primary" disabled={p.busy} onClick={p.onConfirm}>Confirm</button>
            <button className="btn ghost" disabled={p.busy} onClick={p.onBack}>Back</button>
          </div>
        </div>
      )}
      {p.err && <div style={{ color: 'var(--bad)', fontSize: 13, marginTop: 6 }}>{p.err}</div>}
    </div>
  );
}

/**
 * Move a run to another repo from the run page. Shown while the run can move: as a
 * card when the planner is asking, otherwise behind the header's ghost button
 * (`open`/`onOpen`/`onClose`, held by the page). After a move the page's live
 * refresh (the pushed run:moved event) hides it and shows the new repository.
 */
export function MoveRepo({ runId, run, tasks, repos, scm, open, onOpen, onClose, onDone }: {
  runId: string; run: Pick<Run, 'state' | 'changeRequestNumber' | 'team' | 'repoId'>; tasks: readonly RunTask[];
  repos: readonly Repo[]; scm: readonly string[]; open: boolean; onOpen: () => void; onClose: () => void; onDone: () => void;
}) {
  const [repoId, setRepoId] = useState('');
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!canMove(run)) return null;
  const reset = () => { setRepoId(''); setNote(''); setConfirming(false); setErr(null); };
  const confirm = async () => {
    setBusy(true); setErr(null);
    const refused = await submitMove(runId, repoId, note);
    setBusy(false);
    if (refused) { setErr(refused); setConfirming(false); return; }
    reset(); onClose(); onDone();
  };
  return (
    <MoveRepoView prominent={moveProminent(tasks)} open={open} confirming={confirming} busy={busy} err={err}
      repos={repos} scm={scm} currentRepoId={run.repoId} repoId={repoId} note={note}
      onOpen={onOpen} onCancel={() => { reset(); onClose(); }} onRepo={setRepoId} onNote={setNote}
      onNext={() => setConfirming(true)} onBack={() => setConfirming(false)} onConfirm={() => void confirm()} />
  );
}
