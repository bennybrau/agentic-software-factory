import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, chmod, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClaimResponse, RunContext, Run, Repo } from '@asf/shared';
import { STANDARD_TEAM, DEFAULT_GATES } from '@asf/shared';

const exec = promisify(execFile);

// runSegment with RunContext.referenceRepos: the copies are made before the agent starts,
// named in its prompt, readable via --add-dir, and removed however the step ends.
let dir: string;
let libOrigin: string;
let segment: typeof import('./segment.js');
let apiMod: typeof import('./api.js');
let cfg: typeof import('./config.js');

type Ev = { kind: string; payload: Record<string, unknown> };
let events: Ev[] = [];
const realApi = {} as Record<string, unknown>;
const PATCHED = ['event', 'saveArtifact', 'listArtifacts', 'listArtifactVersions', 'listMessages', 'listAdhoc', 'cancelRequested', 'appendMessage', 'createAdhoc', 'attachment'] as const;

/** A fake claude that records its argv, lists the reference dir it was given, then succeeds or fails. */
async function fakeClaude(isError: boolean): Promise<string> {
  const bin = join(dir, `claude-${Math.random().toString(36).slice(2)}`);
  const envelope = JSON.stringify({ type: 'result', subtype: isError ? 'error_during_execution' : 'success', is_error: isError, result: isError ? 'boom' : 'ok', num_turns: 1, total_cost_usd: 0 });
  await writeFile(bin, `#!/bin/sh
if [ "$1" = "--version" ]; then echo "9.9.9 (Claude Code)"; exit 0; fi
printf '%s\\n' "$@" > "${dir}/argv.txt"
ls "$ASF_REFS_DIR/shared-ui" > "${dir}/seen.txt" 2>&1
cat <<'EOF'
${envelope}
EOF
`);
  await chmod(bin, 0o755);
  return bin;
}

const run = (): Run => ({
  id: 'run_segrefs0001', ticketId: 't1', ticketKey: 'ASF-9', ticketProvider: 'mock', state: 'running',
  teamName: 'standard', team: STANDARD_TEAM, gates: DEFAULT_GATES, repoId: null, worktreePath: null, branchName: null,
  changeRequestUrl: null, changeRequestNumber: null, changeRequestState: null, deliveryOutcome: null, costUsd: 0, maxCostUsd: 15, reviewIterations: 0, dispatchedBy: 'test', reason: null,
  createdAt: new Date().toISOString(), startedAt: null, lastEventAt: null, cancelRequestedAt: null, finishedAt: null,
});
const claim = (taskId: string): ClaimResponse & object => ({
  run: run(), team: STANDARD_TEAM,
  task: { id: taskId, runId: 'run_segrefs0001', role: 'reviewer', seq: 3, state: 'running', attempt: 1, inputRef: null, outputRef: null,
    workerId: 'w', runtime: 'claude-code', model: null, effort: null, costUsd: 0, gateChecked: false, startedAt: null, finishedAt: null,
    reason: null, queuedBy: 'plan', queuedReason: null },
}) as unknown as ClaimResponse & object;
const lib = (): Repo => ({ id: 'lib', path: 'acme/platform/web/shared-ui', url: 'file://lib', defaultBranch: 'main', cloneUrl: libOrigin });
const ctx = (): RunContext => ({
  runId: 'run_segrefs0001', ticket: { id: 't1', key: 'ASF-9', title: 'T', body: 'Uses shared-ui.', url: 'u', links: [] },
  repo: null, cloneCredential: null, auth: { providerKind: 'anthropic', mode: 'api-key', credential: 'sk-test' }, auths: {}, roleSkills: {}, thirdPartySkills: [],
  referenceRepos: [{ repo: lib(), cloneCredential: { url: libOrigin }, reason: 'The ticket description mentions shared-ui.' }],
}) as unknown as RunContext;
const exists = (p: string) => stat(p).then(() => true, () => false);

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'asf-segrefs-'));
  process.env.RUN_DATA_ROOT = join(dir, 'runs');
  process.env.WORKTREE_ROOT = join(dir, 'wt');
  cfg = await import('./config.js');
  apiMod = await import('./api.js');
  segment = await import('./segment.js');
  for (const k of PATCHED) realApi[k] = (apiMod.api as Record<string, unknown>)[k];
  libOrigin = join(dir, 'lib-origin');
  await exec('git', ['init', '-b', 'main', libOrigin]);
  await writeFile(join(libOrigin, 'button.ts'), 'export function Button() {}\n');
  await exec('git', ['add', '-A'], { cwd: libOrigin });
  await exec('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init'], { cwd: libOrigin });
});
after(async () => {
  for (const k of PATCHED) (apiMod.api as Record<string, unknown>)[k] = realApi[k];
  await rm(dir, { recursive: true, force: true });
});
beforeEach(() => {
  events = [];
  const a = apiMod.api as Record<string, unknown>;
  a.event = async (_runId: string, kind: string, payload: Record<string, unknown>) => { events.push({ kind, payload }); };
  a.saveArtifact = async () => {};
  a.listArtifacts = async () => ({});
  a.listArtifactVersions = async () => [];
  a.listMessages = async () => [];
  a.listAdhoc = async () => [];
  a.cancelRequested = async () => false;
  a.appendMessage = async () => {};
  a.createAdhoc = async () => null;
  a.attachment = async () => Buffer.from('');
});

for (const isError of [false, true]) {
  test(`the agent reads the copy, the prompt names it, and it is removed after a ${isError ? 'failed' : 'finished'} step`, async () => {
    (cfg.config as { claudeBin: string }).claudeBin = await fakeClaude(isError);
    const taskId = isError ? 'task_refs_fail' : 'task_refs_ok';
    const res = await segment.runSegment(claim(taskId), ctx(), () => {});
    assert.equal(res.outcome, isError ? 'failed' : 'done');
    const refsDir = join(dir, 'wt', 'refs', 'run_segrefs0001', taskId);
    assert.match(await readFile(join(dir, 'seen.txt'), 'utf8'), /button\.ts/, 'the agent could list the copy while it ran');
    assert.match(await readFile(join(dir, 'argv.txt'), 'utf8'), new RegExp(`--add-dir\n${refsDir}\n`));
    const prompt = await readFile(join(dir, 'runs', 'run_segrefs0001', 'reviewer.prompt.md'), 'utf8');
    assert.match(prompt, new RegExp(`- \`acme/platform/web/shared-ui\` at ${join(refsDir, 'shared-ui')} \\(main @ [0-9a-f]{7}\\): The ticket description mentions shared-ui\\.`));
    assert.ok(events.findIndex((e) => e.kind === 'refs:ready') < events.findIndex((e) => e.kind === 'segment:started'), 'ready before the agent starts');
    assert.equal(await exists(refsDir), false, 'removed when the step ended');
  });
}

test('the copies are removed when the step throws', async () => {
  (cfg.config as { claudeBin: string }).claudeBin = await fakeClaude(false);
  // The reviewer's previous-review lookup throwing synchronously makes the step itself throw.
  (apiMod.api as Record<string, unknown>).listArtifactVersions = () => { throw new Error('boom'); };
  const c = claim('task_refs_throw');
  await assert.rejects(segment.runSegment(c, ctx(), () => {}), /boom/);
  assert.equal(await exists(join(dir, 'wt', 'refs', 'run_segrefs0001', 'task_refs_throw')), false);
});
