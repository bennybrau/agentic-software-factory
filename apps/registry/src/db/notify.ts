import type { Db, Sql } from './pool.js';

/**
 * One LISTEN connection per registry process. `appendEvent` NOTIFYs
 * `run_events` with "<runId>:<seq>"; subscribers (the SSE route) look the row
 * up and re-broadcast. Polling run_events for fan-out is what makes a board
 * feel laggy, and it breaks the moment there are two api instances.
 */
export type RunEventListener = (runId: string, seq: number) => void;

export async function listenRunEvents(sql: Sql, listener: RunEventListener): Promise<{ unlisten: () => Promise<void> }> {
  const { unlisten } = await sql.listen('run_events', (payload) => {
    const idx = payload.lastIndexOf(':');
    if (idx <= 0) return;
    listener(payload.slice(0, idx), Number(payload.slice(idx + 1)));
  });
  return { unlisten };
}

/**
 * `markQueueEntry` NOTIFYs `work_queue` with "<entryId>:<state>" when the
 * scheduler moves an entry, so the SSE route can tell browsers to refetch the
 * bell and Activity right away rather than on the next unrelated run event.
 */
export type QueueChangeListener = (id: string, state: string) => void;

export async function listenQueueChanges(sql: Sql, listener: QueueChangeListener): Promise<{ unlisten: () => Promise<void> }> {
  const { unlisten } = await sql.listen('work_queue', (payload) => {
    const idx = payload.lastIndexOf(':');
    if (idx <= 0) return;
    listener(payload.slice(0, idx), payload.slice(idx + 1));
  });
  return { unlisten };
}

/** Inside the transaction that moved the entry, so it only fires on commit. */
export async function notifyQueueChange(tx: Db, id: string, state: string): Promise<void> {
  await tx`SELECT pg_notify('work_queue', ${`${id}:${state}`})`;
}

/**
 * `recordNotification` NOTIFYs `notification` with "<id>:<kind>" for every row it
 * writes, so the SSE route can tell browsers to refetch the bell at once. This
 * covers notifications with no run event behind them (a failing credential).
 */
export type NotificationListener = (id: string, kind: string) => void;

export async function listenNotifications(sql: Sql, listener: NotificationListener): Promise<{ unlisten: () => Promise<void> }> {
  const { unlisten } = await sql.listen('notification', (payload) => {
    const idx = payload.lastIndexOf(':');
    if (idx <= 0) return;
    listener(payload.slice(0, idx), payload.slice(idx + 1));
  });
  return { unlisten };
}

/** Inside the transaction that wrote the row, so it only fires on commit. */
export async function notifyNotification(tx: Db, id: string, kind: string): Promise<void> {
  await tx`SELECT pg_notify('notification', ${`${id}:${kind}`})`;
}
