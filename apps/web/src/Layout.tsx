import { Outlet } from 'react-router-dom';
import { Sidebar } from './components/Sidebar';
import { NotificationBell } from './components/NotificationBell';
import { StatusChips } from './components/StatusChips';
import { OperatorName } from './components/OperatorName';
import { UpdateBanner } from './components/UpdateBanner';
import { ThemeDecor } from './components/ThemeDecor';
import { useTheme, useThemeLook } from './useTheme';
import { appTitleOf } from './theme-view';
import { useIsPhone } from './useIsPhone';

/**
 * The app chrome: an enterprise-style left sidebar (persistent on desktop, a
 * 72px icon rail on tablet, a docked bottom tab bar on phones) plus the routed
 * view. On phones a top bar carries the app name, the status chips, the name box
 * (no sign-in only) and the notification bell, which otherwise live in the
 * sidebar footer.
 */
export function Layout() {
  useThemeLook(); // the active theme's colours and title, if it has them (M12)
  const { theme } = useTheme();
  const phone = useIsPhone();

  return (
    <div className="shell">
      {phone && (
        <header className="topbar">
          <span className="brand-sm">{appTitleOf(theme)}</span>
          <StatusChips />
          <OperatorName />
          <NotificationBell drop="down" />
        </header>
      )}

      <Sidebar />

      {/* The theme's faint corner pattern, if it has one; sits behind the page. */}
      <ThemeDecor />

      <main className="content"><UpdateBanner /><Outlet /></main>
    </div>
  );
}
