import { builtInTheme, themeManifestSchema, THEME_DECOR_SLOT, THEME_IMAGE_SLOTS, THEME_IMAGE_STATES } from '@asf/shared';
import type { ThemeImageInput, ThemeImageMetaWire, ThemeImageSlot, ThemeImageState, ThemeImageWire, ThemeManifest, ThemeRecordWire } from '@asf/shared';
import type { Sql } from '../db/pool.js';
import { NotFoundError } from './store.js';

/**
 * Themes (M12). Custom themes are stored as their manifest; built-in themes live
 * in code. Pictures can be stored for any theme. The api has already checked
 * every picture's type and size and parsed the manifest; the registry re-checks
 * the manifest (it is the system of record) and refuses a built-in id.
 */

export class ThemeError extends Error { override name = 'ThemeError'; }

const at = (v: unknown) => (v instanceof Date ? v : new Date(String(v)));

const imageMeta = (r: Record<string, unknown>): ThemeImageMetaWire => {
  const t = at(r.updatedAt);
  return {
    themeId: String(r.themeId), slot: r.slot as ThemeImageSlot, state: (r.state ?? 'any') as ThemeImageState, mime: r.mime as ThemeImageMetaWire['mime'], size: Number(r.size),
    version: String(t.getTime()), updatedBy: r.updatedBy == null ? null : String(r.updatedBy), updatedAt: t.toISOString(),
  };
};

const record = (r: Record<string, unknown>): ThemeRecordWire => ({
  manifest: r.manifest as ThemeManifest,
  updatedBy: r.updatedBy == null ? null : String(r.updatedBy),
  updatedAt: at(r.updatedAt).toISOString(),
});

/** Decor has no states: it is only ever stored as the plain (`any`) picture. */
function assertDecorState(slot: ThemeImageSlot, state: ThemeImageState | null | undefined): void {
  if (slot === THEME_DECOR_SLOT && state != null && state !== 'any') throw new ThemeError(`the decor picture has no states (got "${state}")`);
}

async function writeImages(tx: Sql, themeId: string, images: ThemeImageInput[], by: string | null): Promise<void> {
  for (const i of images) assertDecorState(i.slot, i.state);
  for (const i of images) {
    const bytes = Buffer.from(i.contentBase64, 'base64');
    // clock_timestamp, not now(): every picture in one upload still gets a fresh version within one transaction.
    // A replace moves updated_at at least 1 ms past the old one, so its ms version (the web's cache-buster)
    // strictly increases even for two replaces within the same ms or after a clock step back.
    await tx`INSERT INTO theme_image (theme_id, slot, state, mime, bytes, updated_by, updated_at)
      VALUES (${themeId}, ${i.slot}, ${i.state ?? 'any'}, ${i.mime}, ${bytes}, ${by}, clock_timestamp())
      ON CONFLICT (theme_id, slot, state) DO UPDATE SET mime = EXCLUDED.mime, bytes = EXCLUDED.bytes,
        updated_by = EXCLUDED.updated_by, updated_at = greatest(EXCLUDED.updated_at, theme_image.updated_at + interval '1 millisecond')`;
  }
}

export async function listThemes(sql: Sql): Promise<ThemeRecordWire[]> {
  const rows = await sql`SELECT manifest, updated_by, updated_at FROM theme ORDER BY id`;
  return rows.map(record);
}

export async function getTheme(sql: Sql, id: string): Promise<ThemeRecordWire | null> {
  const [row] = await sql`SELECT manifest, updated_by, updated_at FROM theme WHERE id = ${id}`;
  return row ? record(row) : null;
}

/** Create or replace a custom theme, optionally with pictures, in one transaction. */
export async function putTheme(sql: Sql, manifest: ThemeManifest, images: ThemeImageInput[], by: string | null): Promise<ThemeRecordWire> {
  const parsed = themeManifestSchema.safeParse(manifest);
  if (!parsed.success) throw new ThemeError(`invalid theme: ${parsed.error.issues[0]?.message ?? 'bad manifest'}`);
  const m = parsed.data;
  if (builtInTheme(m.id)) throw new ThemeError(`"${m.id}" is a built-in theme`);
  await sql.begin(async (tx) => {
    await tx`INSERT INTO theme (id, manifest, updated_by, updated_at) VALUES (${m.id}, ${tx.json(m as never)}, ${by}, clock_timestamp())
      ON CONFLICT (id) DO UPDATE SET manifest = EXCLUDED.manifest, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`;
    await writeImages(tx as unknown as Sql, m.id, images, by);
  });
  return (await getTheme(sql, m.id))!;
}

/** Delete a custom theme and its pictures. Built-in themes cannot be deleted. */
export async function deleteTheme(sql: Sql, id: string): Promise<boolean> {
  if (builtInTheme(id)) throw new ThemeError(`"${id}" is a built-in theme and cannot be deleted`);
  let deleted = false;
  await sql.begin(async (tx) => {
    const rows = await tx`DELETE FROM theme WHERE id = ${id} RETURNING id`;
    deleted = rows.length > 0;
    if (deleted) await tx`DELETE FROM theme_image WHERE theme_id = ${id}`;
  });
  return deleted;
}

async function assertThemeExists(sql: Sql, id: string): Promise<void> {
  if (builtInTheme(id)) return;
  const [row] = await sql`SELECT 1 FROM theme WHERE id = ${id}`;
  if (!row) throw new NotFoundError('theme', id);
}

/** Replace the given pictures (member and state) on a theme, built-in or custom. Every other picture stays. */
export async function setThemeImages(sql: Sql, themeId: string, images: ThemeImageInput[], by: string | null): Promise<ThemeImageMetaWire[]> {
  await assertThemeExists(sql, themeId);
  await sql.begin(async (tx) => { await writeImages(tx as unknown as Sql, themeId, images, by); });
  return listThemeImages(sql, themeId);
}

/** Picture metadata for one theme, or for every theme when `themeId` is null. Member then state order within a theme, decor last. */
export async function listThemeImages(sql: Sql, themeId: string | null): Promise<ThemeImageMetaWire[]> {
  const rows = themeId === null
    ? await sql`SELECT theme_id, slot, state, mime, octet_length(bytes) AS size, updated_by, updated_at FROM theme_image`
    : await sql`SELECT theme_id, slot, state, mime, octet_length(bytes) AS size, updated_by, updated_at FROM theme_image WHERE theme_id = ${themeId}`;
  const order = (s: string) => THEME_IMAGE_SLOTS.indexOf(s as ThemeImageSlot);
  const stateOrder = (s: string) => THEME_IMAGE_STATES.indexOf(s as ThemeImageState);
  return rows.map(imageMeta).sort((a, b) =>
    a.themeId.localeCompare(b.themeId) || order(a.slot) - order(b.slot) || stateOrder(a.state) - stateOrder(b.state));
}

export async function getThemeImage(sql: Sql, themeId: string, slot: ThemeImageSlot, state: ThemeImageState = 'any'): Promise<ThemeImageWire | null> {
  assertDecorState(slot, state);
  const [row] = await sql`SELECT theme_id, slot, state, mime, bytes, octet_length(bytes) AS size, updated_by, updated_at
    FROM theme_image WHERE theme_id = ${themeId} AND slot = ${slot} AND state = ${state}`;
  if (!row) return null;
  return { ...imageMeta(row), contentBase64: Buffer.from(row.bytes as Uint8Array).toString('base64') };
}

/** Delete one picture (member and state), or every picture the member has when `state` is null. Returns how many went. */
export async function deleteThemeImage(sql: Sql, themeId: string, slot: ThemeImageSlot, state: ThemeImageState | null = null): Promise<number> {
  assertDecorState(slot, state);
  const rows = state === null
    ? await sql`DELETE FROM theme_image WHERE theme_id = ${themeId} AND slot = ${slot} RETURNING slot`
    : await sql`DELETE FROM theme_image WHERE theme_id = ${themeId} AND slot = ${slot} AND state = ${state} RETURNING slot`;
  return rows.length;
}
