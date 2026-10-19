import { test } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { describeDbError } from './pool.js';
import { redactUrl } from '../server.js';
import { dbAvailable, TEST_URL } from '../test/harness.js';

const skip = !(await dbAvailable());

test('a wrong password is named, with the stale-volume hint (real Postgres error)', { skip }, async () => {
  const url = new URL(TEST_URL);
  url.password = 'definitely-not-the-password';
  const bad = postgres(url.toString(), { onnotice: () => {}, max: 1, connect_timeout: 5 });
  try {
    const err = await bad`select 1`.then(() => null, (e: unknown) => e);
    assert.ok(err, 'connecting with a wrong password must fail');
    const p = describeDbError(err);
    assert.equal(p.code, '28P01');
    assert.match(p.message, /password authentication failed/);
    assert.match(p.hint ?? '', /scripts\/uninstall\.sh/);
    assert.match(p.hint ?? '', /POSTGRES_PASSWORD/);
  } finally {
    await bad.end({ timeout: 1 });
  }
});

test('nothing listening is named, with a hint to check the container', async () => {
  const none = postgres('postgres://asf:x@127.0.0.1:1/asf', { onnotice: () => {}, max: 1, connect_timeout: 3 });
  try {
    const err = await none`select 1`.then(() => null, (e: unknown) => e);
    const p = describeDbError(err);
    assert.equal(p.code, 'ECONNREFUSED');
    assert.match(p.hint ?? '', /postgres container/);
  } finally {
    await none.end({ timeout: 1 });
  }
});

test('describeDbError copes with odd throwables and unknown codes', () => {
  assert.deepEqual(describeDbError('boom'), { code: undefined, message: 'boom', hint: undefined });
  assert.equal(describeDbError(null).message, 'null');
  const p = describeDbError(Object.assign(new Error('weird'), { code: 'XX000' }));
  assert.equal(p.code, 'XX000');
  assert.equal(p.hint, undefined);
  assert.match(describeDbError({ code: '3D000', message: 'database "x" does not exist' }).hint ?? '', /does not exist/);
});

test('redactUrl hides the password and nothing else', () => {
  assert.equal(redactUrl('postgres://asf:s3cr3t@postgres:5432/asf'), 'postgres://asf:***@postgres:5432/asf');
  assert.equal(redactUrl('postgres://asf:p@ss:w0rd@db/asf'), 'postgres://asf:***@db/asf');
  assert.equal(redactUrl('postgres://postgres/asf'), 'postgres://postgres/asf');
});
