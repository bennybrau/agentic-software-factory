import type { RunEvent } from '@asf/shared';

/**
 * The run page's activity feed (#107): one line per tool call, built from a task's
 * `tool:pre` / `tool:post` / `tool:denied` events. Pure, so the strip and the tests
 * share it.
 */
export type ActivityKind = 'read' | 'edit' | 'search' | 'command' | 'other';
export type ActivityState = 'running' | 'ok' | 'failed' | 'denied' | 'unfinished';
export interface ActivityLine {
  key: string;
  seq: number;
  kind: ActivityKind;
  target: string;
  startedAt: string;
  ms: number | null;
  state: ActivityState;
}

export const ACTIVITY_MAX_LINES = 500;

const KINDS: Record<string, ActivityKind> = {
  read: 'read', notebookread: 'read',
  write: 'edit', edit: 'edit', multiedit: 'edit', notebookedit: 'edit', file_change: 'edit',
  grep: 'search', glob: 'search',
  bash: 'command', command_execution: 'command',
};
/** Case-insensitive, so OpenCode's lowercase `read`/`edit`/`grep` map like Claude Code's. */
export function kindOf(tool: string): ActivityKind {
  return KINDS[tool.toLowerCase()] ?? 'other';
}

/** Copilot has no hooks and no event stream, so its tasks never have activity. */
export function reportsActivity(runtime: string | null | undefined): boolean {
  return runtime !== 'copilot';
}

/** Two event lists as one: de-duplicated by seq, in seq order. */
export function mergeEvents(a: RunEvent[], b: RunEvent[]): RunEvent[] {
  const bySeq = new Map<number, RunEvent>();
  for (const e of [...a, ...b]) bySeq.set(e.seq, e);
  return [...bySeq.values()].sort((x, y) => x.seq - y.seq);
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The summary without its `Tool: ` prefix (when it has one), paths relative to the worktree. */
function targetOf(tool: string, summary: string, worktree: string | null, runId: string): string {
  let t = summary.startsWith(`${tool}: `) ? summary.slice(tool.length + 2) : summary;
  const root = worktree?.replace(/\/+$/, '');
  if (root) t = t.replace(new RegExp(`${escape(root)}(/|(?=[\\s'"]|$))`, 'g'), (_, slash: string) => (slash ? '' : '.'));
  else t = t.replace(new RegExp(`/(?:[^\\s'"]*/)?runs/${escape(runId)}/`, 'g'), '');
  return t || tool;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/**
 * Lines from one task's tool events. A `tool:post` closes the oldest open `tool:pre`
 * of the same tool (FIFO); a post with no pre (Codex, OpenCode) is a complete line
 * with no duration. A pre still open is `running`, or `unfinished` once the task is
 * no longer running. Keeps the last ACTIVITY_MAX_LINES lines.
 */
export function buildLines(events: RunEvent[], opts: { running: boolean; worktree: string | null; runId: string }): ActivityLine[] {
  const lines: ActivityLine[] = [];
  const open = new Map<string, ActivityLine[]>();
  for (const e of mergeEvents(events, [])) {
    if (e.kind !== 'tool:pre' && e.kind !== 'tool:post' && e.kind !== 'tool:denied') continue;
    const p = e.payload as Record<string, unknown>;
    const tool = str(p.tool) || 'unknown';
    if (e.kind === 'tool:post') {
      const pre = open.get(tool)?.shift();
      const state = p.ok === false ? 'failed' : 'ok';
      if (pre) {
        pre.state = state;
        pre.ms = Math.max(0, new Date(e.at).getTime() - new Date(pre.startedAt).getTime());
        continue;
      }
      lines.push(line(e, tool, p, opts, state));
      continue;
    }
    const l = line(e, tool, p, opts, e.kind === 'tool:denied' ? 'denied' : opts.running ? 'running' : 'unfinished');
    lines.push(l);
    if (e.kind === 'tool:pre') open.set(tool, [...(open.get(tool) ?? []), l]);
  }
  return lines.slice(-ACTIVITY_MAX_LINES);
}

function line(e: RunEvent, tool: string, p: Record<string, unknown>, opts: { worktree: string | null; runId: string }, state: ActivityState): ActivityLine {
  return {
    key: String(e.seq), seq: e.seq, kind: kindOf(tool),
    target: targetOf(tool, str(p.summary) || tool, opts.worktree, opts.runId),
    startedAt: e.at, ms: null, state,
  };
}
