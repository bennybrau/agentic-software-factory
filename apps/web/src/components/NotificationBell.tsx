import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, subscribeEvents } from '../api';
import type { NotificationWire } from '@asf/shared';

/**
 * The web notification sink: a bell with an unread count and a dropdown inbox.
 * It refetches whenever a notification is written (a `notification` frame), on every
 * run event and queue change, and when the stream (re)opens, so a gate opening, a run
 * finishing, a refused start or a failing credential bumps the count without a reload. It opens
 * upward in the sidebar footer and downward (`drop="down"`) in the phone top bar.
 */
export function NotificationBell({ drop = 'up' }: { drop?: 'up' | 'down' }) {
  const navigate = useNavigate();
  const [items, setItems] = useState<NotificationWire[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const load = () => api.notifications().then((d) => { setItems(d.notifications); setUnread(d.unread); }).catch(() => {});
  useEffect(() => { load(); return subscribeEvents(() => load(), () => load(), { onQueue: () => load(), onNotification: () => load() }); }, []);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const openInbox = () => { setOpen((o) => !o); };
  const markAll = async () => { await api.markNotificationsRead(null).catch(() => {}); load(); };
  const clearAll = async () => { await api.clearNotifications().catch(() => {}); load(); };
  const go = async (n: NotificationWire) => {
    await api.markNotificationsRead(n.id).catch(() => {});
    setOpen(false);
    // In-app deep link (/run/<id>). Tolerate legacy '#/run/<id>' rows written before
    // the hash->path migration by stripping the leading '#'; anything else falls back
    // to the run route so an absolute/external URL never client-navigates off-app.
    // A notification with no run (a failing credential) falls back to Settings.
    const fallback = n.runId ? `/run/${n.runId}` : '/settings';
    const raw = n.actions[0]?.url ?? fallback;
    const target = raw.startsWith('#/') ? raw.slice(1)
      : raw.startsWith('/') ? raw
      : fallback;
    navigate(target);
    load();
  };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className="btn ghost" onClick={openInbox} title="Notifications" style={{ padding: '6px 10px' }}>
        <span className="material-symbols-outlined" aria-hidden="true">notifications</span>{unread > 0 && <span style={badge}>{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="card" style={drop === 'down' ? dropdownDown : dropdown}>
          <div className="row between" style={{ padding: '4px 8px', fontWeight: 600 }}>
            <span>Notifications</span>
            <span className="row" style={{ gap: 10, fontWeight: 400 }}>
              {unread > 0 && <a href="#" onClick={(e) => { e.preventDefault(); markAll(); }}>Mark all read</a>}
              {items.length > 0 && <a href="#" onClick={(e) => { e.preventDefault(); clearAll(); }}>Clear all</a>}
            </span>
          </div>
          {items.length === 0 && <div className="muted" style={{ padding: 12 }}>Nothing yet.</div>}
          {items.map((n) => (
            <div key={n.id} className="clickable" onClick={() => go(n)}
                 style={{ padding: '8px 10px', borderTop: '1px solid var(--border,#2a2f3a)', background: n.readAt ? 'transparent' : 'rgba(201,100,66,0.08)' }}>
              <div style={{ fontWeight: n.readAt ? 400 : 600 }}>{n.title}</div>
              {n.body && <div className="muted" style={{ fontSize: 12 }}>{n.body}</div>}
              <div className="muted" style={{ fontSize: 11 }}>{new Date(n.createdAt).toLocaleString()}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const badge = { marginLeft: 4, background: 'var(--bad,#f87171)', color: '#0b1020', borderRadius: 999, padding: '0 6px', fontSize: 11, fontWeight: 700 } as const;
const dropdown = { position: 'absolute', left: 0, bottom: 40, width: 'min(320px, 84vw)', maxHeight: 420, overflow: 'auto', padding: 0, zIndex: 60 } as const;
// In the phone top bar: open below the bell, aligned to its right edge so it stays on screen.
const dropdownDown = { ...dropdown, left: 'auto', right: 0, bottom: 'auto', top: 40 } as const;
