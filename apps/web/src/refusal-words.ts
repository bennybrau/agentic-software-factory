import type { WorkQueueEntry } from '@asf/shared';
import { bucketLabel } from './words';

/**
 * Words for refused starts (#138): a queued ticket the scheduler couldn't start,
 * and the monthly budget that most often is why.
 */

/**
 * The "budget reached" line, or null when there is no budget (≤ 0) or it isn't reached.
 * The same sentence the api refuses a dispatch with: keep it in step with
 * apps/api/src/routes/dispatch.ts (the over_budget refusal).
 */
export function budgetReachedText(monthCostUsd: number, monthlyBudgetUsd: number | null | undefined): string | null {
  if (!monthlyBudgetUsd || monthlyBudgetUsd <= 0 || monthCostUsd < monthlyBudgetUsd) return null;
  return `This month's runs have cost $${monthCostUsd.toFixed(2)}, which has reached the monthly budget of $${monthlyBudgetUsd}. Raise the budget in Settings, or wait for next month.`;
}

/** Refused entries by ticket id (the newest wins: the list comes newest first). */
export function refusedByTicket(entries: WorkQueueEntry[]): Map<string, WorkQueueEntry> {
  const out = new Map<string, WorkQueueEntry>();
  for (const e of entries) if (!out.has(e.ticketId)) out.set(e.ticketId, e);
  return out;
}

/** A ticket row's "Where it is" pill: "Couldn't start" with the reason when it was refused. */
export function wherePill(bucket: string, refused?: WorkQueueEntry): { label: string; note?: string } {
  if (refused) return { label: 'Couldn’t start', ...(refused.reason ? { note: refused.reason } : {}) };
  return { label: bucketLabel(bucket) };
}
