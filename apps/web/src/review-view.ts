import type { Run } from '@asf/shared';
import { outcomeLabel, runStateLabel } from './words';

type RunLike = Pick<Run, 'state' | 'deliveryOutcome'> & { team: Pick<Run['team'], 'reviewTarget'> };

/**
 * The line under a review-only run's ticket key: "Review of PR #42" (GitHub) or
 * "Review of MR !7" (GitLab), linking to the change request. Null for an ordinary run.
 */
export function reviewHeading(run: RunLike): { text: string; url: string } | null {
  const t = run.team.reviewTarget;
  if (!t) return null;
  const gitlab = t.url.includes('/-/merge_requests/');
  return { text: gitlab ? `Review of MR !${t.number}` : `Review of PR #${t.number}`, url: t.url };
}

/** The run page's header pill: a split or a finished review says so, else the run state. */
export function runPillLabel(run: RunLike): string {
  if (run.deliveryOutcome === 'split') return outcomeLabel('split');
  if (run.deliveryOutcome === 'reviewed') return outcomeLabel('reviewed');
  return runStateLabel(run.state);
}

/**
 * The Activity table's "Result": a run left for someone to merge says what happened
 * to its pull request once it's merged or closed; otherwise the stored outcome.
 */
export function runResultLabel(run: Pick<Run, 'deliveryOutcome' | 'changeRequestState'>): string {
  if (run.deliveryOutcome === 'awaiting_external_merge') {
    if (run.changeRequestState === 'merged') return outcomeLabel('merged');
    if (run.changeRequestState === 'closed') return 'Closed without merging';
  }
  return outcomeLabel(run.deliveryOutcome);
}
