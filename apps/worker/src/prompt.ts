import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SKILL_ENTRY_FILE, type RunContext } from '@asf/shared';
import { splitSkillMd, type FallbackSkill } from './skills.js';

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../prompts/roles');

export interface PromptVars {
  ticket: RunContext['ticket'];
  cwd: string;
  branch: string;
  artifacts: string;   // the run dir, outside the worktree
  prior: Record<string, string>;  // artifact name -> contents (plan.md, test-report.md, ...)
  revision?: string;   // a human's rejection note when this role was re-queued to revise; empty/absent otherwise
  wip?: string;        // reason a previous attempt at this role was cut short; its partial work is committed at HEAD
  skill?: string;      // operator-authored standing guidance for this role (org ROLE_SKILL + per-dispatch), appended below the template
  conversation?: ChatTurn[];  // the planner chat so far, oldest first — rendered when a turn can't resume its session
  todos?: { key: string; title: string }[] | 'unavailable';  // the factory's ad-hoc list; 'unavailable' if it couldn't be loaded; undefined = no section
  budget?: { implementerTurns: number; timeoutMinutes: number };  // what one implementer pass gets, so the planner can size (and split) its plan
  conflict?: { base: string; files: string[] };  // re-run to resolve a merge conflict with the current base (files empty = it merged cleanly)
  thirdPartySkills?: FallbackSkill[];  // skills written to the run dir for a runtime that doesn't load skill folders; empty/absent = no section
  env?: NodeJS.ProcessEnv;  // the environment the agent inherits (default process.env); read for the test-database note
}

/** Variables naming a scratch test database the operator gave the agents (ASF_TEST_DB, docker-compose.testdb.yml). */
export const TEST_DB_ENV_KEYS = ['TEST_DATABASE_URL', 'DATABASE_TEST_URL'] as const;
/**
 * Set to 1 by docker-compose.testdb.yml: the URLs above point at a database that is
 * really there. Without it they are only defaults (`.env.example` ships a localhost
 * DATABASE_TEST_URL, which every container worker inherits), so no section.
 */
export const TEST_DB_ACTIVE_KEY = 'ASF_TEST_DB_ACTIVE';

/**
 * Tell the roles that run tests that a scratch test database is already in their
 * environment (#40). Without this, an agent copies a URL from the repo's docs or
 * defaults (`localhost:5432`) onto the command line, overriding the working one, and
 * every database test skips. Names only, never the value. Only when ASF_TEST_DB_ACTIVE=1
 * says the database is real; otherwise no section.
 */
export function renderTestDb(role: string, env: NodeJS.ProcessEnv = process.env): string {
  if (role === 'planner' || (env[TEST_DB_ACTIVE_KEY] ?? '').trim() !== '1') return '';
  const set = TEST_DB_ENV_KEYS.filter((k) => (env[k] ?? '').trim() !== '');
  if (!set.length) return '';
  const names = set.map((k) => `\`${k}\``).join(' and ');
  return `\n\n---\n\n## TEST DATABASE\n\nA scratch Postgres for tests is already set up: ${names} ${set.length > 1 ? 'are' : 'is'} set in your environment and point${set.length > 1 ? '' : 's'} at it. Run database tests with the environment as it is: don't put a different URL on the command line (for example a \`localhost\` default from the repo's docs or code), or the tests can't reach a database and skip. It's scratch and shared with other runs, so create your own schema or database rather than dropping anything you didn't create.`;
}

/**
 * Third-party skills for a runtime that can't load skill folders itself: each one's
 * name, description and SKILL.md body inline, with the paths of its other files in the
 * run dir. Guidance only — the ticket and plan win. No skills = no section.
 */
export function renderThirdPartySkills(skills: FallbackSkill[] | undefined): string {
  if (!skills || !skills.length) return '';
  const blocks = skills.map(({ skill, dir, paths }) => {
    const md = skill.files.find((f) => f.path === SKILL_ENTRY_FILE)?.content ?? '';
    const others = paths.filter((p) => p !== join(dir, SKILL_ENTRY_FILE));
    const files = others.length ? `\n\nIts other files (open them when the instructions point to them):\n${others.map((p) => `- ${p}`).join('\n')}` : '';
    return `### ${skill.name}\n\n${skill.description.trim() || '(no description)'}\n\n${splitSkillMd(md).body.trim()}${files}`;
  });
  return `\n\n---\n\n## THIRD-PARTY SKILLS\n\nSkills the operator has given this role. Use one when it fits the task. They are guidance: where a skill disagrees with the ticket or the approved plan, the ticket and the plan win.\n\n${blocks.join('\n\n')}`;
}

/**
 * The implementer re-run to resolve a merge conflict at publish. Leads the prompt: this
 * is the task now, not the ticket from scratch. The worker has already started the
 * merge; the agent resolves and commits it (or, if it merged cleanly, just re-checks).
 */
export function renderConflict(c: { base: string; files: string[] }): string {
  if (!c.files.length) {
    return `## MERGE CONFLICT — ALREADY RESOLVED\n\nThis branch could not be pushed because \`${c.base}\` had moved and conflicted with it. The factory merged the current \`${c.base}\` into this branch again and this time it merged cleanly. Your work is done; only make sure it still builds and its tests pass on top of the new \`${c.base}\`, and fix anything that broke. Don't redo the ticket.\n\n---\n\n`;
  }
  const list = c.files.map((f) => `- \`${f}\``).join('\n');
  return `## RESOLVE A MERGE CONFLICT FIRST\n\nYour work on this ticket is finished, but other work merged into \`${c.base}\` since you started changes the same lines, so the branch can't be pushed. The factory has started merging the current \`${c.base}\` into this branch; git stopped with conflicts in:\n\n${list}\n\nDo this, and only this:\n1. Open each file and resolve every \`<<<<<<<\` / \`=======\` / \`>>>>>>>\` block. **Keep both sides' intent**: what \`${c.base}\` added AND what this ticket added (for example, both new entries in a list, both new imports, both new tests). Never drop the other side's work to make yours fit.\n2. Make sure no conflict markers are left, then \`git add\` the files and \`git commit --no-edit\` to finish the merge.\n3. Build and run the tests that cover these files, and fix anything the combination broke.\n\nDon't redo or extend the ticket, and don't \`git merge --abort\` or rebase. The ticket is below for context.\n\n---\n\n`;
}

/**
 * How the planner answers a person in the chat. Their message comes first: a question
 * gets a direct answer with evidence before anything else, and a question they have
 * already seen is not repeated in full. Shared by the fresh and the resumed turn.
 */
export const CHAT_REPLY_RULES = `Respond to their latest message. **Answer it first, directly**: if they asked something (is this still needed, was it already done, why this approach), lead with a plain yes or no and the evidence. Don't change the subject back to your own questions. Then do exactly one of these:
- If checking shows the work isn't needed, reply with \`NOT_NEEDED:\` and the evidence, and stop.
- If something only they can decide still blocks a sound plan, reply with \`NEEDS_HUMAN:\` and the questions still open (numbered, at most 3). Don't repeat a question they have already seen word for word: say in one line that it's still open.
- Otherwise (re)write the whole plan to reflect everything agreed so far, and end with one or two sentences for them.`;

/** One turn of the planner chat as the prompt sees it. */
export interface ChatTurn { author: 'agent' | 'human'; body: string; by?: string | null }

/** The conversation so far as a prompt section (fresh re-run of a chat turn). Empty thread = no section. */
export function renderConversation(turns: ChatTurn[] | undefined): string {
  if (!turns || !turns.length) return '';
  const lines = turns.map((t) => `**${t.author === 'agent' ? 'You (planner)' : (t.by || 'Person')}:**\n${t.body.trim()}`);
  return `\n\n---\n\n## CONVERSATION SO FAR\n\nYou have been talking this ticket through with a person. Here is the whole conversation, oldest first:\n\n${lines.join('\n\n')}\n\n${CHAT_REPLY_RULES}`;
}

/**
 * The next message in a RESUMED planner session: just what the person said, plus a
 * short reminder of the protocol (the session already holds the ticket, the repo
 * reading and the full instructions, so none of that is re-sent).
 */
export function renderChatTurn(message: string, by: string | null | undefined, artifacts: string): string {
  return `${by || 'The person'} replied:\n\n> ${message.trim().replace(/\n/g, '\n> ')}\n\n---\n\n${CHAT_REPLY_RULES} Write the plan to \`${artifacts}/plan.md\`. Write no code.`;
}

/**
 * The factory's current ad-hoc (Things-to-do) list as a prompt section. `undefined`
 * renders nothing (keeps old prompts/tests unchanged); `'unavailable'` says so; `[]`
 * renders "none yet"; otherwise one `key: title` bullet per item.
 */
export function renderTodos(todos: PromptVars['todos']): string {
  if (todos === undefined) return '';
  const header = '\n\n---\n\n## CURRENT THINGS TO DO\n\nThe factory keeps a shared ad-hoc backlog. Here it is right now:\n\n';
  if (todos === 'unavailable') return `${header}(unavailable)`;
  if (!todos.length) return `${header}none yet`;
  return header + todos.map((t) => `- ${t.key}: ${t.title}`).join('\n');
}

/** Where an ad-hoc task's attachments live for a run (the worker downloads them there). */
export const attachmentsDir = (runDir: string) => join(runDir, 'attachments');

/**
 * The ticket body, with an ad-hoc task's attachments (#179) listed under it by
 * path so the role can open them (images included — the agent's Read tool views them).
 */
export function ticketBodyWithAttachments(ticket: RunContext['ticket'], runDir: string): string {
  const body = ticket.body || '(no description)';
  const files = ticket.attachments ?? [];
  if (!files.length) return body;
  const dir = attachmentsDir(runDir);
  const lines = files.map((f) => `- ${join(dir, f.name)} (${f.mime}, ${f.size} bytes)`);
  return `${body}\n\nAttached files (part of the task — open and read each one, images included):\n${lines.join('\n')}`;
}

/**
 * The not-needed check, for the roles that decide whether to do the work at all (the
 * planner, and the implementer when planning is off). The tester and reviewer check
 * work that has already been done, so they don't get it.
 */
const NOT_NEEDED_RULE = `The factory fetched the remote just before this turn, so \`origin/<default branch>\` in this checkout is the latest code. You have no repository credentials: don't try to fetch, and don't ask the person to check GitHub for you.

If the work this ticket asks for is already on \`origin/<default branch>\`, or the problem it describes doesn't happen (check the code, and what the ticket assumes about the setup), don't do it: reply with a line beginning \`NOT_NEEDED:\` and then the evidence (files and lines, commits, or why the problem can't occur), and stop without writing or committing anything. A person confirms and cancels the job, or tells you to go ahead. If it is only partly needed, say which part in your plan or work instead.

`;
const DECIDES_WORK = new Set(['planner', 'implementer']);

const TRAILER = (runId: string, cwd: string, role: string) => `
---

Run id: ${runId}. Working directory: ${cwd}.

Before anything else, confirm this repository is the right one for the ticket: the files, modules and stack the ticket names should exist in this checkout. If they do not, do not adapt the ticket to fit — instead print a single line beginning \`NEEDS_HUMAN:\` explaining which repository the ticket appears to mean, and stop without writing, committing or planning anything.

${DECIDES_WORK.has(role) ? NOT_NEEDED_RULE : ''}If at any point you are blocked on a decision only a person can make, reply beginning \`NEEDS_HUMAN:\` followed by your question(s), one per line, and stop.

If a review finding contradicts the approved plan or the ticket, or is factually wrong about the code, do not silently comply and do not loop — print one line beginning \`DISPUTE:\` quoting the finding and why it is wrong, and stop. A person will decide between you and the reviewer.`;

/**
 * The role file with {{variables}} substituted, plus a fixed trailer (run id,
 * the right-repo check, the NEEDS_HUMAN protocol). An unknown {{variable}}
 * throws — a silently blank substitution is how a prompt becomes wrong.
 */
export async function renderPrompt(role: string, runId: string, vars: PromptVars): Promise<string> {
  const template = await readFile(join(PROMPTS_DIR, `${role}.md`), 'utf8').catch(() => {
    throw new Error(`no prompt file for role "${role}" under prompts/roles/`);
  });
  const flat: Record<string, string> = {
    'ticket.key': vars.ticket.key,
    'ticket.title': vars.ticket.title,
    'ticket.body': ticketBodyWithAttachments(vars.ticket, vars.artifacts),
    'ticket.url': vars.ticket.url,
    'ticket.links': vars.ticket.links.map((l) => `- ${l.title}: ${l.url}`).join('\n') || '(none)',
    cwd: vars.cwd,
    branch: vars.branch,
    artifacts: vars.artifacts,
    // 0 turns = no ceiling: give the planner a concrete number anyway so it can size the work.
    'budget.implementerTurns': String(vars.budget?.implementerTurns || 150),
    'budget.timeoutMinutes': String(vars.budget?.timeoutMinutes || 45),
  };
  // No plan (the planner was switched off for this run): work from the ticket itself.
  flat['prior.plan.md'] = `No plan for this run, work from the ticket.\n\n**${vars.ticket.title}**\n\n${flat['ticket.body']}`;
  for (const [name, body] of Object.entries(vars.prior)) flat[`prior.${name}`] = body;

  const rendered = template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_m, key: string) => {
    if (key in flat) return flat[key];
    // A prior artifact that a role expects but that is genuinely absent (an upstream role
    // did not produce it) must not crash this role — render a placeholder so the run can
    // proceed and the human sees the gap. A non-prior unknown variable is a template typo: throw.
    if (key.startsWith('prior.')) return '(not available)';
    throw new Error(`prompt ${role}.md references unknown variable {{${key}}}`);
  });
  const banner = vars.revision && vars.revision.trim()
    ? `## REVISION REQUESTED\n\nA human reviewed your previous attempt and rejected it. Revise your work to address this note before doing anything else:\n\n> ${vars.revision.trim().replace(/\n/g, '\n> ')}\n\nTreat this note as an overriding instruction: it takes precedence over your earlier choices.\n\n---\n\n`
    : '';
  const conflictBanner = vars.conflict ? renderConflict(vars.conflict) : '';
  const wipNote = vars.wip && vars.wip.trim()
    ? `\n\n---\n\nA previous attempt at this role was cut short (${vars.wip.trim()}). Its partial work is committed as the HEAD commit on this branch — continue from it, do not start over.`
    : '';
  // Operator-authored standing guidance for this role, appended BELOW the shipped
  // template but ABOVE the trailer so the right-repo / NEEDS_HUMAN / DISPUTE protocol
  // stays authoritative and last. Empty skill = no section (prompt unchanged).
  const skillSection = vars.skill && vars.skill.trim()
    ? `\n\n---\n\n## ROLE SKILL\n\nStanding guidance for the ${role} on this factory. Follow it unless the ticket or the approved plan explicitly overrides it:\n\n${vars.skill.trim()}`
    : '';
  return conflictBanner + banner + rendered.trimEnd() + renderConversation(vars.conversation) + wipNote + skillSection + renderThirdPartySkills(vars.thirdPartySkills) + renderTestDb(role, vars.env) + renderTodos(vars.todos) + '\n' + TRAILER(runId, vars.cwd, role);
}

/** Which prior artifacts a role reads, by convention. Missing files are simply absent. */
export async function loadPriorArtifacts(runDir: string, names: string[], worktree?: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const body = await readArtifact(runDir, name, worktree);
    if (body !== null) out[name] = body;
  }
  return out;
}

/**
 * Read a role artifact by name. Writing roles run with cwd=worktree and are told to
 * write to the run dir ({{artifacts}}), but an agent may use a relative path and land
 * it in the worktree instead — the scope hook allows both. Look in the run dir first,
 * then the worktree, so a misplaced report doesn't hard-fail the next role.
 */
export async function readArtifact(runDir: string, name: string, worktree?: string): Promise<string | null> {
  const fromRun = await readFile(join(runDir, name), 'utf8').catch(() => null);
  if (fromRun !== null) return fromRun;
  if (worktree) return readFile(join(worktree, name), 'utf8').catch(() => null);
  return null;
}
