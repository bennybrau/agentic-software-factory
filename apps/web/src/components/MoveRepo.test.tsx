import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Run, RunTask } from '@asf/shared';
import { followRun, type RunDetail } from '../api';
import { MoveRepo, MoveRepoView, RepoLine, canMove, moveProminent, submitMove, type MoveRepoViewProps } from './MoveRepo';

const noop = () => {};
const scm = ['github', 'gitlab'];
const repos = [{ id: 'github:acme/web', path: 'acme/web' }, { id: 'gitlab:acme/api', path: 'acme/api' }];
const run = (over: Partial<Run> = {}) => ({ id: 'run_1', state: 'awaiting_checkpoint', changeRequestNumber: null, repoId: 'github:acme/web',
  team: { reviewTarget: null }, ...over }) as unknown as Run;
const task = (role: string, state: string, seq = 1) => ({ id: `t_${role}_${seq}`, role, state, seq }) as unknown as RunTask;

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

test('a waiting run with no PR can move; a running, finished, PR-open or review run cannot', () => {
  assert.equal(canMove(run()), true);
  assert.equal(canMove(run({ state: 'queued' })), true);
  for (const state of ['running', 'succeeded', 'failed', 'cancelled'] as const) assert.equal(canMove(run({ state })), false, state);
  assert.equal(canMove(run({ changeRequestNumber: 7 })), false);
  assert.equal(canMove(run({ team: { reviewTarget: { url: 'u' } } } as unknown as Partial<Run>)), false);
});

test('the card is prominent only while the (latest) planner is asking', () => {
  assert.equal(moveProminent([task('planner', 'needs_human')]), true);
  assert.equal(moveProminent([task('planner', 'done'), task('implementer', 'needs_human', 2)]), false);
  assert.equal(moveProminent([task('planner', 'needs_human'), task('planner', 'pending', 2)]), false);
});

const page = (r: Run, tasks: RunTask[], open = false) => renderToStaticMarkup(
  <MoveRepo runId="run_1" run={r} tasks={tasks} repos={repos} scm={scm} open={open} onOpen={noop} onClose={noop} onDone={noop} />);

test('hidden when the run can\'t move or (not asking) until opened; a card when the planner asks', () => {
  assert.equal(page(run({ state: 'running' }), [task('planner', 'needs_human')]), '');
  assert.equal(page(run(), [task('planner', 'done')]), '', 'behind the header button until opened');
  assert.match(page(run(), [task('planner', 'done')], true), /aria-label="Move to repository"/);
  const asking = page(run(), [task('planner', 'needs_human')]);
  assert.match(asking, /wrong repository/);
  assert.match(asking, /<button class="btn primary">Move to another repo<\/button>/);
});

const view = (over: Partial<MoveRepoViewProps> = {}) => renderToStaticMarkup(<MoveRepoView prominent={false} open confirming={false} busy={false} err={null}
  repos={repos} scm={scm} currentRepoId="github:acme/web" repoId="" note="" onOpen={noop} onCancel={noop} onRepo={noop} onNote={noop}
  onNext={noop} onBack={noop} onConfirm={noop} {...over} />);

test('the picker leaves out the current repo and a Confirm step names the target', () => {
  const form = view();
  assert.doesNotMatch(form, /<option value="github:acme\/web"/);
  assert.match(form, /<option value="gitlab:acme\/api">acme\/api<\/option>/);
  assert.match(form, /<button class="btn" disabled="">Move…<\/button>/, 'nothing chosen yet');
  const confirm = view({ repoId: 'gitlab:acme/api', confirming: true });
  assert.match(confirm, /Move this run to <span class="mono">acme\/api<\/span>/);
  assert.match(confirm, /<button class="btn primary">Confirm<\/button>/);
});

test('a refusal shows inline', () => {
  assert.match(view({ err: 'run run_1 has a task running, wait for it to finish' }), /color:var\(--bad\)[^>]*>run run_1 has a task running/);
});

test('submitMove posts the repo and the note; a refusal comes back as its reason', async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  global.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
  assert.equal(await submitMove('run_1', 'gitlab:acme/api', '  the API lives there '), null);
  assert.deepEqual(calls, [{ url: '/api/runs/run_1/move', body: { repoId: 'gitlab:acme/api', note: 'the API lives there' } }]);
  global.fetch = (async () => new Response(JSON.stringify({ error: 'move_refused', reason: 'run run_1 already opened change request #4' }), { status: 409 })) as unknown as typeof fetch;
  assert.equal(await submitMove('run_1', 'gitlab:acme/api', ''), 'run run_1 already opened change request #4');
});

// A stand-in EventSource (as subscribe-events.test.ts): the test pushes frames by name.
class FakeEventSource {
  static last: FakeEventSource | null = null;
  onopen: (() => void) | null = null;
  listeners = new Map<string, ((ev: { data: string }) => void)[]>();
  constructor(public url: string) { FakeEventSource.last = this; }
  addEventListener(name: string, fn: (ev: { data: string }) => void) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]); }
  fire(name: string, data: unknown) { for (const fn of this.listeners.get(name) ?? []) fn({ data: JSON.stringify(data) }); }
  close() {}
}

test('live: a pushed run:moved event re-reads the run, the move button goes and the host badge changes, with no reload', async () => {
  (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
  const before = { run: run(), tasks: [task('planner', 'needs_human')] } as unknown as RunDetail;
  const after = { run: run({ state: 'running', repoId: 'gitlab:acme/api' }), tasks: [task('planner', 'pending', 2)] } as unknown as RunDetail;
  global.fetch = (async () => new Response(JSON.stringify(after), { status: 200 })) as unknown as typeof fetch;
  let detail = before;
  const events: string[] = [];
  const render = () => renderToStaticMarkup(<>
    <RepoLine repoId={detail.run.repoId} repos={repos} scm={scm} />
    <MoveRepo runId="run_1" run={detail.run} tasks={detail.tasks} repos={repos} scm={scm} open={false} onOpen={noop} onClose={noop} onDone={noop} />
  </>);
  assert.match(render(), /acme\/web<\/span><span class="pill source">GitHub/);
  assert.match(render(), /Move to another repo/);

  const off = followRun('run_1', (e) => events.push(e.kind), (d) => { detail = d; });
  FakeEventSource.last!.fire('run:event', { runId: 'run_other', seq: 1, kind: 'run:moved', payload: {} });
  FakeEventSource.last!.fire('run:event', { runId: 'run_1', seq: 9, kind: 'run:moved', payload: { from: 'github:acme/web', to: 'gitlab:acme/api' } });
  await new Promise((r) => setTimeout(r, 0));
  off();
  assert.deepEqual(events, ['run:moved'], 'another run\'s event is not this page\'s');
  const html = render();
  assert.match(html, /acme\/api<\/span><span class="pill source">GitLab/);
  assert.doesNotMatch(html, /Move to another repo/);
});
