import type { TodayWire, WorkQueueEntry } from '@asf/shared';
import { nativeId, parseRef } from '@asf/shared/ui';
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

/**
 * The newest refusal for a ticket row (the list comes newest first). The queue stores
 * the native id beside its provider, while a row id may carry a connection prefix
 * (`jira:PROJ-12`): both sides are compared by native id, and a prefix must also be
 * the entry's provider. Ad-hoc ids keep their `adhoc:` prefix, so they match exactly.
 */
export function refusalFor(entries: WorkQueueEntry[], rowId: string): WorkQueueEntry | undefined {
  const row = parseRef(rowId, '');
  return entries.find((e) => nativeId(e.ticketId) === row.native
    && (!row.qualified || row.connection === 'adhoc' || row.connection === e.ticketProvider));
}

/** How often Planned tasks checks the queue while something waits to start (the scheduler ticks every 5 s). */
export const QUEUE_POLL_MS = 3_000;

/** The refetch interval for the queue: on while something is queued, off otherwise. */
export function queuePollInterval(today: TodayWire | undefined): number | false {
  return today && today.queued.length > 0 ? QUEUE_POLL_MS : false;
}

/** A ticket row's "Where it is" pill: "Couldn't start" with the reason when it was refused. */
export function wherePill(bucket: string, refused?: WorkQueueEntry): { label: string; note?: string } {
  if (refused) return { label: 'Couldn’t start', ...(refused.reason ? { note: refused.reason } : {}) };
  return { label: bucketLabel(bucket) };
}
