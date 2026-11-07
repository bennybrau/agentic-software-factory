import { randomBytes } from 'node:crypto';
import { ADHOC_ID_PREFIX } from '@asf/shared';
import type { AdhocAttachmentWire, AdhocTask, CreateAdhocInput } from '@asf/shared';
import type { Sql } from '../db/pool.js';

/**
 * Ad-hoc tasks (#179): tickets that live in our Postgres instead of a tracker.
 * The id is stored whole (`adhoc:<hex>`) so every other table that records a
 * ticket id (agent_run.ticket_id, the queue) holds the same string. Written
 * once; there is no edit path.
 */

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));

export async function createAdhoc(sql: Sql, input: CreateAdhocInput): Promise<AdhocTask> {
  const hex = randomBytes(8).toString('hex');
  const id = `${ADHOC_ID_PREFIX}${hex}`;
  const key = `ADHOC-${hex.slice(0, 8).toUpperCase()}`;
  await sql.begin(async (tx) => {
    // An agent to-do records the run that added it as parent_run_id with no part (a split part has one).
    await tx`INSERT INTO adhoc_task (id, key, title, body, created_by, parent_run_id)
      VALUES (${id}, ${key}, ${input.title}, ${input.body}, ${input.createdBy}, ${input.sourceRunId ?? null})`;
    for (const [position, a] of input.attachments.entries()) {
      const bytes = Buffer.from(a.contentBase64, 'base64');
      await tx`INSERT INTO adhoc_attachment (task_id, name, mime, size, content, position)
        VALUES (${id}, ${a.name}, ${a.mime}, ${bytes.length}, ${bytes}, ${position})`;
    }
  });
  return (await getAdhoc(sql, id))!;
}

export async function getAdhoc(sql: Sql, id: string): Promise<AdhocTask | null> {
  // The schedule may have been deleted since (no foreign key): recurringId stays, the title is null.
  const [row] = await sql`SELECT a.*, rt.title AS recurring_title, src.repo_id AS source_repo_id FROM adhoc_task a
    LEFT JOIN recurring_task rt ON rt.id = a.recurring_id
    LEFT JOIN agent_run src ON src.id = a.parent_run_id AND a.part IS NULL WHERE a.id = ${id}`;
  if (!row) return null;
  const files = await sql`SELECT name, mime, size FROM adhoc_attachment WHERE task_id = ${id} ORDER BY position`;
  return {
    id: String(row.id), key: String(row.key), title: String(row.title), body: String(row.body ?? ''),
    createdBy: row.createdBy == null ? null : String(row.createdBy),
    attachments: files.map((f) => ({ name: String(f.name), mime: String(f.mime), size: Number(f.size) })),
    createdAt: iso(row.createdAt), recurringId: row.recurringId == null ? null : String(row.recurringId),
    recurringTitle: row.recurringTitle == null ? null : String(row.recurringTitle),
    sourceRepoId: row.sourceRepoId == null ? null : String(row.sourceRepoId),
  };
}

/** Ad-hoc tasks that no run has consumed yet (ticket_id never recorded on an agent_run), newest first. */
export async function listAdhoc(sql: Sql): Promise<AdhocTask[]> {
  const rows = await sql`
    SELECT a.*, rt.title AS recurring_title, src.repo_id AS source_repo_id FROM adhoc_task a
    LEFT JOIN agent_run r ON r.ticket_id = a.id
    LEFT JOIN recurring_task rt ON rt.id = a.recurring_id
    LEFT JOIN agent_run src ON src.id = a.parent_run_id AND a.part IS NULL
    WHERE r.id IS NULL
    ORDER BY a.created_at DESC`;
  const tasks: AdhocTask[] = [];
  for (const row of rows) {
    const files = await sql`SELECT name, mime, size FROM adhoc_attachment WHERE task_id = ${row.id} ORDER BY position`;
    tasks.push({
      id: String(row.id), key: String(row.key), title: String(row.title), body: String(row.body ?? ''),
      createdBy: row.createdBy == null ? null : String(row.createdBy),
      attachments: files.map((f) => ({ name: String(f.name), mime: String(f.mime), size: Number(f.size) })),
      createdAt: iso(row.createdAt), recurringId: row.recurringId == null ? null : String(row.recurringId),
      recurringTitle: row.recurringTitle == null ? null : String(row.recurringTitle),
      sourceRepoId: row.sourceRepoId == null ? null : String(row.sourceRepoId),
    });
  }
  return tasks;
}

/** Delete an ad-hoc task (attachments cascade); returns whether a row existed. */
export async function deleteAdhoc(sql: Sql, id: string): Promise<boolean> {
  const rows = await sql`DELETE FROM adhoc_task WHERE id = ${id} RETURNING id`;
  return rows.length > 0;
}

export async function getAdhocAttachment(sql: Sql, id: string, name: string): Promise<AdhocAttachmentWire | null> {
  const [row] = await sql`SELECT name, mime, size, content FROM adhoc_attachment WHERE task_id = ${id} AND name = ${name}`;
  if (!row) return null;
  return { name: String(row.name), mime: String(row.mime), size: Number(row.size), contentBase64: Buffer.from(row.content as Uint8Array).toString('base64') };
}
