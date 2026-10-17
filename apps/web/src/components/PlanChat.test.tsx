import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { GateWire, RunMessageWire } from '@asf/shared';
import { PlanChat } from './PlanChat';

const noop = () => {};
const msg = (author: 'agent' | 'human', body: string) =>
  ({ id: `m_${author}`, runId: 'run_1', taskId: 'task_1', role: 'planner', author, kind: author === 'agent' ? 'question' : 'reply', body, by: null, sessionId: null, createdAt: '' } as unknown as RunMessageWire);
const chat = (messages: RunMessageWire[]) => renderToStaticMarkup(
  <QueryClientProvider client={new QueryClient()}>
    <PlanChat runId="run_1" ticketId="adhoc:abc" ticketKey="ADHOC-ABC" gate={null} plannerTask={null} onDone={noop} messages={messages} />
  </QueryClientProvider>);

test('the planner\'s messages render as markdown', () => {
  const html = chat([msg('agent', '**What changes:**\n- a')]);
  assert.match(html, /<strong>What changes:<\/strong>/);
  assert.match(html, /<li>a<\/li>/);
});

test('your own replies show exactly as typed', () => {
  const html = chat([msg('human', 'make it **x**')]);
  assert.match(html, /make it \*\*x\*\*/);
  assert.doesNotMatch(html, /<strong>/);
});

test('raw HTML in a planner message is not output as a tag', () => {
  const html = chat([msg('agent', 'hi <script>alert(1)</script>')]);
  assert.doesNotMatch(html, /<script/);
});

const gate = (artifact: string) => ({ id: 'g_1', runId: 'run_1', gateName: 'after_plan', mode: 'required', state: 'open', afterTask: null, artifact,
  decidedBy: null, note: null, editedArtifact: null, createdAt: '', decidedAt: null }) as GateWire;
const page = (g: GateWire | null, messages: RunMessageWire[] = []) => renderToStaticMarkup(
  <QueryClientProvider client={new QueryClient()}>
    <PlanChat runId="run_1" ticketId="adhoc:abc" ticketKey="ADHOC-ABC" gate={g} plannerTask={null} onDone={noop} messages={messages}
      who="Orchestrator" variant="page" repo="org/web" />
  </QueryClientProvider>);
const splitPlan = '# Plan: Big\n\n```asf-split\n' + JSON.stringify([
  { title: 'API', body: 'Add it.', repo: 'org/api' },
  { title: 'UI', body: 'Show it.', dependsOn: [1] },
]) + '\n```\n';

test('the page variant labels the agent as the Orchestrator', () => {
  const html = page(null, [msg('agent', 'What should change?')]);
  assert.match(html, /Orchestrator asks/);
  assert.doesNotMatch(html, /Planner/);
});

test('a split plan proposes each part, with its repository and order', () => {
  const html = page(gate(splitPlan));
  assert.match(html, /Proposed tasks/);
  assert.match(html, /Queue these 2 tasks/);
  assert.match(html, /org\/api/);
  assert.match(html, /org\/web/);
  assert.match(html, /after #1/);
});

test('a single plan proposes one task', () => {
  const html = page(gate('# Plan: Fix the login page\n\nSmall change.'));
  assert.match(html, /Queue this task/);
  assert.match(html, /Fix the login page/);
});

test('the default card still says Planner', () => {
  const html = chat([msg('agent', 'What should change?')]);
  assert.match(html, /Planner asks/);
  assert.match(html, /Plan it with the planner/);
  assert.doesNotMatch(html, /chat-page/);
});
