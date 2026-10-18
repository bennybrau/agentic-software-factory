import { NavLink } from 'react-router-dom';
import { NotificationBell } from './NotificationBell';
import { StatusChips } from './StatusChips';
import { useMe } from '../useMe';
import { useTheme } from '../useTheme';
import { useIsPhone } from '../useIsPhone';
import { appTitleOf } from '../theme-view';
import { PAGE } from '../words';

/** One source of truth for the primary nav: route, label, short tab-bar label, and Material Symbols icon. */
export const LINKS = [
  { to: '/', label: 'New chat', short: 'Chat', icon: 'chat', end: true },
  { to: '/backlog', label: PAGE.todo, short: 'Planned', icon: 'checklist' },
  { to: '/recurring', label: 'Recurring tasks', short: 'Recurring', icon: 'event_repeat' },
  { to: '/runs', label: PAGE.activity, short: 'Activity', icon: 'dashboard' },
  { to: '/settings', label: 'Settings', short: 'Settings', icon: 'settings' },
];

/**
 * The primary navigation. Persistent left sidebar on desktop (icon + label), a
 * 72px icon rail on tablet (label via title tooltip), and a docked bottom tab
 * bar on phones (icon over short label). The worker/spend chips, identity chip
 * and notification bell live in the footer; on phones the footer is hidden and
 * the chips and bell move to the top bar (see Layout). Routes/labels/icons come
 * from LINKS so there is one place to edit.
 */
export function Sidebar() {
  const me = useMe();
  const { theme } = useTheme();
  const phone = useIsPhone();
  return (
    <aside className="sidebar">
      <div className="brand"><span>{appTitleOf(theme)}</span></div>
      <nav className="nav" aria-label="Primary">
        {LINKS.map((l) => (
          <NavLink
            key={l.to}
            to={l.to}
            end={l.end}
            title={l.label}
            className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
          >
            <span className="material-symbols-outlined" aria-hidden="true">{l.icon}</span>
            <span className="nav-label">{l.label}</span>
            <span className="nav-short">{l.short}</span>
          </NavLink>
        ))}
      </nav>
      {!phone && (
        <div className="sidebar-foot">
          <StatusChips />
          <NotificationBell />
          {me.verified && (
            <span className="muted" title={`verified via ${me.mode}`}>
              {me.user} ✓
            </span>
          )}
        </div>
      )}
    </aside>
  );
}
