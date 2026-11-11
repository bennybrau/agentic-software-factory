import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RunEvent } from '@asf/shared';
import { ACTIVITY_MAX_LINES, buildLines, kindOf, mergeEvents, reportsActivity } from './activity';

const WT = '/data/worktrees/runs/run_1';
const ev = (seq: number, kind: string, payload: Record<string, unknown>, at = `2026-01-01T00:00:${String(seq).padStart(2, '0')}.000Z`): RunEvent =>
  ({ id: seq, runId: 'run_1', taskId: 'task_1', seq, kind, source: 'agent', payload, at });
const running = { running: true, worktree: WT, runId: 'run_1' };
const finished = { ...running, running: false };

test('a post closes the oldest open pre of the same tool (FIFO), with its duration', () => {
  const lines = buildLines([
    ev(1, 'tool:pre', { tool: 'Read', summary: `Read: ${WT}/a.ts` }),
    ev(2, 'tool:pre', { tool: 'Read', summary: `Read: ${WT}/b.ts` }),
    ev(3, 'tool:pre', { tool: 'Bash', summary: 'Bash: ls' }),
    ev(5, 'tool:post', { tool: 'Read', summary: `Read: ${WT}/a.ts`, ok: true }),
  ], running);
  assert.deepEqual(lines.map((l) => [l.seq, l.target, l.state, l.ms]), [
    [1, 'a.ts', 'ok', 4000],
    [2, 'b.ts', 'running', null],
    [3, 'ls', 'running', null],
  ]);
});

test('events out of seq order are sorted before pairing', () => {
  const lines = buildLines([
    ev(2, 'tool:post', { tool: 'Edit', summary: 'Edit: x', ok: false }),
    ev(1, 'tool:pre', { tool: 'Edit', summary: 'Edit: x' }),
  ], running);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].seq, 1);
  assert.equal(lines[0].state, 'failed');
});

test('keeps only the last 500 lines', () => {
  const evs = Array.from({ length: ACTIVITY_MAX_LINES + 20 }, (_, i) => ev(i + 1, 'tool:post', { tool: 'Bash', summary: `Bash: n${i + 1}`, ok: true }));
  const lines = buildLines(evs, finished);
  assert.equal(lines.length, 500);
  assert.equal(lines[0].seq, 21);
  assert.equal(lines.at(-1)!.seq, 520);
});

test('a reconnect merge de-duplicates by seq', () => {
  const page = [ev(1, 'tool:pre', { tool: 'Bash', summary: 'Bash: ls' }), ev(2, 'tool:post', { tool: 'Bash', summary: 'Bash: ls', ok: true })];
  const after = [ev(2, 'tool:post', { tool: 'Bash', summary: 'Bash: ls', ok: true }), ev(3, 'tool:pre', { tool: 'Grep', summary: 'Grep: foo' })];
  const merged = mergeEvents(page, after);
  assert.deepEqual(merged.map((e) => e.seq), [1, 2, 3]);
  assert.equal(buildLines(merged, running).length, 2);
});

test('an open pre on a finished task is unfinished', () => {
  const lines = buildLines([ev(1, 'tool:pre', { tool: 'Bash', summary: 'Bash: sleep 999' })], finished);
  assert.equal(lines[0].state, 'unfinished');
});

test('a post with no pre (Codex/OpenCode) is a complete line with no duration', () => {
  const lines = buildLines([ev(4, 'tool:post', { tool: 'command_execution', summary: `cat ${WT}/README.md`, ok: true })], running);
  assert.deepEqual(lines.map((l) => [l.kind, l.target, l.state, l.ms]), [['command', 'cat README.md', 'ok', null]]);
});

test('tool:denied is its own denied line', () => {
  const lines = buildLines([ev(1, 'tool:denied', { tool: 'file_change', summary: 'src/x.ts', reason: 'declined' })], running);
  assert.deepEqual(lines.map((l) => [l.kind, l.state]), [['edit', 'denied']]);
});

test('without a worktree, a /…/runs/<runId>/ prefix is stripped', () => {
  const [l] = buildLines([ev(1, 'tool:post', { tool: 'Read', summary: 'Read: /data/worktrees/runs/run_1/src/a.ts', ok: true })], { ...running, worktree: null });
  assert.equal(l.target, 'src/a.ts');
});

test('the bare worktree root reads as "." and a summary-less event falls back to the tool', () => {
  const lines = buildLines([
    ev(1, 'tool:post', { tool: 'Glob', summary: `Glob: *.ts in ${WT}`, ok: true }),
    ev(2, 'tool:post', { tool: 'WebFetch', ok: true }),
  ], running);
  assert.deepEqual(lines.map((l) => l.target), ['*.ts in .', 'WebFetch']);
});

test('kind mapping is case-insensitive', () => {
  assert.equal(kindOf('Read'), 'read');
  assert.equal(kindOf('NotebookRead'), 'read');
  assert.equal(kindOf('read'), 'read');
  for (const t of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'file_change', 'edit']) assert.equal(kindOf(t), 'edit', t);
  for (const t of ['Grep', 'Glob', 'grep']) assert.equal(kindOf(t), 'search', t);
  for (const t of ['Bash', 'command_execution', 'bash']) assert.equal(kindOf(t), 'command', t);
  assert.equal(kindOf('WebFetch'), 'other');
});

test('only copilot reports no activity', () => {
  assert.equal(reportsActivity('copilot'), false);
  for (const r of ['claude-code', 'codex', 'opencode', null]) assert.equal(reportsActivity(r), true);
});
