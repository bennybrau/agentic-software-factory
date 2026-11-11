import { KNOWN_CONNECTIONS, isKnownConnection, scmProviderKindSchema, ticketProviderKindSchema } from '@asf/shared';
import type { Sql } from '../db/pool.js';

/** Why the backfill refused. Nothing was changed. */
export class RefsBackfillError extends Error {}

/** The tables that store a repo_id and (since 023) its repo_connection. */
const TABLES = { agentRun: 'agent_run', workQueue: 'work_queue', recurringTask: 'recurring_task' } as const;

export type RefsBackfillCounts = Record<keyof typeof TABLES, number>;

/** A repo_id that already carries a known connection prefix. */
const QUALIFIED_RE = `^(${KNOWN_CONNECTIONS.join('|')}):`;

/**
 * M12 WP1: rewrite stored repo ids in the qualified form `<connection>:<native>`
 * and fill repo_connection, from the install's current SCM connection. A bare
 * repo_id belongs to `scm` (the one code host the install had before M12). A
 * qualified id with no repo_connection gets it from its prefix. Ticket ids and
 * ticket_provider are not changed. Idempotent, one transaction, and it refuses
 * rather than guesses: an unknown `scm`/`tickets` kind or a stored
 * ticket_provider that isn't a known connection changes nothing.
 * Returns the rows changed per table.
 */
export async function qualifyStoredRefs(sql: Sql, opts: { scm: string; tickets: string }): Promise<RefsBackfillCounts> {
  if (!scmProviderKindSchema.safeParse(opts.scm).success) throw new RefsBackfillError(`"${opts.scm}" is not an SCM provider kind`);
  if (!ticketProviderKindSchema.safeParse(opts.tickets).success) throw new RefsBackfillError(`"${opts.tickets}" is not a ticket provider kind`);
  const scm = opts.scm;
  return sql.begin(async (tx) => {
    const providers = await tx<{ ticketProvider: string }[]>`
      SELECT ticket_provider FROM agent_run UNION SELECT ticket_provider FROM work_queue`;
    const unknown = providers.map((p) => p.ticketProvider).filter((p) => !isKnownConnection(p));
    if (unknown.length) throw new RefsBackfillError(`stored ticket_provider not a known connection: ${unknown.sort().join(', ')}`);
    const counts = {} as RefsBackfillCounts;
    for (const [key, table] of Object.entries(TABLES) as [keyof typeof TABLES, string][]) {
      const bare = await tx`UPDATE ${tx(table)} SET repo_id = ${scm} || ':' || repo_id, repo_connection = ${scm}
        WHERE repo_id IS NOT NULL AND repo_id <> '' AND repo_id !~ ${QUALIFIED_RE}`;
      const filled = await tx`UPDATE ${tx(table)} SET repo_connection = substring(repo_id from ${QUALIFIED_RE})
        WHERE repo_connection IS NULL AND repo_id ~ ${QUALIFIED_RE}`;
      counts[key] = bare.count + filled.count;
    }
    return counts;
  }) as Promise<RefsBackfillCounts>;
}
