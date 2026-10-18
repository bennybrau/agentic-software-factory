import type { RunDetail } from './api';
import { gateTitle, runStateLabel, stageLabel } from './words';

/**
 * What the Orchestrator chat (/chat/:runId) says about the run right now: one live
 * message at the end of the thread that updates in place. Pure, so it can be tested.
 */
export interface ChatStatus {
  tone: 'working' | 'waiting' | 'done' | 'bad';
  /** Markdown, rendered like the agent's other messages. */
  text: string;
  prUrl?: string;
}

const ACTIVE = new Set(['pending', 'running']);

export function chatStatus(detail: RunDetail, repo: string | null): ChatStatus {
  const { run, tasks, gates } = detail;
  const key = run.ticketKey;
  const withReason = (s: string) => (run.reason ? `${s}: ${run.reason}` : `${s}.`);

  if (run.state === 'failed' || run.state === 'cancelled' || run.state === 'halted' || run.state === 'stale') {
    return { tone: 'bad', text: withReason(runStateLabel(run.state)) };
  }
  if (run.state === 'succeeded') {
    if (run.deliveryOutcome === 'split') {
      const n = detail.split?.parts.length ?? 0;
      return { tone: 'done', text: n ? `Queued ${n} task${n === 1 ? '' : 's'}.` : 'Queued the tasks.' };
    }
    return { tone: 'done', text: 'Done.', ...(run.changeRequestUrl ? { prUrl: run.changeRequestUrl } : {}) };
  }

  const open = gates.find((g) => g.state === 'open');
  if (open?.gateName === 'after_plan') return { tone: 'waiting', text: 'Over to you: approve the plan or reply below.' };
  if (open?.gateName === 'before_merge') {
    return { tone: 'waiting', text: 'Ready for you to merge.', ...(run.changeRequestUrl ? { prUrl: run.changeRequestUrl } : {}) };
  }
  if (open) return { tone: 'waiting', text: `Over to you: ${gateTitle(open.gateName)} Open the run to decide.` };

  const byRecent = [...tasks].sort((a, b) => b.seq - a.seq);
  const asking = byRecent.find((t) => t.state === 'needs_human');
  if (asking) {
    return String(asking.role) === 'planner'
      ? { tone: 'waiting', text: 'Over to you: approve the plan or reply below.' }
      : { tone: 'waiting', text: `Over to you: the team has a question about ${stageLabel(String(asking.role)).toLowerCase()}. Open the run to answer.` };
  }

  if (tasks.some((t) => t.runtime === 'publish' && ACTIVE.has(t.state))) return { tone: 'working', text: 'Opening the pull request.' };

  const roles = run.team.roles.map((r) => String(r.role));
  const current = byRecent.find((t) => t.runtime !== 'publish' && ACTIVE.has(t.state));
  const role = current ? String(current.role) : null;
  if (role === 'planner' && current?.state === 'running') {
    return { tone: 'working', text: `Created task ${key}. I'm planning it${repo ? ` in \`${repo}\`` : ''}…` };
  }
  if (role && role !== 'planner') {
    const n = roles.indexOf(role) + 1;
    const step = n > 0 ? ` (step ${n} of ${roles.length})` : '';
    return { tone: 'working', text: `The team is on it: ${stageLabel(role)}${step}.` };
  }
  if (run.state === 'queued' || role === 'planner') {
    return { tone: 'working', text: `Created task ${key}. Waiting for a worker to pick it up.` };
  }
  return { tone: 'working', text: `${runStateLabel(run.state)}.` };
}
