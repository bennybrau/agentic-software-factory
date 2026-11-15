import { randomBytes } from 'node:crypto';
import { ADHOC_ID_PREFIX, TERMINAL_RUN_STATES, nextRunAfter, scheduleSchema } from '@asf/shared';
import type { CreateRecurringTaskInput, RecurringLastRun, RecurringTask, RunState, Schedule, UpdateRecurringTaskInput } from '@asf/shared';
import type { Db, Sql } from '../db/pool.js';
import { NotFoundError } from './store.js';
import { newId } from './ids.js';
import { notifyQueueChange } from '../db/notify.js';

/**
 * Recurring tasks (#188): an ad-hoc task the registry creates on a schedule.
 * `fireDueRecurring` is the firing loop; it is deterministic and idempotent per
 * slot (the recurring_occurrence primary key), so two tickers or a restart
 * never fire one slot twice. Each fired task is a snapshot copy: editing the
 * schedule later never touches tasks it already created.
 */

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));

/** Each schedule with what happened at its latest slot: the occurrence joined to that task's latest run. */
const SELECT_RECURRING = `
  SELECT t.*, o.outcome AS last_outcome, o.adhoc_id AS last_adhoc_id, o.at AS last_at,
         a.key AS last_key, r.id AS last_run_id, r.state AS last_state, r.delivery_outcome AS last_delivery_outcome
  FROM recurring_task t
  LEFT JOIN LATERAL (SELECT * FROM recurring_occurrence WHERE recurring_id = t.id ORDER BY slot_at DESC LIMIT 1) o ON true
  LEFT JOIN adhoc_task a ON a.id = o.adhoc_id
  LEFT JOIN LATERAL (SELECT id, state, delivery_outcome FROM agent_run WHERE ticket_id = o.adhoc_id ORDER BY created_at DESC LIMIT 1) r ON true`;

function toTask(row: Record<string, unknown>): RecurringTask {
  return {
    id: String(row.id), title: String(row.title), body: String(row.body ?? ''), repoId: String(row.repoId),
    schedule: row.schedule as Schedule, timezone: String(row.timezone), paused: Boolean(row.paused),
    nextRunAt: row.nextRunAt == null ? null : iso(row.nextRunAt),
    lastRun: row.lastOutcome == null ? null : {
      adhocId: String(row.lastAdhocId ?? ''), key: String(row.lastKey ?? ''),
      runId: row.lastRunId == null ? null : String(row.lastRunId),
      state: row.lastState == null ? null : (String(row.lastState) as RunState),
      deliveryOutcome: row.lastDeliveryOutcome == null ? null : (String(row.lastDeliveryOutcome) as RecurringLastRun['deliveryOutcome']),
      skipped: row.lastOutcome === 'skipped',
      at: iso(row.lastAt),
    },
    createdBy: row.createdBy == null ? null : String(row.createdBy),
    createdAt: iso(row.createdAt),
  };
}

export async function listRecurring(sql: Sql): Promise<RecurringTask[]> {
  const rows = await sql.unsafe(`${SELECT_RECURRING} ORDER BY t.created_at`);
  return rows.map(toTask);
}

export async function getRecurring(sql: Db, id: string): Promise<RecurringTask | null> {
  const [row] = await sql.unsafe(`${SELECT_RECURRING} WHERE t.id = $1`, [id]);
  return row ? toTask(row) : null;
}

/** Unpaused schedules due within the next `withinHours`, soonest first. */
export async function upcomingRecurring(sql: Sql, withinHours: number, now: Date = new Date()): Promise<RecurringTask[]> {
  const until = new Date(now.getTime() + withinHours * 3_600_000);
  const rows = await sql.unsafe(`${SELECT_RECURRING} WHERE NOT t.paused AND t.next_run_at <= $1 ORDER BY t.next_run_at`, [until]);
  return rows.map(toTask);
}

export async function createRecurring(sql: Sql, input: CreateRecurringTaskInput, by: string | null, now: Date = new Date()): Promise<RecurringTask> {
  const id = newId('rec');
  const next = nextRunAfter(input.schedule, input.timezone, now);
  await sql`INSERT INTO recurring_task (id, title, body, repo_id, schedule, timezone, paused, next_run_at, created_by)
    VALUES (${id}, ${input.title}, ${input.body}, ${input.repoId}, ${sql.json(input.schedule)}, ${input.timezone}, ${input.paused}, ${next}, ${by})`;
  return (await getRecurring(sql, id))!;
}

/** Applies `patch`. next_run_at is recomputed from `now` only when the schedule or zone changes, or the task is resumed. */
export async function updateRecurring(sql: Sql, id: string, patch: UpdateRecurringTaskInput, now: Date = new Date()): Promise<RecurringTask> {
  return sql.begin(async (tx) => {
    const [row] = await tx`SELECT * FROM recurring_task WHERE id = ${id} FOR UPDATE`;
    if (!row) throw new NotFoundError('recurring task', id);
    const schedule = patch.schedule ?? (row.schedule as Schedule);
    const timezone = patch.timezone ?? String(row.timezone);
    const paused = patch.paused ?? Boolean(row.paused);
    const timingChanged = JSON.stringify(schedule) !== JSON.stringify(row.schedule) || timezone !== String(row.timezone);
    const resumed = Boolean(row.paused) && !paused;
    const next = timingChanged || resumed ? nextRunAfter(schedule, timezone, now) : (row.nextRunAt as Date | null);
    await tx`UPDATE recurring_task SET title = ${patch.title ?? String(row.title)}, body = ${patch.body ?? String(row.body)},
        repo_id = ${patch.repoId ?? String(row.repoId)}, schedule = ${tx.json(schedule)}, timezone = ${timezone},
        paused = ${paused}, next_run_at = ${next}, updated_at = now()
      WHERE id = ${id}`;
    return (await getRecurring(tx, id))!;
  });
}

export async function setRecurringPaused(sql: Sql, id: string, paused: boolean, now: Date = new Date()): Promise<RecurringTask> {
  return updateRecurring(sql, id, { paused }, now);
}

/** Deletes the schedule and its occurrences; the ad-hoc tasks it created stay. */
export async function deleteRecurring(sql: Sql, id: string): Promise<boolean> {
  const rows = await sql`DELETE FROM recurring_task WHERE id = ${id} RETURNING id`;
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Firing

export interface FireResult {
  fired: { recurringId: string; slotAt: string; adhocId: string; key: string }[];
  skipped: { recurringId: string; slotAt: string; adhocId: string; reason: string }[];
}

const localDate = (tz: string, t: Date): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);

/**
 * Fire every unpaused schedule whose next_run_at has passed. One transaction per
 * row, so one bad row is logged and the rest still fire.
 *
 * The slot is the latest scheduled time <= now. A slot on an earlier local day
 * than now (the registry was down) records nothing. A slot whose previous task is
 * still queued or running is recorded as skipped. Otherwise a new ad-hoc task is
 * created and queued. next_run_at always moves to the first slot after now.
 */
export async function fireDueRecurring(
  sql: Sql, now: Date = new Date(),
  log: { error: (o: unknown, m?: string) => void } = { error: (o, m) => console.error(m, o) },
): Promise<FireResult> {
  const result: FireResult = { fired: [], skipped: [] };
  const due = await sql`SELECT id FROM recurring_task WHERE NOT paused AND next_run_at <= ${now} ORDER BY next_run_at`;
  for (const { id } of due) {
    try {
      await sql.begin((tx) => fireOne(tx, String(id), now, result));
    } catch (err) {
      log.error({ err, recurringId: String(id) }, 'recurring task failed to fire');
    }
  }
  return result;
}

async function fireOne(tx: Db, id: string, now: Date, result: FireResult): Promise<void> {
  const [t] = await tx`SELECT * FROM recurring_task WHERE id = ${id} AND NOT paused AND next_run_at <= ${now} FOR UPDATE SKIP LOCKED`;
  if (!t) return; // another ticker has it, or it was just paused or advanced
  const schedule = scheduleSchema.parse(t.schedule);
  const tz = String(t.timezone);

  // Walk forward from next_run_at, so a restart lands on the same slot as before.
  let slot = new Date(t.nextRunAt as Date);
  for (let n = nextRunAfter(schedule, tz, slot); n <= now; n = nextRunAfter(schedule, tz, n)) slot = n;

  if (localDate(tz, slot) === localDate(tz, now)) {
    const [prev] = await tx`SELECT o.adhoc_id, a.key,
        EXISTS (SELECT 1 FROM work_queue q WHERE q.ticket_id = o.adhoc_id AND q.state = 'queued') AS queued,
        (SELECT r.state FROM agent_run r WHERE r.ticket_id = o.adhoc_id AND r.state NOT IN ${tx(TERMINAL_RUN_STATES as string[])}
          ORDER BY r.created_at DESC LIMIT 1) AS live_state
      FROM recurring_occurrence o LEFT JOIN adhoc_task a ON a.id = o.adhoc_id
      WHERE o.recurring_id = ${id} AND o.outcome = 'fired'
      ORDER BY o.slot_at DESC LIMIT 1`;
    const busy = prev && (prev.queued || prev.liveState != null);
    if (busy) {
      const reason = `${prev.key ?? prev.adhocId} is still ${prev.queued ? 'queued' : prev.liveState === 'awaiting_checkpoint' ? 'waiting at a gate' : String(prev.liveState)}`;
      const ins = await tx`INSERT INTO recurring_occurrence (recurring_id, slot_at, outcome, adhoc_id, reason)
        VALUES (${id}, ${slot}, 'skipped', ${String(prev.adhocId)}, ${reason}) ON CONFLICT DO NOTHING RETURNING slot_at`;
      if (ins.length > 0) result.skipped.push({ recurringId: id, slotAt: slot.toISOString(), adhocId: String(prev.adhocId), reason });
    } else {
      const hex = randomBytes(8).toString('hex');
      const adhocId = `${ADHOC_ID_PREFIX}${hex}`;
      const key = `ADHOC-${hex.slice(0, 8).toUpperCase()}`;
      const ins = await tx`INSERT INTO recurring_occurrence (recurring_id, slot_at, outcome, adhoc_id)
        VALUES (${id}, ${slot}, 'fired', ${adhocId}) ON CONFLICT DO NOTHING RETURNING slot_at`;
      if (ins.length > 0) {
        await tx`INSERT INTO adhoc_task (id, key, title, body, created_by, recurring_id)
          VALUES (${adhocId}, ${key}, ${String(t.title)}, ${String(t.body)}, 'schedule', ${id})`;
        // Like split.ts queueParts: its own batch, parallel mode, at the tail.
        const [{ tail }] = await tx`SELECT coalesce(max(position), 0) AS tail FROM work_queue WHERE state = 'queued'`;
        const [entry] = await tx`INSERT INTO work_queue (ticket_id, ticket_provider, ticket_key, repo_id, team_name, max_cost_usd, mode, position, batch_id, added_by)
          VALUES (${adhocId}, 'adhoc', ${key}, ${String(t.repoId)}, ${null}, ${null}, 'parallel', ${Number(tail) + 1}, ${newId('batch')}, ${`schedule:${String(t.title)}`})
          RETURNING id`;
        await notifyQueueChange(tx, String(entry.id), 'queued');
        result.fired.push({ recurringId: id, slotAt: slot.toISOString(), adhocId, key });
      }
    }
  }
  await tx`UPDATE recurring_task SET next_run_at = ${nextRunAfter(schedule, tz, now)} WHERE id = ${id}`;
}

/** Fires due schedules every `intervalMs`. A setTimeout chain, so a slow tick never overlaps the next. */
export function startRecurringTicker(sql: Sql, log: { info: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void }, intervalMs: number): () => void {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const tick = async () => {
    try {
      const r = await fireDueRecurring(sql, new Date(), log);
      if (r.fired.length || r.skipped.length) log.info(r, 'recurring');
    } catch (err) { log.error(err, 'recurring tick failed'); }
    if (!stopped) { timer = setTimeout(tick, intervalMs); timer.unref(); }
  };
  timer = setTimeout(tick, intervalMs);
  timer.unref();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
