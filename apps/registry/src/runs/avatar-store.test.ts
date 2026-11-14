import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rpcHandlers } from '../routes/rpc.js';
import { dbAvailable, testDb } from '../test/harness.js';

let db: Awaited<ReturnType<typeof testDb>>;
const skip = !(await dbAvailable());
before(async () => { if (!skip) db = await testDb('avatar'); });
after(async () => { if (db) await db.close(); });

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const GIF = Buffer.from('GIF89a\x01\x00', 'latin1');
const b64 = (b: Buffer) => b.toString('base64');

test('the avatar RPC ops round-trip; a partial upload keeps the other roles', { skip }, async () => {
  const h = rpcHandlers(db.sql);
  assert.deepEqual((await h.listAvatars({ op: 'listAvatars' })).avatars, []);

  const first = await h.setAvatars({ op: 'setAvatars', by: 'ana', avatars: [
    { role: 'planner', mime: 'image/png', contentBase64: b64(PNG) },
    { role: 'tester', mime: 'image/png', contentBase64: b64(PNG) },
  ] });
  assert.deepEqual(first.avatars.map((a) => [a.role, a.mime, a.size, a.updatedBy]), [['planner', 'image/png', PNG.length, 'ana'], ['tester', 'image/png', PNG.length, 'ana']]);
  const plannerV1 = first.avatars.find((a) => a.role === 'planner')!.version;
  const testerV1 = first.avatars.find((a) => a.role === 'tester')!.version;

  const got = (await h.getAvatar({ op: 'getAvatar', role: 'planner' })).avatar;
  assert.ok(got);
  assert.deepEqual(Buffer.from(got!.contentBase64, 'base64'), PNG);
  assert.equal(got!.version, plannerV1);
  assert.equal((await h.getAvatar({ op: 'getAvatar', role: 'reviewer' })).avatar, null);

  // A second zip with only the planner replaces the planner; the tester is untouched.
  const second = await h.setAvatars({ op: 'setAvatars', by: 'bo', avatars: [{ role: 'planner', mime: 'image/gif', contentBase64: b64(GIF) }] });
  const planner = second.avatars.find((a) => a.role === 'planner')!;
  const tester = second.avatars.find((a) => a.role === 'tester')!;
  assert.equal(planner.mime, 'image/gif');
  assert.equal(planner.updatedBy, 'bo');
  assert.notEqual(planner.version, plannerV1, 'a replace bumps the version');
  assert.equal(tester.version, testerV1);
  assert.equal(tester.updatedBy, 'ana');

  assert.deepEqual(await h.deleteAvatar({ op: 'deleteAvatar', role: 'tester' }), { deleted: true });
  assert.deepEqual(await h.deleteAvatar({ op: 'deleteAvatar', role: 'tester' }), { deleted: false });
  assert.deepEqual((await h.listAvatars({ op: 'listAvatars' })).avatars.map((a) => a.role), ['planner']);
});

test('replacing an avatar always moves its version forward, even when the stored time is ahead of the clock', { skip }, async () => {
  const h = rpcHandlers(db.sql);
  const set = async (b: Buffer, mime: 'image/png' | 'image/gif') =>
    (await h.setAvatars({ op: 'setAvatars', by: 'ana', avatars: [{ role: 'reviewer', mime, contentBase64: b64(b) }] }))
      .avatars.find((a) => a.role === 'reviewer')!;
  await set(PNG, 'image/png');
  await db.sql`UPDATE agent_avatar SET updated_at = now() + interval '1 hour' WHERE role = 'reviewer'`;
  const old = (await h.getAvatar({ op: 'getAvatar', role: 'reviewer' })).avatar!;
  const replaced = await set(GIF, 'image/gif');
  assert.ok(Number(replaced.version) > Number(old.version), `${replaced.version} > ${old.version}`);
  assert.deepEqual(await h.deleteAvatar({ op: 'deleteAvatar', role: 'reviewer' }), { deleted: true });
});

test('the table refuses a role that is not one of the four', { skip }, async () => {
  await assert.rejects(db.sql`INSERT INTO agent_avatar (role, mime, bytes) VALUES ('designer', 'image/png', ${PNG})`);
});
