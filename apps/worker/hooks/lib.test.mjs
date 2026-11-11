import { test } from 'node:test';
import assert from 'node:assert/strict';

// The hook helpers are env-driven; set scope before importing.
process.env.ASF_RUN_ID = 'run_1';
process.env.ASF_TASK_ID = 'task_1';
process.env.ASF_ROLE = 'implementer';
process.env.ASF_SCOPE_ROOT = '/work/wt';
const lib = await import('./lib.mjs');

test('writtenPaths pulls paths from write tools only', () => {
  assert.deepEqual(lib.writtenPaths({ tool_name: 'Write', tool_input: { file_path: '/work/wt/a.ts' } }), ['/work/wt/a.ts']);
  assert.deepEqual(lib.writtenPaths({ tool_name: 'MultiEdit', tool_input: { edits: [{ file_path: '/a' }, { file_path: '/b' }] } }), ['/a', '/b']);
  assert.deepEqual(lib.writtenPaths({ tool_name: 'Bash', tool_input: { command: 'ls' } }), []);
});

test('insideScope allows the worktree and rejects outside it', () => {
  assert.equal(lib.insideScope('/work/wt/src/x.ts'), true);
  assert.equal(lib.insideScope('/work/wt'), true);
  assert.equal(lib.insideScope('/work/other/x.ts'), false);
  assert.equal(lib.insideScope('/etc/passwd'), false);
});

test('insideScope also allows the run dir (where role artifacts are written)', async () => {
  // env is captured at import time; set the run dir and re-import a fresh copy.
  process.env.ASF_SCOPE_ROOT = '/work/wt';
  process.env.ASF_RUN_DIR = '/work/runs/run_1';
  const fresh = await import('./lib.mjs?rundir=1');
  assert.equal(fresh.insideScope('/work/runs/run_1/test-report.md'), true, 'artifact in run dir allowed');
  assert.equal(fresh.insideScope('/work/wt/src/x.ts'), true, 'worktree still allowed');
  assert.equal(fresh.insideScope('/work/other/x.ts'), false, 'outside both still blocked');
  assert.equal(fresh.insideScope('/work/runs/run_2/x'), false, 'a different run dir is blocked');
});

test('isBlockedBash refuses push and remote changes', () => {
  assert.match(lib.isBlockedBash({ tool_name: 'Bash', tool_input: { command: 'git push origin HEAD' } }), /push/);
  assert.match(lib.isBlockedBash({ tool_name: 'Bash', tool_input: { command: 'git remote add x y' } }), /remote/);
  assert.equal(lib.isBlockedBash({ tool_name: 'Bash', tool_input: { command: 'git status' } }), null);
});

test('isFactoryRun reflects the env', () => {
  assert.equal(lib.isFactoryRun(), true);
});

/**
 * writeAllowed is the per-role rule the PreToolUse hook enforces: EVERY role may
 * write its artifact under the run dir; only a writing role may touch the
 * worktree. A read-only planner denied all writes could not produce the plan.md
 * its prompt demands and stalled the run asking a human to "re-enable Write".
 */
test('a read-only role may write its artifact in the run dir but not source in the worktree', async () => {
  process.env.ASF_SCOPE_ROOT = '/work/wt';
  process.env.ASF_RUN_DIR = '/work/runs/run_1';
  process.env.ASF_WRITES = '0';
  const ro = await import(`./lib.mjs?ro=${Date.now()}`);
  assert.equal(ro.writeScope('/work/runs/run_1/plan.md'), 'run-dir');
  assert.equal(ro.writeAllowed('/work/runs/run_1/plan.md'), true, 'planner writes plan.md');
  assert.equal(ro.writeAllowed('/work/runs/run_1/review.md'), true, 'reviewer writes review.md');
  assert.equal(ro.writeScope('/work/wt/src/x.ts'), 'worktree');
  assert.equal(ro.writeAllowed('/work/wt/src/x.ts'), false, 'read-only role may not change source');
  assert.equal(ro.writeScope('/etc/passwd'), null);
  assert.equal(ro.writeAllowed('/etc/passwd'), false);
  assert.equal(ro.writeAllowed('/work/runs/run_2/plan.md'), false, 'another run\'s dir is out of scope');
});

test('a writing role may write both the worktree and the run dir, nothing else', async () => {
  process.env.ASF_SCOPE_ROOT = '/work/wt';
  process.env.ASF_RUN_DIR = '/work/runs/run_1';
  process.env.ASF_WRITES = '1';
  const rw = await import(`./lib.mjs?rw=${Date.now()}`);
  assert.equal(rw.writeAllowed('/work/wt/src/x.ts'), true);
  assert.equal(rw.writeAllowed('/work/runs/run_1/test-report.md'), true);
  assert.equal(rw.writeAllowed('/work/other/x.ts'), false);
  assert.equal(rw.writeAllowed('relative/inside.ts'), true, 'relative paths resolve against the worktree');
});

test('the read-only copies of other repositories (<worktreeRoot>/refs/...) are outside every write scope', async () => {
  process.env.ASF_SCOPE_ROOT = '/data/worktrees/runs/run_1';
  process.env.ASF_RUN_DIR = '/data/runs/run_1';
  process.env.ASF_WRITES = '1';
  const rw = await import(`./lib.mjs?refs=${Date.now()}`);
  assert.equal(rw.writeScope('/data/worktrees/refs/run_1/task_1/shared-ui/src/button.ts'), null);
  assert.equal(rw.writeAllowed('/data/worktrees/refs/run_1/task_1/shared-ui/src/button.ts'), false, 'even a writing role may not edit them');
  assert.equal(rw.writeAllowed('../../refs/run_1/task_1/shared-ui/x.ts'), false, 'nor through a relative path');
});

test('describeTool caps a long Bash command at 160 characters', () => {
  const out = lib.describeTool({ tool_name: 'Bash', tool_input: { command: 'echo ' + 'x'.repeat(500) } });
  assert.equal(out.length, 160);
  assert.ok(out.startsWith('Bash: echo x'));
});

test('describeTool never includes an edit body or file content', () => {
  const edit = lib.describeTool({ tool_name: 'Edit', tool_input: { file_path: '/work/wt/a.ts', old_string: 'OLD_BODY', new_string: 'NEW_BODY' } });
  assert.equal(edit, 'Edit: /work/wt/a.ts');
  const write = lib.describeTool({ tool_name: 'Write', tool_input: { file_path: '/work/wt/b.ts', content: 'FILE_CONTENT' } });
  assert.equal(write, 'Write: /work/wt/b.ts');
});

test('describeTool shows the pattern for Grep and Glob', () => {
  assert.equal(lib.describeTool({ tool_name: 'Grep', tool_input: { pattern: 'redactSecrets', path: 'src' } }), 'Grep: redactSecrets in src');
  assert.equal(lib.describeTool({ tool_name: 'Glob', tool_input: { pattern: '**/*.ts' } }), 'Glob: **/*.ts');
  assert.equal(lib.describeTool({ tool_name: 'TodoWrite', tool_input: { todos: [] } }), 'TodoWrite');
});
