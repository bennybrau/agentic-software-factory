import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';

/**
 * Shared helpers for the Claude Code hooks. Dependency-free ESM, invoked by
 * absolute path, so they run anywhere Node 22 does. With none of the ASF_*
 * variables set they do nothing and exit 0 — safe to configure on a machine
 * that also does ordinary interactive work.
 */
export const env = {
  runId: process.env.ASF_RUN_ID ?? '',
  taskId: process.env.ASF_TASK_ID ?? '',
  role: process.env.ASF_ROLE ?? '',
  apiUrl: (process.env.ASF_API_URL ?? '').replace(/\/+$/, ''),
  secret: process.env.ASF_RUN_SECRET ?? '',
  runDir: process.env.ASF_RUN_DIR ?? '',
  scopeRoot: process.env.ASF_SCOPE_ROOT ?? '',
  writes: process.env.ASF_WRITES === '1',
};

export function isFactoryRun() {
  return env.runId !== '' && env.taskId !== '';
}

export async function readInput() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** Absolute paths a tool call would write to. */
export function writtenPaths(input) {
  const tool = input?.tool_name ?? '';
  if (!WRITE_TOOLS.has(tool)) return [];
  const ti = input?.tool_input ?? {};
  const paths = [];
  for (const key of ['file_path', 'path', 'notebook_path']) if (typeof ti[key] === 'string') paths.push(ti[key]);
  if (Array.isArray(ti.edits)) for (const e of ti.edits) if (typeof e?.file_path === 'string') paths.push(e.file_path);
  return paths;
}

/**
 * Where a write may land. Every role may write under the run dir (its artifact —
 * plan.md, test-report.md, review.md — which every prompt is told to write there,
 * outside the worktree; the run dir is worker-owned and mirrored to the registry).
 * Only a writing role may also write under the worktree (source changes).
 * Returns 'run-dir' | 'worktree' | null (out of scope).
 */
export function writeScope(path) {
  if (!env.scopeRoot && !env.runDir) return 'worktree';
  const abs = isAbsolute(path) ? path : resolve(env.scopeRoot || env.runDir, path);
  const under = (r) => { if (!r) return false; const root = resolve(r); return abs === root || abs.startsWith(root + sep); };
  if (under(env.runDir)) return 'run-dir';
  if (under(env.scopeRoot)) return 'worktree';
  return null;
}

/** Whether THIS role may write `path`: run dir for everyone, worktree only if the role writes. */
export function writeAllowed(path) {
  const scope = writeScope(path);
  return scope === 'run-dir' || (scope === 'worktree' && env.writes);
}

/** @deprecated kept for callers/tests; true if the path is under worktree or run dir. */
export function insideScope(path) {
  return writeScope(path) !== null;
}

/** A Bash command that pushes, adds a remote, or exfiltrates a token. */
export function isBlockedBash(input) {
  if ((input?.tool_name ?? '') !== 'Bash') return null;
  const cmd = typeof input?.tool_input?.command === 'string' ? input.tool_input.command : '';
  if (/\bgit\s+push\b/.test(cmd)) return 'git push is the worker\'s job, not the agent\'s';
  if (/\bgit\s+remote\s+(add|set-url)\b/.test(cmd)) return 'changing git remotes is not allowed in a run';
  return null;
}

export function block(reason) {
  process.stderr.write(reason + '\n');
  // Claude Code reads a JSON decision on stdout; the exit code is the backstop.
  process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
  process.exit(2);
}

export function writeHalt(kind, detail) {
  if (!env.runDir) return;
  try { mkdirSync(env.runDir, { recursive: true }); writeFileSync(`${env.runDir}/halt-${kind}.json`, JSON.stringify(detail)); } catch { /* best effort */ }
}

const SUMMARY_MAX = 160; // TOOL_SUMMARY_MAX in @asf/shared; the api redacts and caps again.

/**
 * One-line summary of a tool call for the run's activity feed. Reads only
 * `command` (Bash), `pattern` (Grep/Glob), `file_path` and `path` — never
 * `content`, `new_string`, `old_string` or any env value, so file bodies and
 * edits never leave the machine. At most SUMMARY_MAX characters.
 */
export function describeTool(input) {
  const tool = input?.tool_name ?? 'unknown';
  const ti = input?.tool_input ?? {};
  const str = (v) => (typeof v === 'string' ? v : '');
  let detail = '';
  if (tool === 'Bash') detail = str(ti.command);
  else if (tool === 'Grep' || tool === 'Glob') detail = [str(ti.pattern), str(ti.path)].filter(Boolean).join(' in ');
  else detail = str(ti.file_path) || str(ti.path);
  return (detail ? `${tool}: ${detail}` : tool).slice(0, SUMMARY_MAX);
}

/** Post an event to the api. Returns the ack (which carries cancelRequested), or null on any failure. */
export async function postEvent(kind, payload) {
  if (!env.apiUrl || !isFactoryRun()) return null;
  try {
    const res = await fetch(`${env.apiUrl}/api/runs/${env.runId}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-run-secret': env.secret },
      body: JSON.stringify({ taskId: env.taskId, kind, source: 'agent', payload }),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null; // FAIL OPEN: a down api must not kill the agent.
  }
}
