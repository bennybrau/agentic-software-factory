import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RunTask } from '@asf/shared';
import { NeedsHumanCard } from './NeedsHumanCard';
import { PlanChat } from './PlanChat';

const wrap = (el: JSX.Element) => renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}>{el}</QueryClientProvider>);
const task = (role: string, reason: string) => ({ id: 'task_1', seq: 0, role, state: 'needs_human', attempt: 1, reason } as unknown as RunTask);
const noop = () => {};

test('planner says not needed: the chat shows the evidence and offers to cancel and remove the ad-hoc task', () => {
  const t = task('planner', 'NOT NEEDED: Already on main in supervisor.ts.');
  const html = wrap(<PlanChat runId="run_1" ticketId="adhoc:abc" ticketKey="ADHOC-ABC" gate={null} plannerTask={t} onDone={noop}
    messages={[{ id: 'm1', runId: 'run_1', taskId: 'task_1', role: 'planner', author: 'agent', kind: 'question', body: 'NOT NEEDED: Already on main in supervisor.ts.', by: null, sessionId: null, createdAt: '', hiveSentAt: null }]} />);
  assert.match(html, /Planner: not needed/);
  assert.match(html, />Already on main in supervisor\.ts\.</, 'the tag is not shown');
  assert.match(html, /Cancel job &amp; remove ADHOC-ABC/);
  assert.match(html, /Cancel job, keep the task/);
  assert.match(html, /Still needed\? Say why/);
  assert.doesNotMatch(html, /Skip planning/);
});

test('a tracker ticket (not ad-hoc) gets a plain Cancel job; the ticket itself is never touched', () => {
  const html = wrap(<NeedsHumanCard runId="run_1" ticketId="owner/repo#7" ticketKey="#7" task={task('implementer', 'NOT NEEDED: fixed in #6')} onDone={noop} />);
  assert.match(html, /The implementer thinks this work isn&#x27;t needed/);
  assert.match(html, />Cancel job</);
  assert.doesNotMatch(html, /remove/);
});

test('an ordinary question shows no cancel offer', () => {
  const html = wrap(<NeedsHumanCard runId="run_1" ticketId="adhoc:abc" ticketKey="ADHOC-ABC" task={task('implementer', 'Python or Node?')} onDone={noop} />);
  assert.match(html, /has a question for you/);
  assert.doesNotMatch(html, /Cancel job/);
});
