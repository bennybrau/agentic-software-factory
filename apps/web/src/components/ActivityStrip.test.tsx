import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RunEvent, RunTask } from '@asf/shared';
import { ActivityStrip } from './ActivityStrip';

const WT = '/data/worktrees/runs/run_1';
const task = (state: string, runtime = 'claude-code') => ({ id: 'task_1', seq: 0, role: 'implementer', state, runtime } as unknown as RunTask);
const ev = (seq: number, kind: string, payload: Record<string, unknown>): RunEvent =>
  ({ id: seq, runId: 'run_1', taskId: 'task_1', seq, kind, source: 'agent', payload, at: `2026-01-01T00:00:0${seq}.000Z` });

test('a running task shows a line per tool call, with marks for failed and in-progress calls', () => {
  const html = renderToStaticMarkup(<ActivityStrip runId="run_1" task={task('running')} worktree={WT} connectEpoch={0}
    initialEvents={[ev(1, 'tool:pre', { tool: 'Read', summary: `Read: ${WT}/src/a.ts` }), ev(2, 'tool:post', { tool: 'Read', summary: `Read: ${WT}/src/a.ts`, ok: true })]}
    sseEvents={[ev(3, 'tool:pre', { tool: 'Bash', summary: 'Bash: pnpm test' }), ev(4, 'tool:post', { tool: 'Edit', summary: 'Edit: x.ts', ok: false })]} />);
  assert.match(html, />src\/a\.ts</);
  assert.match(html, />1000ms<|>1\.0s</);
  assert.match(html, />pnpm test<.*>…</);
  assert.match(html, /✕ failed/);
  assert.doesNotMatch(html, /does not report activity/);
});

test('a finished task with no tool events shows the note', () => {
  const html = renderToStaticMarkup(<ActivityStrip runId="run_1" task={task('done')} worktree={WT} connectEpoch={0} initialEvents={[]} sseEvents={[]} />);
  assert.match(html, /This runtime does not report activity\./);
});

test('a copilot task shows the note even while running', () => {
  const html = renderToStaticMarkup(<ActivityStrip runId="run_1" task={task('running', 'copilot')} worktree={WT} connectEpoch={0} sseEvents={[]} />);
  assert.match(html, /This runtime does not report activity\./);
});

test('denied calls and an open pre on a finished task get their own marks', () => {
  const html = renderToStaticMarkup(<ActivityStrip runId="run_1" task={task('done')} worktree={WT} connectEpoch={0}
    initialEvents={[ev(1, 'tool:denied', { tool: 'file_change', summary: 'src/x.ts', reason: 'declined' }), ev(2, 'tool:pre', { tool: 'Bash', summary: 'Bash: sleep 999' })]}
    sseEvents={[]} />);
  assert.match(html, /⊘ denied/);
  assert.match(html, /did not finish/);
});
