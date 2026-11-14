import type { AdhocTask, WorkQueueEntry } from '@asf/shared';
import { addedBy } from '../new-task';
import { refusalFor, wherePill } from '../refusal-words';
import { PAGE as TITLES } from '../words';

/**
 * Ad-hoc tasks added here (no tracker ticket), shown above the board. A task the
 * queue couldn't start shows "Couldn't start" in its title cell with the reason
 * wrapping under it (no extra column, so the table still fits a phone).
 */
export function AddedHere({ tasks, repos, refused, blocked, onStart, onRemove }: {
  tasks: AdhocTask[];
  repos: { id: string; path: string }[];
  refused: WorkQueueEntry[];
  blocked: boolean;
  onStart: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  if (tasks.length === 0) return null;
  return (
    <div style={{ marginBottom: 16 }}>
      <div className="row between" style={{ marginBottom: 6 }}>
        <span className="muted">Added here</span>
      </div>
      <div className="card table-wrap" style={{ padding: 0 }}>
        <table>
          <thead><tr><th>Title</th><th>Added by</th><th></th></tr></thead>
          <tbody>
            {tasks.map((t) => {
              const r = refusalFor(refused, t.id);
              const pill = r ? wherePill('', r) : null;
              return (
                <tr key={t.id}>
                  <td>
                    {t.title}
                    {pill && <> <span className="pill">{pill.label}</span></>}
                    {pill?.note && <div className="muted" style={{ fontSize: '0.85em', overflowWrap: 'anywhere', marginTop: 4 }}>{pill.note}</div>}
                  </td>
                  <td className="muted">{addedBy(t, repos)}</td>
                  <td className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
                    <button className="btn" disabled={blocked} onClick={() => onStart(t.id)}
                      title={blocked ? 'Connect a repository first' : 'Choose the repository and models, then run it'}>Start</button>
                    <button className="btn ghost" onClick={() => onRemove(t.id)} title={`Remove from ${TITLES.todo}`}>Remove</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
