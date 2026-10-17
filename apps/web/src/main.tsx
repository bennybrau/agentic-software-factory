import React from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import './styles.css';
import { Layout } from './Layout';
import { Backlog } from './views/Backlog';
import { Dispatch } from './views/Dispatch';
import { Chat, ChatRun } from './views/Chat';
import { Recurring } from './views/Recurring';
import { Runs } from './views/Runs';
import { RunView } from './views/RunView';
import { Settings } from './views/Settings';
import { Setup } from './views/Setup';
import { api } from './api';
import { setupFlags } from './setup-flags';

const queryClient = new QueryClient();

/**
 * The index route (#83): send a not-yet-configured factory to the first-run
 * checklist, but only until every required item is ✓ — or until the operator
 * dismisses it. Once dismissed we never gate again, so returning operators land
 * straight on the chat (which shows a "Setup isn't finished" notice until it is).
 */
function Home() {
  const dismissed = setupFlags.isDismissed();
  // Skip the status fetch entirely once dismissed (enabled:false), but keep the
  // hook call unconditional so hook order is stable.
  const { data, isLoading } = useQuery({ queryKey: ['setup-status'], queryFn: api.setupStatus, staleTime: 30_000, enabled: !dismissed });
  if (dismissed) return <Chat />;
  if (isLoading || !data) return <div className="content"><p className="muted">Loading…</p></div>;
  return data.complete ? <Chat /> : <Navigate to="/setup" replace />;
}

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { index: true, element: <Home /> },
      { path: 'setup', element: <Setup /> },
      { path: 'backlog', element: <Backlog /> },
      { path: 'new', element: <Navigate to="/" replace /> }, // the chat is the landing page now
      { path: 'recurring', element: <Recurring /> },
      { path: 'dispatch/*', element: <Dispatch /> }, // splat: ticket ids carry '/' (github owner/repo#n)
      { path: 'runs', element: <Runs /> },
      { path: 'run/:runId', element: <RunView /> },
      { path: 'chat/:runId', element: <ChatRun /> },
      { path: 'settings', element: <Settings /> },
      // The old per-area pages now live as questions on /settings; keep bookmarks working.
      { path: 'providers', element: <Navigate to="/settings#tickets" replace /> },
      { path: 'pipeline', element: <Navigate to="/settings#approvals" replace /> },
      { path: 'admin', element: <Navigate to="/settings" replace /> },
      { path: 'workers', element: <Navigate to="/" replace /> }, // worker status is a sidebar chip now
      { path: '*', element: <Chat /> }, // unknown path -> the chat, the landing page
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
