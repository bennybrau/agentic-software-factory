import type { Db, Sql } from '../db/pool.js';

/**
 * The notification store. Rows are written by the orchestrator inside the same
 * transaction as the state change that warranted them, so a notification is as
 * durable as the run state itself — the api can be down when a gate opens and
 * the row is still there for the inbox and the Telegram sink when it returns.
 */

export interface NotificationRow {
  id: string;
  /** null for an org-level notification (a failing credential). */
  runId: string | null;
  gateId: string | null;
  kind: string;
  title: string;
  body: string;
  actions: { label: string; url: string }[];
  createdAt: string;
  readAt: string | null;
  deliveredAt: string | null;
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));
function toRow(r: Record<string, unknown>): NotificationRow {
  return {
    id: String(r.id), runId: r.runId == null ? null : String(r.runId), gateId: r.gateId ? String(r.gateId) : null,
    kind: String(r.kind), title: String(r.title), body: String(r.body ?? ''),
    actions: (r.actions as NotificationRow['actions']) ?? [],
    createdAt: iso(r.createdAt)!, readAt: iso(r.readAt), deliveredAt: iso(r.deliveredAt),
  };
}

/** Record a notification. Called from the orchestrator's tx so it commits atomically with the state change. */
export async function recordNotification(tx: Db, n: { runId: string | null; gateId?: string | null; queueEntryId?: string | null; kind: string; title: string; body?: string; actions?: { label: string; url: string }[] }): Promise<void> {
  await tx`INSERT INTO notification (run_id, gate_id, queue_entry_id, kind, title, body, actions)
    VALUES (${n.runId}, ${n.gateId ?? null}, ${n.queueEntryId ?? null}, ${n.kind}, ${n.title}, ${n.body ?? ''}, ${tx.json((n.actions ?? []) as never)})`;
}

export async function listNotifications(sql: Sql, q: { unreadOnly?: boolean; limit: number }): Promise<{ notifications: NotificationRow[]; unread: number }> {
  const rows = await sql`SELECT * FROM notification
    WHERE (${q.unreadOnly ?? false} = false OR read_at IS NULL)
    ORDER BY created_at DESC LIMIT ${q.limit}`;
  const [{ unread }] = await sql<{ unread: number }[]>`SELECT count(*)::int AS unread FROM notification WHERE read_at IS NULL`;
  return { notifications: rows.map(toRow), unread: Number(unread) };
}

/** Mark one notification read, or all (id = null). */
export async function markNotificationRead(sql: Sql, id: string | null): Promise<void> {
  if (id == null) await sql`UPDATE notification SET read_at = now() WHERE read_at IS NULL`;
  else await sql`UPDATE notification SET read_at = now() WHERE id = ${id} AND read_at IS NULL`;
}

/** The external sink's read: rows not yet delivered, oldest first. */
export async function undeliveredNotifications(sql: Sql, limit: number): Promise<NotificationRow[]> {
  return (await sql`SELECT * FROM notification WHERE delivered_at IS NULL ORDER BY id LIMIT ${limit}`).map(toRow);
}

export async function markNotificationDelivered(sql: Sql, id: string): Promise<void> {
  await sql`UPDATE notification SET delivered_at = now() WHERE id = ${id}`;
}

/** Clear (delete) all notifications from the web inbox. Undelivered rows simply
 * never reach an external sink, which is the intended effect of a manual clear;
 * the delivery cursor keys off delivered_at IS NULL so it is not corrupted. */
export async function clearNotifications(sql: Sql): Promise<void> {
  await sql`DELETE FROM notification`;
}
