import { z } from 'zod';

/**
 * Planner-proposed splits. When a ticket is too big for one implementer pass /
 * one reviewable pull request, the planner writes its plan.md as usual AND adds
 * a fenced ```asf-split block: a JSON array of sub-tasks. The orchestrator (not
 * the LLM) acts on it: the plan gate becomes required, and on approval the
 * registry creates each sub-task as an ad-hoc task and queues it. A sub-task
 * with dependsOn waits until every sub-task it depends on has its PR MERGED, so
 * each one is planned and built on real code on main. Independent sub-tasks run
 * in parallel.
 *
 * Browser-safe (re-exported from ui.ts): no node built-ins here.
 */

export const SPLIT_FENCE = 'asf-split';
export const SPLIT_MIN = 2;
export const SPLIT_MAX = 8;

export const splitSubtaskSchema = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(20_000),
  /** 1-based positions of EARLIER sub-tasks whose PRs must merge before this one starts. */
  dependsOn: z.array(z.number().int().positive()).default([]),
  /** Path of another connected repository this part goes into; unset = the parent's repository. */
  repo: z.string().trim().min(1).max(300).optional(),
});
export type SplitSubtask = z.infer<typeof splitSubtaskSchema>;

export type SplitParse =
  | { kind: 'none' }
  | { kind: 'ok'; subtasks: SplitSubtask[] }
  | { kind: 'invalid'; reason: string };

const FENCE_RE = new RegExp('```' + SPLIT_FENCE + '[^\\n]*\\n([\\s\\S]*?)\\n```', 'g');

/**
 * Find and validate the split block in a plan. `none` = an ordinary plan.
 * `invalid` = the planner (or a person editing the plan) wrote a block we can't
 * act on; the gate refuses to approve it with this reason rather than guess.
 * dependsOn may only point at EARLIER sub-tasks, which makes cycles impossible.
 */
export function parseSplit(planMd: string | null | undefined): SplitParse {
  if (!planMd) return { kind: 'none' };
  const blocks = [...planMd.matchAll(FENCE_RE)];
  if (blocks.length === 0) {
    return planMd.includes('```' + SPLIT_FENCE)
      ? { kind: 'invalid', reason: `the \`${SPLIT_FENCE}\` block is not closed with \`\`\`` }
      : { kind: 'none' };
  }
  if (blocks.length > 1) return { kind: 'invalid', reason: `the plan has ${blocks.length} \`${SPLIT_FENCE}\` blocks; keep exactly one` };
  let raw: unknown;
  try { raw = JSON.parse(blocks[0][1]); } catch (e) {
    return { kind: 'invalid', reason: `the \`${SPLIT_FENCE}\` block is not valid JSON (${(e as Error).message})` };
  }
  const parsed = z.array(splitSubtaskSchema).safeParse(raw);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return { kind: 'invalid', reason: `sub-task ${i.path.length ? `${Number(i.path[0]) + 1} ${i.path.slice(1).join('.')}`.trim() : ''}: ${i.message}`.replace(/ +:/, ':') };
  }
  const subtasks = parsed.data;
  // One part is allowed only as a hand-off to another repository.
  const handOff = subtasks.length === 1 && !!subtasks[0].repo;
  if (subtasks.length < SPLIT_MIN && !handOff) return { kind: 'invalid', reason: `a split needs at least ${SPLIT_MIN} sub-tasks (got ${subtasks.length}); a single part needs a \`repo\` to hand it off to another repository, otherwise just write the plan` };
  if (subtasks.length > SPLIT_MAX) return { kind: 'invalid', reason: `at most ${SPLIT_MAX} sub-tasks (got ${subtasks.length})` };
  for (const [i, s] of subtasks.entries()) {
    const pos = i + 1;
    for (const d of s.dependsOn) {
      if (d >= pos) return { kind: 'invalid', reason: `sub-task ${pos} depends on ${d}; a sub-task may only depend on earlier ones` };
    }
  }
  return { kind: 'ok', subtasks: subtasks.map((s) => ({ ...s, dependsOn: [...new Set(s.dependsOn)].sort((a, b) => a - b) })) };
}

/**
 * A split as the run page shows it: the parent run that was split, and each part
 * with where it is now. Served for the parent run AND for each part's runs, so a
 * person can move between them without going back to Work history.
 */
export interface SplitPartWire {
  part: number;
  key: string;
  ticketId: string;
  /** The part's own title, without the "(KEY part n/m)" suffix it is stored with. */
  title: string;
  /** Keys of the earlier parts this one waits on. */
  dependsOn: string[];
  /** Of dependsOn, the ones whose pull request is not merged yet. */
  waitingOn: string[];
  /** Its Up next entry, if it still has one. */
  queueState: 'queued' | 'dispatched' | 'cancelled' | 'failed' | null;
  /** True once any run of this part has its pull request merged. */
  merged: boolean;
  /** The part's latest run, if it has been started. */
  run: { id: string; state: string; deliveryOutcome: string | null; changeRequestUrl: string | null; changeRequestState: string | null; costUsd: number } | null;
}
export interface SplitFamilyWire {
  parent: { runId: string; ticketKey: string; title: string };
  /** Set when the run being viewed is one of the parts (1-based), null on the parent. */
  currentPart: number | null;
  parts: SplitPartWire[];
}

/** "Data model (ADHOC-1 part 1/3)" -> "Data model". */
export function stripPartSuffix(title: string): string {
  return title.replace(/\s+\([^()]+ part \d+\/\d+\)$/, '');
}

/** The ticket body a sub-task is created with: its own scope, then where it came from. */
export function subtaskBody(s: SplitSubtask, n: number, of: number, parent: { key: string; title: string }, depKeys: string[]): string {
  const deps = depKeys.length
    ? `It starts only after ${depKeys.join(', ')} ${depKeys.length === 1 ? 'is' : 'are'} merged, so that work is already on the default branch.`
    : 'It does not depend on the other parts.';
  const repo = s.repo ? ` It goes into the repository \`${s.repo}\`.` : '';
  return `${s.body.trim()}\n\n---\n\nThis is part ${n} of ${of} of ${parent.key} (${parent.title}), which was split because it was too big for one pull request. Do only this part; the other parts are separate tasks. ${deps}${repo} This is already a sub-task: do not split it again.`;
}
