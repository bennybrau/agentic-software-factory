import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderPrompt, renderReferenceRepos, loadPriorArtifacts, readArtifact } from './prompt.js';

const ticket = { id: 't1', key: 'ASF-1', title: 'Add a thing', body: 'Do the thing.', url: 'http://x/ASF-1', links: [{ title: 'Figma', url: 'http://f', kind: 'figma' }] };
const base = { ticket, cwd: '/wt', branch: 'agent/ASF-1-abc', artifacts: '/run' };
const priorsFor: Record<string, Record<string, string>> = {
  planner: {},
  implementer: { 'plan.md': 'THE PLAN' },
  tester: { 'plan.md': 'THE PLAN' },
  reviewer: { 'plan.md': 'THE PLAN', 'test-report.md': 'THE REPORT' },
};

test('every role prompt renders with its priors and leaves no {{placeholders}}', async () => {
  for (const role of ['planner', 'implementer', 'tester', 'reviewer']) {
    const p = await renderPrompt(role, 'run_abc', { ...base, prior: priorsFor[role] });
    assert.ok(!p.includes('{{'), `${role} left a placeholder: ${p.match(/\{\{[^}]*\}\}/)?.[0]}`);
    assert.match(p, /ASF-1|APPROVE|test-report|plan/i);
    assert.match(p, /NEEDS_HUMAN:/);
  }
});

test('the tester must call skipped tests unverified, and the reviewer must not approve on them (#40)', async () => {
  const t = await renderPrompt('tester', 'run_x', { ...base, prior: priorsFor.tester });
  assert.match(t, /skipped test did not run/);
  assert.match(t, /`Verified: yes`/);
  assert.match(t, /`Verified: no — <why>`/);
  assert.match(t, /Never report skipped tests as passing/);
  assert.match(t, /TEST_DATABASE_URL/);
  const r = await renderPrompt('reviewer', 'run_x', { ...base, prior: priorsFor.reviewer });
  assert.match(r, /`Verified: no`/);
  assert.match(r, /don't `APPROVE` on the strength of the tests/);
  assert.match(r, /write `ESCALATE`, even if the change looks right to you/);
});

test('roles that run tests are told a scratch test database is already in their environment (#40)', async () => {
  const url = 'postgres://test:pw123@testdb:5432/test';
  const env = { ASF_TEST_DB_ACTIVE: '1', DATABASE_TEST_URL: url, TEST_DATABASE_URL: url };
  for (const role of ['implementer', 'tester', 'reviewer']) {
    const p = await renderPrompt(role, 'run_x', { ...base, prior: priorsFor[role], env });
    assert.match(p, /## TEST DATABASE/, role);
    assert.match(p, /`TEST_DATABASE_URL` and `DATABASE_TEST_URL` are set in your environment/, role);
    assert.match(p, /don't put a different URL on the command line/, role);
    assert.ok(!p.includes(url) && !p.includes('pw123') && !p.includes('testdb:5432'), `${role}: the URL itself is never in the prompt`);
    assert.ok(p.indexOf('## TEST DATABASE') < p.indexOf('Run id: run_x'), 'above the trailer');
  }
  const planner = await renderPrompt('planner', 'run_x', { ...base, prior: {}, env });
  assert.ok(!planner.includes('## TEST DATABASE'), 'the planner runs no tests');
  const one = await renderPrompt('tester', 'run_x', { ...base, prior: priorsFor.tester, env: { ASF_TEST_DB_ACTIVE: '1', DATABASE_TEST_URL: 'x' } });
  assert.match(one, /`DATABASE_TEST_URL` is set in your environment and points at it/);
  // .env.example ships a localhost DATABASE_TEST_URL that every container worker inherits:
  // without the overlay's marker it is only a default, so no claim that a database exists.
  const dflt = { DATABASE_TEST_URL: 'postgres://asf:asf@localhost:5432/asf_test' };
  for (const e of [{}, dflt, { ...dflt, ASF_TEST_DB_ACTIVE: '0' }, { ASF_TEST_DB_ACTIVE: '1', DATABASE_TEST_URL: '  ' }]) {
    const none = await renderPrompt('tester', 'run_x', { ...base, prior: priorsFor.tester, env: e });
    assert.ok(!none.includes('## TEST DATABASE'), 'no variable, no section');
  }
});

test('a genuinely-absent prior artifact renders a placeholder, not a crash', async () => {
  const p = await renderPrompt('reviewer', 'run_x', { ...base, prior: { 'plan.md': 'THE PLAN' } });
  assert.match(p, /\(not available\)/);
  assert.ok(!p.includes('{{'));
});

test('with the planner off (no plan.md) the implementer works from the ticket title and body', async () => {
  const p = await renderPrompt('implementer', 'run_x', { ...base, prior: {} });
  assert.match(p, /No plan for this run, work from the ticket/);
  assert.ok(p.includes('Add a thing') && p.includes('Do the thing.'));
  assert.ok(!p.includes('(not available)'));
});

test('readArtifact falls back to the worktree when the run dir does not have it', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'asf-run-'));
  const worktree = await mkdtemp(join(tmpdir(), 'asf-wt-'));
  await writeFile(join(worktree, 'test-report.md'), 'REPORT IN WORKTREE');
  assert.equal(await readArtifact(runDir, 'test-report.md', worktree), 'REPORT IN WORKTREE');
  // run dir wins when both exist
  await writeFile(join(runDir, 'test-report.md'), 'REPORT IN RUNDIR');
  assert.equal(await readArtifact(runDir, 'test-report.md', worktree), 'REPORT IN RUNDIR');
  // absent everywhere → null
  assert.equal(await readArtifact(runDir, 'missing.md', worktree), null);
  await rm(runDir, { recursive: true, force: true }); await rm(worktree, { recursive: true, force: true });
});

test('a revision note is surfaced prominently in the re-run prompt', async () => {
  const p = await renderPrompt('planner', 'run_rev', { ...base, prior: {}, revision: 'use JavaScript, not Python' });
  assert.match(p, /use JavaScript, not Python/, 'the human revision note must appear in the prompt');
  assert.match(p, /REVISION REQUESTED|revise/i, 'the note should be clearly marked as a revision request');
  assert.ok(!p.includes('{{'), 'no leftover placeholders');
});

test('no revision note renders a clean prompt (no revision banner)', async () => {
  const p = await renderPrompt('planner', 'run_norev', { ...base, prior: {} });
  assert.doesNotMatch(p, /REVISION REQUESTED/, 'no banner when there is no note');
});

test('a cut-short wip note tells the role to continue from HEAD, not restart', async () => {
  const p = await renderPrompt('implementer', 'run_wip', { ...base, prior: {}, wip: 'ran out of turns' });
  assert.match(p, /previous attempt at this role was cut short/i);
  assert.match(p, /ran out of turns/, 'the reason appears in the prompt');
  assert.match(p, /continue from it, do not start over/i);
  assert.ok(!p.includes('{{'), 'no leftover placeholders');
});

test('no wip note renders no continue-from-WIP paragraph', async () => {
  const p = await renderPrompt('implementer', 'run_nowip', { ...base, prior: {} });
  assert.doesNotMatch(p, /cut short/i, 'no WIP paragraph when there is no wip reason');
});

test('a role skill renders a ROLE SKILL section above the trailer; empty renders none', async () => {
  const withSkill = await renderPrompt('planner', 'run_skill', { ...base, prior: {}, skill: 'always cite file:line' });
  assert.match(withSkill, /## ROLE SKILL/, 'the skill section header appears');
  assert.match(withSkill, /always cite file:line/, 'the skill text appears');
  assert.match(withSkill, /unless the ticket or the approved plan/i, 'the skill is subordinate to the ticket/plan');
  // The right-repo / NEEDS_HUMAN trailer must remain LAST, after the skill.
  assert.ok(withSkill.lastIndexOf('NEEDS_HUMAN:') > withSkill.indexOf('## ROLE SKILL'), 'the trailer stays authoritative and last');
  assert.ok(!withSkill.includes('{{'), 'no leftover placeholders');

  const noSkill = await renderPrompt('planner', 'run_noskill', { ...base, prior: {} });
  assert.doesNotMatch(noSkill, /## ROLE SKILL/, 'no section when there is no skill');
  const blankSkill = await renderPrompt('planner', 'run_blankskill', { ...base, prior: {}, skill: '   ' });
  assert.doesNotMatch(blankSkill, /## ROLE SKILL/, 'a whitespace-only skill renders no section');
});

test('third-party skills render after ROLE SKILL with their body and file paths; none renders no section', async () => {
  const skill = {
    id: 'pdf-tools', name: 'pdf-tools', description: 'Work with PDFs', sourceUrl: 'https://github.com/o/r', sourceRef: 'main', commitSha: 'abcdef1',
    files: [{ path: 'SKILL.md', content: '---\nname: pdf-tools\n---\nUse pdftotext first.\n' }, { path: 'forms.md', content: 'x' }],
    enabled: true, roles: ['implementer' as const], addedBy: null, updatedAt: '2026-01-01T00:00:00Z',
  };
  const thirdPartySkills = [{ skill, dir: '/run/skills/pdf-tools', paths: ['/run/skills/pdf-tools/SKILL.md', '/run/skills/pdf-tools/forms.md'] }];
  const p = await renderPrompt('implementer', 'run_tps', { ...base, prior: priorsFor.implementer, skill: 'role guidance', thirdPartySkills });
  assert.match(p, /## THIRD-PARTY SKILLS/);
  assert.ok(p.indexOf('## THIRD-PARTY SKILLS') > p.indexOf('## ROLE SKILL'), 'right after ROLE SKILL');
  assert.match(p, /### pdf-tools\n\nWork with PDFs\n\nUse pdftotext first\./, 'name, description and body, without frontmatter');
  assert.match(p, /- \/run\/skills\/pdf-tools\/forms\.md/, 'its other files are listed by path');
  assert.doesNotMatch(p, /- \/run\/skills\/pdf-tools\/SKILL\.md/, 'SKILL.md itself is inline, not listed');
  assert.match(p, /the ticket and the plan win/);
  assert.ok(p.lastIndexOf('NEEDS_HUMAN:') > p.indexOf('## THIRD-PARTY SKILLS'), 'the trailer stays last');

  for (const none of [undefined, []]) {
    const q = await renderPrompt('implementer', 'run_tps0', { ...base, prior: priorsFor.implementer, thirdPartySkills: none });
    assert.doesNotMatch(q, /THIRD-PARTY SKILLS/);
  }
});

test('loadPriorArtifacts returns only files that exist', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asf-art-'));
  await writeFile(join(dir, 'plan.md'), 'PLAN');
  const got = await loadPriorArtifacts(dir, ['plan.md', 'missing.md']);
  assert.deepEqual(Object.keys(got), ['plan.md']);
  assert.equal(got['plan.md'], 'PLAN');
});

test('an ad-hoc task lists its attachments by path under the ticket body', async () => {
  const withFiles = { ...ticket, attachments: [{ name: 'shot.png', mime: 'image/png', size: 1234 }, { name: 'spec.pdf', mime: 'application/pdf', size: 99 }] };
  const p = await renderPrompt('planner', 'run_adhoc', { ...base, ticket: withFiles, prior: {} });
  assert.match(p, /Do the thing\.\n\nAttached files/);
  assert.ok(p.includes(`- ${join('/run', 'attachments', 'shot.png')} (image/png, 1234 bytes)`));
  assert.ok(p.includes(`- ${join('/run', 'attachments', 'spec.pdf')} (application/pdf, 99 bytes)`));
});

test('a ticket without attachments renders no attachment section', async () => {
  const p = await renderPrompt('planner', 'run_plain', { ...base, prior: {} });
  assert.doesNotMatch(p, /Attached files/);
});

// The rendered section's body is distinctive, so tests match it rather than the header
// (the planner/implementer templates mention the header text in their own guidance).
const TODOS_SECTION = /Here it is right now:/;

test('the Things-to-do section renders items, "none yet", "unavailable", or nothing', async () => {
  const withItems = await renderPrompt('planner', 'run_todos', { ...base, prior: {}, todos: [{ key: 'ADHOC-1', title: 'First thing' }, { key: 'ADHOC-2', title: 'Second thing' }] });
  assert.match(withItems, TODOS_SECTION);
  assert.match(withItems, /- ADHOC-1: First thing/);
  assert.match(withItems, /- ADHOC-2: Second thing/);
  // The right-repo / NEEDS_HUMAN trailer must remain LAST, after the todos section.
  assert.ok(withItems.lastIndexOf('NEEDS_HUMAN:') > withItems.search(TODOS_SECTION), 'the trailer stays last');

  const empty = await renderPrompt('planner', 'run_todos_empty', { ...base, prior: {}, todos: [] });
  assert.match(empty, TODOS_SECTION);
  assert.match(empty, /none yet/);

  const unavailable = await renderPrompt('planner', 'run_todos_na', { ...base, prior: {}, todos: 'unavailable' });
  assert.match(unavailable, TODOS_SECTION);
  assert.match(unavailable, /\(unavailable\)/);

  const none = await renderPrompt('planner', 'run_todos_none', { ...base, prior: {} });
  assert.doesNotMatch(none, TODOS_SECTION, 'undefined todos → no section');
});

test('the planner is told the real implementer budget and how to propose a split the registry can parse', async () => {
  const { parseSplit } = await import('@asf/shared');
  const p = await renderPrompt('planner', 'run_s', { ...base, prior: {}, budget: { implementerTurns: 150, timeoutMinutes: 45 } });
  assert.match(p, /One implementer gets 150 tool calls and 45 minutes/);
  // The example block in the prompt is itself a valid split, so the planner copies a shape the registry accepts.
  const example = parseSplit(p);
  assert.equal(example.kind, 'ok', JSON.stringify(example));
  // No budget passed (an older api): still a concrete number, never a blank.
  const fallback = await renderPrompt('planner', 'run_s', { ...base, prior: {} });
  assert.match(fallback, /One implementer gets \d+ tool calls and \d+ minutes/);
});

test('an implementer re-run for a merge conflict leads with the files and the keep-both-sides rule', async () => {
  const p = await renderPrompt('implementer', 'run_cf', { ...base, prior: priorsFor.implementer, conflict: { base: 'main', files: ['apps/web/package.json', 'src/api.ts'] } });
  assert.ok(p.startsWith('## RESOLVE A MERGE CONFLICT FIRST'), 'the conflict is the task now');
  assert.match(p, /`apps\/web\/package\.json`/);
  assert.match(p, /`src\/api\.ts`/);
  assert.match(p, /Keep both sides' intent/);
  assert.match(p, /git commit --no-edit/);
  assert.match(p, /THE PLAN/, 'the ticket context is still there');
  assert.ok(!p.includes('REVISION REQUESTED'));
  const clean = await renderPrompt('implementer', 'run_cf', { ...base, prior: priorsFor.implementer, conflict: { base: 'main', files: [] } });
  assert.match(clean, /ALREADY RESOLVED/);
  assert.match(clean, /Don't redo the ticket/);
  const none = await renderPrompt('implementer', 'run_cf', { ...base, prior: priorsFor.implementer });
  assert.ok(!/MERGE CONFLICT/.test(none));
});

test('a review-only run renders the reviewer from reviewer-pr.md with the PR filled in', async () => {
  const review = { url: 'https://github.com/acme/web/pull/42', number: 42, headBranch: 'feature/x', baseBranch: 'develop' };
  const p = await renderPrompt('reviewer', 'run_rv', { ...base, prior: {}, review });
  assert.ok(!p.includes('{{'), `left a placeholder: ${p.match(/\{\{[^}]*\}\}/)?.[0]}`);
  assert.match(p, /https:\/\/github\.com\/acme\/web\/pull\/42 \(#42\)/);
  assert.match(p, /git diff origin\/develop\.\.\.HEAD/);
  assert.doesNotMatch(p, /Test report:/, 'not the team reviewer template');
});

// {{repos.connected}}: where an asf-split part may be handed off, for every run (not only chat tasks).
const repo = (id: string, path: string) => ({ id, path, url: `https://x/${path}`, defaultBranch: 'main', cloneUrl: `https://x/${path}.git` });

test('the planner lists every connected repository, with this run\'s own marked', async () => {
  const p = await renderPrompt('planner', 'run_repos', { ...base, prior: {}, repo: repo('2', 'org/api'),
    connectedRepos: [{ id: '1', path: 'org/web', defaultBranch: 'main' }, { id: '2', path: 'org/api' }, { id: '3', path: 'org/infra' }] });
  assert.match(p, /Repositories connected:\n- `org\/web`\n- `org\/api` \(this run\)\n- `org\/infra`\n/);
  assert.doesNotMatch(p, /Only this repository is connected/);
  assert.doesNotMatch(p, /ticket's "Repositories connected" list/);
});

test('with one connected repository the planner is told every part stays here', async () => {
  const p = await renderPrompt('planner', 'run_one', { ...base, prior: {}, repo: repo('1', 'org/web'), connectedRepos: [{ id: '1', path: 'org/web' }] });
  assert.match(p, /Repositories connected:\nOnly this repository is connected \(`org\/web`\), so every part stays here/);
  assert.doesNotMatch(p, /\(this run\)/);
});

test('an older api with no connectedRepos renders a fallback, never a blank list', async () => {
  const p = await renderPrompt('planner', 'run_old', { ...base, prior: {}, repo: repo('1', 'org/web') });
  assert.match(p, /Repositories connected:\nThe factory could not list the connected repositories/);
  assert.ok(!p.includes('{{'));
});

test('an older chat task\'s body has its appended repository list stripped, so it shows once', async () => {
  const chatTicket = { ...ticket, id: 'adhoc:0123456789abcdef', body: 'Fix the login.\n\nRepositories connected:\n- org/stale-one' };
  const p = await renderPrompt('planner', 'run_chat', { ...base, ticket: chatTicket, prior: {}, repo: repo('1', 'org/web'),
    connectedRepos: [{ id: '1', path: 'org/web' }, { id: '2', path: 'org/api' }] });
  assert.doesNotMatch(p, /org\/stale-one/);
  assert.equal(p.split('Repositories connected:').length - 1, 1, 'one list, from the run context');
  assert.match(p, /Fix the login\.\n/);
  // A tracker ticket that happens to contain the phrase keeps its body untouched.
  const jira = { ...ticket, body: 'Notes.\n\nRepositories connected:\n- written by a person' };
  const q = await renderPrompt('planner', 'run_jira', { ...base, ticket: jira, prior: {} });
  assert.match(q, /written by a person/);
});

// {{repos.reference}}: read-only copies of the other repositories the ticket names.
const REF = { path: 'acme/platform/web/shared-ui', dir: '/wt/refs/run_r/task_t/shared-ui', branch: 'main', sha: 'abc1234def5678', reason: 'The ticket description mentions shared-ui.' };

test('{{repos.reference}} with no copies renders nothing, and leaves no stray blank paragraph', async () => {
  assert.equal(renderReferenceRepos(undefined, 'planner'), '');
  assert.equal(renderReferenceRepos([], 'implementer'), '');
  for (const role of ['planner', 'implementer', 'reviewer']) {
    const p = await renderPrompt(role, 'run_noref', { ...base, prior: priorsFor[role], referenceRepos: [] });
    assert.doesNotMatch(p, /checked out read-only/, role);
    assert.doesNotMatch(p, /\n\n\n/, `${role}: no empty paragraph where the section would be`);
  }
});

test('the planner is told where the read-only copies are, and that their work goes in a split part', async () => {
  const p = await renderPrompt('planner', 'run_ref', { ...base, prior: {}, referenceRepos: [REF] });
  assert.match(p, /Repositories connected:\n[^\n]+\n\nOther repositories this ticket names are checked out read-only/);
  assert.match(p, /never edit them\. Changes there are discarded\. Work that belongs in one of them goes in a split part with `"repo"` set\.\n- `acme\/platform\/web\/shared-ui` at \/wt\/refs\/run_r\/task_t\/shared-ui \(main @ abc1234\): The ticket description mentions shared-ui\./);
});

test('the implementer is told those repositories are another part\'s job; the reviewer to check usage against them', async () => {
  const i = await renderPrompt('implementer', 'run_ref', { ...base, prior: priorsFor.implementer, referenceRepos: [REF] });
  assert.match(i, /checked out read-only/);
  assert.match(i, /another part's job/);
  assert.doesNotMatch(i, /split part/);
  assert.ok(i.indexOf('checked out read-only') > i.indexOf('THE PLAN'), 'after the plan');
  const r = await renderPrompt('reviewer', 'run_ref', { ...base, prior: priorsFor.reviewer, referenceRepos: [REF] });
  assert.match(r, /check the names, types and calls against what is really there/);
  assert.match(r, /\(main @ abc1234\)/);
  // The tester's template doesn't include the section.
  const t = await renderPrompt('tester', 'run_ref', { ...base, prior: priorsFor.tester, referenceRepos: [REF] });
  assert.doesNotMatch(t, /checked out read-only/);
});

test('the planner is told to split library work first and to wait for a pinned version to be published', async () => {
  const p = await renderPrompt('planner', 'run_lib', { ...base, prior: {} });
  assert.match(p, /Work across repositories: a library and the code that uses it/);
  assert.match(p, /Library part first/);
  assert.match(p, /check that version is published/);
  assert.match(p, /`dependsOn` the library part/);
  assert.ok(!p.includes('{{'), 'no unrendered template variables');
  // Only the planner splits: the implementer is not given split guidance.
  const impl = await renderPrompt('implementer', 'run_lib', { ...base, prior: priorsFor.implementer });
  assert.ok(!impl.includes('Library part first'));
});

test('the Hive brief renders a TEAM MEMORY section above ROLE SKILL for the planner, implementer and reviewer', async () => {
  const hiveBrief = 'Facts:\n- Only the registry talks to Postgres (repo, decision) [hive:eeeeeeee]';
  for (const role of ['planner', 'implementer', 'reviewer']) {
    const p = await renderPrompt(role, 'run_hive', { ...base, prior: priorsFor[role], skill: 'role guidance', hiveBrief });
    assert.match(p, /## TEAM MEMORY \(Hive\)/, `${role} gets the section`);
    assert.ok(p.includes('[hive:eeeeeeee]'), `${role} gets the brief text`);
    assert.ok(p.indexOf('## TEAM MEMORY (Hive)') < p.indexOf('## ROLE SKILL'), 'the brief sits above the role skill');
  }
  const p = await renderPrompt('tester', 'run_hive', { ...base, prior: priorsFor.tester, hiveBrief });
  assert.doesNotMatch(p, /TEAM MEMORY|hive:eeeeeeee/, 'the tester gets nothing');
});

test('the planner is told to end the plan with a Team memory section; the implementer is not', async () => {
  const hiveBrief = 'Facts:\n- Only the registry talks to Postgres (repo, decision) [hive:eeeeeeee]';
  const planner = await renderPrompt('planner', 'run_hive', { ...base, prior: {}, hiveBrief });
  assert.match(planner, /already settled\. Follow them\./);
  assert.match(planner, /End plan\.md with a `## Team memory` section, just before the `Change-Type:` line/);
  assert.ok(planner.includes("`- [hive:<id8>] <the fact in a few words>: applied`, `: overridden: <why>`, or `: doesn't apply here`"));
  assert.ok(planner.includes('`Nothing remembered applies to this ticket.`'));
  const impl = await renderPrompt('implementer', 'run_hive', { ...base, prior: priorsFor.implementer, hiveBrief });
  assert.ok(impl.includes('These are decisions and gotchas the team has already settled. Follow them. When the ticket contradicts one, say so instead of silently picking. Cite `[hive:<id>]` for any you rely on.\n\nFacts:'));
  assert.doesNotMatch(impl, /## Team memory/);
});

test('the reviewer is told a change contradicting team memory is a finding, unless the plan overrode it', async () => {
  const hiveBrief = 'Facts:\n- Only the registry talks to Postgres (repo, decision) [hive:eeeeeeee]';
  const p = await renderPrompt('reviewer', 'run_hive', { ...base, prior: priorsFor.reviewer, hiveBrief });
  assert.match(p, /A change that contradicts one is a finding: cite its `\[hive:<id>\]`/);
  assert.match(p, /plan's `## Team memory` section overrode that fact with a reason/);
  assert.doesNotMatch(p, /Follow them\./);
});

test('without a Hive brief the prompt is byte-identical', async () => {
  for (const role of ['planner', 'implementer', 'tester', 'reviewer']) {
    const without = await renderPrompt(role, 'run_hive0', { ...base, prior: priorsFor[role], skill: 'g' });
    assert.equal(await renderPrompt(role, 'run_hive0', { ...base, prior: priorsFor[role], skill: 'g', hiveBrief: undefined }), without);
    assert.equal(await renderPrompt(role, 'run_hive0', { ...base, prior: priorsFor[role], skill: 'g', hiveBrief: '' }), without);
  }
});
