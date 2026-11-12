import { useEffect, useState } from 'react';
import { api, type ReviewThreadsWire } from '../api';
import { useMe } from '../useMe';
import { addressPayload, buttonState, clip, where } from '../address-review';

/**
 * Send the open review threads on this run's PR/MR back to the team (#109). You pick
 * which threads; the planner gets them as a Request changes turn, so progress shows in
 * the planner chat as it does there. Threads are re-read only when `refreshKey` changes,
 * not on every event, because each read goes to the source-control system.
 */
export function AddressReviewComments({ runId, refreshKey, onDone }: { runId: string; refreshKey: string; onDone: () => void }) {
  const me = useMe();
  const [res, setRes] = useState<ReviewThreadsWire | 'error' | null>(null);
  const [open, setOpen] = useState(false);
  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.reviewThreads(runId).then((r) => { if (alive) setRes(r); }).catch(() => { if (alive) setRes('error'); });
    return () => { alive = false; };
  }, [runId, refreshKey]);

  const flip = (s: Set<string>, id: string) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; };
  const threads = res && res !== 'error' ? res.threads : [];

  const confirm = async () => {
    const p = addressPayload(threads, unticked, note);
    if (!p.threadIds.length) return;
    setBusy(true); setErr(null);
    const r = await api.addressReviewComments(runId, p.threadIds, p.note, me.user).catch((e: Error) => ({ status: 0, body: { reason: e.message } }));
    setBusy(false);
    if (r.status === 0 || r.status >= 400) { setErr(r.body?.reason ?? `failed (${r.status})`); return; }
    setOpen(false); setUnticked(new Set()); setNote(''); onDone();
  };

  return (
    <AddressReviewCommentsView res={res} open={open} unticked={unticked} expanded={expanded} note={note} busy={busy} err={err}
      onOpen={() => { setOpen(true); setErr(null); }}
      onCancel={() => { setOpen(false); setErr(null); }}
      onTick={(id) => setUnticked((s) => flip(s, id))}
      onMore={(id) => setExpanded((s) => flip(s, id))}
      onNote={setNote}
      onConfirm={() => void confirm()} />
  );
}

export function AddressReviewCommentsView({ res, open, unticked, expanded, note, busy, err, onOpen, onCancel, onTick, onMore, onNote, onConfirm }: {
  res: ReviewThreadsWire | 'error' | null; open: boolean; unticked: Set<string>; expanded: Set<string>; note: string; busy: boolean; err: string | null;
  onOpen: () => void; onCancel: () => void; onTick: (id: string) => void; onMore: (id: string) => void; onNote: (v: string) => void; onConfirm: () => void;
}) {
  const b = buttonState(res);
  const threads = res && res !== 'error' ? res.threads : [];
  const ticked = addressPayload(threads, unticked, '').threadIds.length;
  return (
    <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
      <div className="row">
        <button className="btn" onClick={onOpen} disabled={b.disabled || open}>{b.label}</button>
      </div>
      {b.reason && <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>{b.reason}</div>}
      {open && !b.disabled && (
        <div style={{ marginTop: 10 }}>
          <div className="muted" style={{ fontSize: 13 }}>
            Untick any thread you don't want addressed. The planner revises the plan with you, then the team updates this same pull request.
          </div>
          {threads.map((t) => {
            const more = expanded.has(t.id);
            const c = clip(t.body);
            const loc = where(t);
            return (
              <div key={t.id} style={{ marginTop: 10 }}>
                <label className="row" style={{ gap: 8, alignItems: 'baseline' }}>
                  <input type="checkbox" checked={!unticked.has(t.id)} disabled={busy} onChange={() => onTick(t.id)} />
                  <b>{t.author}</b>
                  {loc && <code className="muted">{loc}</code>}
                </label>
                <div style={{ whiteSpace: 'pre-wrap', fontSize: 13, marginTop: 4, marginLeft: 24 }}>{more ? t.body : c.text}</div>
                {c.clipped && (
                  <button className="btn" style={{ marginLeft: 24, marginTop: 4, fontSize: 12 }} onClick={() => onMore(t.id)}>
                    {more ? 'Show less' : 'Show more'}
                  </button>
                )}
              </div>
            );
          })}
          <textarea rows={3} style={{ marginTop: 10 }} disabled={busy} value={note}
            placeholder="Anything to add? (optional)"
            onChange={(e) => onNote(e.target.value)} />
          {err && <div style={{ color: 'var(--bad)', marginTop: 6 }}>{err}</div>}
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn" onClick={onConfirm} disabled={busy || !ticked}>Confirm</button>
            <button className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
