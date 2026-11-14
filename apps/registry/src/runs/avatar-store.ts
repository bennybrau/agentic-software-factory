import type { AvatarInput, AvatarMetaWire, AvatarRole, AvatarWire } from '@asf/shared';
import type { Sql } from '../db/pool.js';

/**
 * Agent avatars: one image per role, org-wide. The api has already checked the
 * type and size. An upload replaces only the roles it carries; the others keep
 * their current image. `version` is updated_at in ms, so it strictly increases on every replace.
 */

const meta = (r: Record<string, unknown>): AvatarMetaWire => {
  const at = r.updatedAt instanceof Date ? r.updatedAt : new Date(String(r.updatedAt));
  return {
    role: r.role as AvatarRole, mime: r.mime as AvatarMetaWire['mime'], size: Number(r.size),
    version: String(at.getTime()), updatedBy: r.updatedBy == null ? null : String(r.updatedBy), updatedAt: at.toISOString(),
  };
};

export async function setAvatars(sql: Sql, avatars: AvatarInput[], by: string | null): Promise<AvatarMetaWire[]> {
  await sql.begin(async (tx) => {
    for (const a of avatars) {
      const bytes = Buffer.from(a.contentBase64, 'base64');
      // clock_timestamp, not now(): every role in one upload still gets a fresh version even within one transaction.
      // A replace moves updated_at at least 1 ms past the old one, so its ms version (the api's ETag and
      // cache-buster) strictly increases even for two replaces within the same ms or after a clock step back.
      await tx`INSERT INTO agent_avatar (role, mime, bytes, updated_by, updated_at)
        VALUES (${a.role}, ${a.mime}, ${bytes}, ${by}, clock_timestamp())
        ON CONFLICT (role) DO UPDATE SET mime = EXCLUDED.mime, bytes = EXCLUDED.bytes,
          updated_by = EXCLUDED.updated_by, updated_at = greatest(EXCLUDED.updated_at, agent_avatar.updated_at + interval '1 millisecond')`;
    }
  });
  return listAvatars(sql);
}

export async function listAvatars(sql: Sql): Promise<AvatarMetaWire[]> {
  const rows = await sql`SELECT role, mime, octet_length(bytes) AS size, updated_by, updated_at FROM agent_avatar ORDER BY role`;
  return rows.map(meta);
}

export async function getAvatar(sql: Sql, role: AvatarRole): Promise<AvatarWire | null> {
  const [row] = await sql`SELECT role, mime, bytes, octet_length(bytes) AS size, updated_by, updated_at FROM agent_avatar WHERE role = ${role}`;
  if (!row) return null;
  return { ...meta(row), contentBase64: Buffer.from(row.bytes as Uint8Array).toString('base64') };
}

export async function deleteAvatar(sql: Sql, role: AvatarRole): Promise<boolean> {
  const rows = await sql`DELETE FROM agent_avatar WHERE role = ${role} RETURNING role`;
  return rows.length > 0;
}
