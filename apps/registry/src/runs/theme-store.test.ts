import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLASSIC_THEME, rpcRequestSchema, type ThemeManifest } from '@asf/shared';
import { rpcHandlers } from '../routes/rpc.js';
import { MIGRATIONS_DIR } from '../db/migrate.js';
import { dbAvailable, testDb } from '../test/harness.js';

let db: Awaited<ReturnType<typeof testDb>>;
const skip = !(await dbAvailable());
before(async () => { if (!skip) db = await testDb('theme'); });
after(async () => { if (db) await db.close(); });

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const GIF = Buffer.from('GIF89a\x01\x00', 'latin1');
const b64 = (b: Buffer) => b.toString('base64');
const robots: ThemeManifest = { ...CLASSIC_THEME, id: 'robots', name: 'Robots', crew: { name: 'The Fleet' }, quips: undefined, moods: undefined };

test('a custom theme round-trips with its pictures, and replacing it keeps pictures it did not resend', { skip }, async () => {
  const h = rpcHandlers(db.sql);
  assert.deepEqual((await h.listThemes({ op: 'listThemes' })).themes, []);

  const put = await h.putTheme({ op: 'putTheme', manifest: robots, by: 'ana', images: [
    { slot: 'orchestrator', mime: 'image/gif', contentBase64: b64(GIF) },
    { slot: 'planner', mime: 'image/png', contentBase64: b64(PNG) },
  ] });
  assert.equal(put.theme.manifest.crew.name, 'The Fleet');
  assert.equal(put.theme.updatedBy, 'ana');
  assert.equal((await h.getTheme({ op: 'getTheme', id: 'robots' })).theme?.manifest.name, 'Robots');
  assert.equal((await h.getTheme({ op: 'getTheme', id: 'nobody' })).theme, null);

  const imgs = (await h.listThemeImages({ op: 'listThemeImages', themeId: 'robots' })).images;
  assert.deepEqual(imgs.map((i) => [i.slot, i.mime, i.size]), [['orchestrator', 'image/gif', GIF.length], ['planner', 'image/png', PNG.length]]);
  const queenV1 = imgs[0].version;

  await h.putTheme({ op: 'putTheme', manifest: { ...robots, name: 'Robots 2' }, by: 'bo', images: [{ slot: 'planner', mime: 'image/gif', contentBase64: b64(GIF) }] });
  const after2 = (await h.listThemeImages({ op: 'listThemeImages', themeId: 'robots' })).images;
  assert.equal(after2.find((i) => i.slot === 'orchestrator')!.version, queenV1, 'untouched slot keeps its version');
  assert.equal(after2.find((i) => i.slot === 'planner')!.mime, 'image/gif');
  assert.equal((await h.getTheme({ op: 'getTheme', id: 'robots' })).theme?.manifest.name, 'Robots 2');

  const got = (await h.getThemeImage({ op: 'getThemeImage', themeId: 'robots', slot: 'orchestrator' })).image;
  assert.deepEqual(Buffer.from(got!.contentBase64, 'base64'), GIF);
});

test('pictures can be set on a built-in theme; an unknown theme is a 404; a replace bumps only that version', { skip }, async () => {
  const h = rpcHandlers(db.sql);
  const first = await h.setThemeImages({ op: 'setThemeImages', themeId: 'hive', by: 'ana', images: [
    { slot: 'orchestrator', mime: 'image/gif', contentBase64: b64(GIF) },
    { slot: 'tester', mime: 'image/gif', contentBase64: b64(GIF) },
  ] });
  assert.deepEqual(first.images.map((i) => i.slot), ['orchestrator', 'tester']);
  const testerV1 = first.images[1].version;
  const second = await h.setThemeImages({ op: 'setThemeImages', themeId: 'hive', by: 'bo', images: [{ slot: 'orchestrator', mime: 'image/png', contentBase64: b64(PNG) }] });
  assert.notEqual(second.images[0].version, first.images[0].version);
  assert.equal(second.images[1].version, testerV1);

  await assert.rejects(
    h.setThemeImages({ op: 'setThemeImages', themeId: 'ghost', by: null, images: [{ slot: 'planner', mime: 'image/png', contentBase64: b64(PNG) }] }),
    /theme not found: ghost/,
  );

  // listThemeImages(null) is every theme's pictures, grouped by theme then slot order.
  const all = (await h.listThemeImages({ op: 'listThemeImages', themeId: null })).images;
  assert.ok(all.some((i) => i.themeId === 'hive' && i.slot === 'orchestrator'));
  assert.deepEqual(await h.deleteThemeImage({ op: 'deleteThemeImage', themeId: 'hive', slot: 'tester' }), { deleted: 1 });
  assert.deepEqual(await h.deleteThemeImage({ op: 'deleteThemeImage', themeId: 'hive', slot: 'tester' }), { deleted: 0 });
});

test('replacing a picture always moves its version forward, even when the stored time is ahead of the clock', { skip }, async () => {
  const h = rpcHandlers(db.sql);
  const set = async (b: Buffer) =>
    (await h.setThemeImages({ op: 'setThemeImages', themeId: 'hive', by: 'ana', images: [{ slot: 'reviewer', mime: 'image/png', contentBase64: b64(b) }] }))
      .images.find((i) => i.slot === 'reviewer')!;
  await set(PNG);
  await db.sql`UPDATE theme_image SET updated_at = now() + interval '1 hour' WHERE theme_id = 'hive' AND slot = 'reviewer'`;
  const old = (await h.listThemeImages({ op: 'listThemeImages', themeId: 'hive' })).images.find((i) => i.slot === 'reviewer')!;
  const replaced = await set(GIF);
  assert.ok(Number(replaced.version) > Number(old.version), `${replaced.version} > ${old.version}`);
  assert.deepEqual(await h.deleteThemeImage({ op: 'deleteThemeImage', themeId: 'hive', slot: 'reviewer' }), { deleted: 1 });
});

test('built-in ids cannot be stored or deleted; deleting a custom theme takes its pictures with it', { skip }, async () => {
  const h = rpcHandlers(db.sql);
  await assert.rejects(h.putTheme({ op: 'putTheme', manifest: { ...robots, id: 'hive' }, by: null, images: [] }), /"hive" is a built-in theme/);
  await assert.rejects(h.deleteTheme({ op: 'deleteTheme', id: 'classic' }), /built-in theme and cannot be deleted/);

  await h.putTheme({ op: 'putTheme', manifest: { ...robots, id: 'gone' }, by: null, images: [{ slot: 'reviewer', mime: 'image/png', contentBase64: b64(PNG) }] });
  assert.deepEqual(await h.deleteTheme({ op: 'deleteTheme', id: 'gone' }), { deleted: true });
  assert.deepEqual(await h.deleteTheme({ op: 'deleteTheme', id: 'gone' }), { deleted: false });
  assert.deepEqual((await h.listThemeImages({ op: 'listThemeImages', themeId: 'gone' })).images, []);
});

test('the registry re-checks a manifest it is handed (it is the system of record)', { skip }, async () => {
  const h = rpcHandlers(db.sql);
  await assert.rejects(h.putTheme({ op: 'putTheme', manifest: { ...robots, accent: 'red' } as ThemeManifest, by: null, images: [] }), /invalid theme/);
  // The RPC schema refuses it earlier still, so the HTTP path never reaches the store.
  assert.equal(rpcRequestSchema.safeParse({ op: 'putTheme', manifest: { ...robots, accent: 'url(x)' } }).success, false);
  assert.equal(rpcRequestSchema.safeParse({ op: 'getThemeImage', themeId: '../x', slot: 'planner' }).success, false);
  assert.equal(rpcRequestSchema.safeParse({ op: 'getThemeImage', themeId: 'hive', slot: 'queen' }).success, false);
});

test('migration 018 copies existing avatars onto the classic theme', { skip }, async () => {
  // testDb already ran 018 on an empty agent_avatar. Re-run its copy step against real rows: it is idempotent and keeps an existing picture.
  await db.sql`INSERT INTO agent_avatar (role, mime, bytes, updated_by) VALUES ('planner', 'image/png', ${PNG}, 'ana'), ('reviewer', 'image/gif', ${GIF}, 'bo')`;
  await db.sql`INSERT INTO theme_image (theme_id, slot, mime, bytes) VALUES ('classic', 'reviewer', 'image/png', ${PNG})`;
  const migration = readFileSync(join(MIGRATIONS_DIR, '018_theme.sql'), 'utf8');
  // 019 widened the key with state (default any), so replay the copy against the key it has now.
  const copy = migration.slice(migration.indexOf('INSERT INTO theme_image')).replace('ON CONFLICT (theme_id, slot)', 'ON CONFLICT (theme_id, slot, state)');
  await db.sql.unsafe(copy);
  await db.sql.unsafe(copy);
  const h = rpcHandlers(db.sql);
  const classic = (await h.listThemeImages({ op: 'listThemeImages', themeId: 'classic' })).images;
  assert.deepEqual(classic.map((i) => [i.slot, i.state, i.mime]), [['planner', 'any', 'image/png'], ['reviewer', 'any', 'image/png']]);
  assert.equal(classic[0].updatedBy, 'ana', 'who uploaded it carries over');
});

const WEBP = Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 ', 'latin1');

test('M13: a member has a picture per state beside its plain one; each replaces and deletes on its own', { skip }, async () => {
  const h = rpcHandlers(db.sql);
  await h.putTheme({ op: 'putTheme', manifest: { ...robots, id: 'states' }, by: 'ana', images: [
    { slot: 'planner', mime: 'image/png', contentBase64: b64(PNG) },
    { slot: 'planner', state: 'working', mime: 'image/webp', contentBase64: b64(WEBP) },
    { slot: 'planner', state: 'idle', mime: 'image/webp', contentBase64: b64(WEBP) },
    { slot: 'tester', state: 'done', mime: 'image/gif', contentBase64: b64(GIF) },
  ] });
  const list = async () => (await h.listThemeImages({ op: 'listThemeImages', themeId: 'states' })).images;
  // Member order, then any, idle, working, done.
  assert.deepEqual((await list()).map((i) => [i.slot, i.state, i.mime]), [
    ['planner', 'any', 'image/png'], ['planner', 'idle', 'image/webp'], ['planner', 'working', 'image/webp'], ['tester', 'done', 'image/gif'],
  ]);

  // getThemeImage: no state is the plain picture; a state is exactly that one, with no fallback in the store.
  const get = async (slot: 'planner' | 'tester', state?: 'any' | 'idle' | 'working' | 'done') =>
    (await h.getThemeImage(rpcRequestSchema.parse({ op: 'getThemeImage', themeId: 'states', slot, ...(state ? { state } : {}) }) as never)).image;
  assert.deepEqual(Buffer.from((await get('planner'))!.contentBase64, 'base64'), PNG);
  assert.deepEqual(Buffer.from((await get('planner', 'working'))!.contentBase64, 'base64'), WEBP);
  assert.equal((await get('planner', 'done')), null);
  assert.equal((await get('tester')), null);

  // Replacing one state leaves the member's other pictures (and their versions) alone.
  const before = await list();
  await h.setThemeImages({ op: 'setThemeImages', themeId: 'states', by: 'bo', images: [{ slot: 'planner', state: 'working', mime: 'image/gif', contentBase64: b64(GIF) }] });
  const after = await list();
  const v = (l: typeof after, st: string) => l.find((i) => i.slot === 'planner' && i.state === st)!;
  assert.notEqual(v(after, 'working').version, v(before, 'working').version);
  assert.equal(v(after, 'working').mime, 'image/gif');
  assert.equal(v(after, 'any').version, v(before, 'any').version);
  assert.equal(v(after, 'idle').version, v(before, 'idle').version);

  // Delete one state, then the rest of the member at once.
  assert.deepEqual(await h.deleteThemeImage({ op: 'deleteThemeImage', themeId: 'states', slot: 'planner', state: 'idle' }), { deleted: 1 });
  assert.deepEqual(await h.deleteThemeImage({ op: 'deleteThemeImage', themeId: 'states', slot: 'planner' }), { deleted: 2 });
  assert.deepEqual((await list()).map((i) => [i.slot, i.state]), [['tester', 'done']]);

  // The RPC refuses a state that is not one.
  assert.equal(rpcRequestSchema.safeParse({ op: 'getThemeImage', themeId: 'hive', slot: 'planner', state: 'sleeping' }).success, false);
  assert.equal(rpcRequestSchema.safeParse({ op: 'setThemeImages', themeId: 'hive', images: [{ slot: 'planner', state: 'happy', mime: 'image/png', contentBase64: 'eA==' }] }).success, false);
});

test('M13: a full set (5 members x plain + 3 states = 20, plus decor) fits one RPC; 22 does not', { skip }, async () => {
  const one = (slot: string, state: string) => ({ slot, state, mime: 'image/png', contentBase64: b64(PNG) });
  const full = ['orchestrator', 'planner', 'implementer', 'tester', 'reviewer'].flatMap((s) => ['any', 'idle', 'working', 'done'].map((st) => one(s, st)));
  assert.equal(full.length, 20);
  const parsed = rpcRequestSchema.parse({ op: 'setThemeImages', themeId: 'hive', images: full });
  const h = rpcHandlers(db.sql);
  const { images } = await h.setThemeImages(parsed as never);
  assert.equal(images.length, 20);
  const withDecor = [...full, one('decor', 'any')];
  assert.ok(rpcRequestSchema.safeParse({ op: 'setThemeImages', themeId: 'hive', images: withDecor }).success);
  assert.equal(rpcRequestSchema.safeParse({ op: 'setThemeImages', themeId: 'hive', images: [...withDecor, one('planner', 'idle')] }).success, false);
});

test('M13: migration 019 keeps every existing picture as the plain one and the key now includes state', { skip }, async () => {
  const [col] = await db.sql`SELECT column_default FROM information_schema.columns WHERE table_name = 'theme_image' AND column_name = 'state' AND table_schema = current_schema()`;
  assert.match(String(col.columnDefault), /'any'/);
  const key = await db.sql`SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
    WHERE i.indrelid = 'theme_image'::regclass AND i.indisprimary ORDER BY array_position(i.indkey, a.attnum)`;
  assert.deepEqual(key.map((r) => r.attname), ['theme_id', 'slot', 'state']);
  await assert.rejects(db.sql`INSERT INTO theme_image (theme_id, slot, state, mime, bytes) VALUES ('hive', 'planner', 'sleeping', 'image/png', ${PNG})`, /check/i);
});

test('a theme has one decor picture: stored, listed after the crew, fetched and deleted; decor with a state is refused', { skip }, async () => {
  const h = rpcHandlers(db.sql);
  await h.putTheme({ op: 'putTheme', manifest: { ...robots, id: 'decorated' }, by: 'ana', images: [
    { slot: 'decor', mime: 'image/webp', contentBase64: b64(WEBP) },
    { slot: 'reviewer', state: 'done', mime: 'image/png', contentBase64: b64(PNG) },
    { slot: 'orchestrator', mime: 'image/gif', contentBase64: b64(GIF) },
  ] });
  const list = async () => (await h.listThemeImages({ op: 'listThemeImages', themeId: 'decorated' })).images;
  assert.deepEqual((await list()).map((i) => [i.slot, i.state]), [['orchestrator', 'any'], ['reviewer', 'done'], ['decor', 'any']]);

  const got = (await h.getThemeImage(rpcRequestSchema.parse({ op: 'getThemeImage', themeId: 'decorated', slot: 'decor' }) as never)).image;
  assert.equal(got?.slot, 'decor');
  assert.equal(got?.state, 'any');
  assert.deepEqual(Buffer.from(got!.contentBase64, 'base64'), WEBP);

  // The store refuses decor with a state even when the RPC schema is bypassed.
  await assert.rejects(h.setThemeImages({ op: 'setThemeImages', themeId: 'decorated', by: null, images: [{ slot: 'decor', state: 'idle', mime: 'image/png', contentBase64: b64(PNG) }] }), /decor picture has no states/);
  await assert.rejects(h.getThemeImage({ op: 'getThemeImage', themeId: 'decorated', slot: 'decor', state: 'working' }), /decor picture has no states/);
  assert.equal(rpcRequestSchema.safeParse({ op: 'setThemeImages', themeId: 'decorated', images: [{ slot: 'decor', state: 'idle', mime: 'image/png', contentBase64: 'eA==' }] }).success, false);

  assert.deepEqual(await h.deleteThemeImage({ op: 'deleteThemeImage', themeId: 'decorated', slot: 'decor' }), { deleted: 1 });
  assert.deepEqual((await list()).map((i) => i.slot), ['orchestrator', 'reviewer']);
  assert.equal((await h.getThemeImage({ op: 'getThemeImage', themeId: 'decorated', slot: 'decor' })).image, null);
});
