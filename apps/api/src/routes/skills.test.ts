import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import type { ThirdPartySkill } from '@asf/shared';
import { registerSkillRoutes, idFromName } from './skills.js';
import type { SkillFetchResult } from '../skills/fetch.js';

// Skills live in the registry (over HTTP via registry/client.ts), so global
// fetch is stubbed with a tiny in-memory registry; the GitHub/GitLab fetcher is injected.
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

const URL_ = 'https://github.com/acme/skills/tree/main/pdf';
const fetched = (name = 'pdf-tools'): SkillFetchResult => ({
  ok: true,
  skill: { name, description: 'PDFs', sourceUrl: URL_, sourceRef: 'main', commitSha: 'a'.repeat(40), files: [{ path: 'SKILL.md', content: '---\nname: x\n---\nhéllo' }] },
  skipped: [{ path: 'run.sh', reason: 'not text' }],
});
const stored = (id: string, over: Partial<ThirdPartySkill> = {}): ThirdPartySkill => ({
  ...(fetched() as Extract<SkillFetchResult, { ok: true }>).skill, id, enabled: false, roles: ['planner', 'implementer', 'tester', 'reviewer'], addedBy: null, updatedAt: '', ...over,
});

type Call = { op: string; [k: string]: unknown };
function stubRegistry(initial: ThirdPartySkill[] = [], opts: { putConflict?: string } = {}) {
  const calls: Call[] = [];
  const skills = new Map(initial.map((s) => [s.id, s]));
  global.fetch = (async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse((init?.body as string) ?? '{}') as Call;
    calls.push(body);
    const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    switch (body.op) {
      case 'listSkills': return ok({ skills: [...skills.values()] });
      case 'getSkill': return ok({ skill: skills.get(body.id as string) ?? null });
      case 'putSkill': {
        if (opts.putConflict) return new Response(JSON.stringify({ error: 'skill_error', reason: opts.putConflict }), { status: 409 });
        const s = body.skill as ThirdPartySkill;
        const prev = skills.get(s.id);
        const next = { ...s, enabled: prev?.enabled ?? false, roles: prev?.roles ?? stored(s.id).roles, updatedAt: 'now' };
        skills.set(s.id, next);
        return ok({ skill: next });
      }
      case 'setSkillState': {
        const s = { ...skills.get(body.id as string)!, enabled: body.enabled as boolean, ...(body.roles ? { roles: body.roles as ThirdPartySkill['roles'] } : {}) };
        skills.set(s.id, s);
        return ok({ skill: s });
      }
      case 'deleteSkill': return ok({ deleted: skills.delete(body.id as string) });
      default: return ok({});
    }
  }) as unknown as typeof fetch;
  return { calls, skills };
}

async function app(result: SkillFetchResult = fetched()) {
  const urls: string[] = [];
  const a = Fastify();
  registerSkillRoutes(a, { fetchSkill: async (url) => { urls.push(url); return result; } });
  await a.ready();
  return { a, urls };
}

test('idFromName drops leading dashes and fits the id pattern', () => {
  assert.equal(idFromName('pdf-tools'), 'pdf-tools');
  assert.equal(idFromName('--x-y'), 'x-y');
  assert.equal(idFromName('a'.repeat(64)), 'a'.repeat(32));
  assert.equal(idFromName('a'), null);
});

test('POST /api/skills/preview fetches and shows what was skipped, saving nothing', async () => {
  const { calls } = stubRegistry();
  const { a, urls } = await app();
  const res = await a.inject({ method: 'POST', url: '/api/skills/preview', payload: { url: URL_ } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().skill.name, 'pdf-tools');
  assert.deepEqual(res.json().skipped, [{ path: 'run.sh', reason: 'not text' }]);
  assert.deepEqual(urls, [URL_]);
  assert.ok(!calls.some((c) => c.op === 'putSkill'));

  assert.equal((await a.inject({ method: 'POST', url: '/api/skills/preview', payload: {} })).statusCode, 400);
  await a.close();
});

test('a fetch refusal is a 400 bad_skill with the reason', async () => {
  stubRegistry([stored('pdf-tools')]);
  const { a } = await app({ ok: false, reason: 'no SKILL.md' });
  for (const [method, url] of [['POST', '/api/skills/preview'], ['POST', '/api/skills'], ['POST', '/api/skills/pdf-tools/refresh']] as const) {
    const res = await a.inject({ method, url, payload: { url: URL_ } });
    assert.equal(res.statusCode, 400, url);
    assert.deepEqual(res.json(), { error: 'bad_skill', reason: 'no SKILL.md' });
  }
  await a.close();
});

test('POST /api/skills stores the skill off, under the frontmatter name or a given id; an existing id is 409', async () => {
  const { calls, skills } = stubRegistry();
  const { a } = await app();
  const res = await a.inject({ method: 'POST', url: '/api/skills', payload: { url: URL_ } });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.json().skill.id, 'pdf-tools');
  assert.equal(res.json().skill.enabled, false);
  assert.deepEqual(res.json().skill.files, [{ path: 'SKILL.md', size: Buffer.byteLength('---\nname: x\n---\nhéllo') }]);
  assert.equal(res.json().skipped.length, 1);
  assert.equal(skills.get('pdf-tools')!.files[0].content.endsWith('héllo'), true);

  const again = await a.inject({ method: 'POST', url: '/api/skills', payload: { url: URL_ } });
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().error, 'skill_exists');
  assert.equal(calls.filter((c) => c.op === 'putSkill').length, 1);

  const named = await a.inject({ method: 'POST', url: '/api/skills', payload: { url: URL_, id: 'pdf-2' } });
  assert.equal(named.statusCode, 201);
  assert.equal(named.json().skill.id, 'pdf-2');

  const badId = await a.inject({ method: 'POST', url: '/api/skills', payload: { url: URL_, id: 'Bad Id' } });
  assert.equal(badId.statusCode, 400);
  await a.close();
});

test('POST /api/skills stamps addedBy from the caller identity', async () => {
  const { skills } = stubRegistry();
  const { a } = await app();
  const res = await a.inject({ method: 'POST', url: '/api/skills', payload: { url: URL_ }, headers: { 'x-operator': 'ann' } });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.json().skill.addedBy, 'ann');
  assert.equal(skills.get('pdf-tools')!.addedBy, 'ann');
  await a.close();
});

test('a registry skill_error on put is a 409 with its reason', async () => {
  stubRegistry([], { putConflict: 'invalid skill: too big' });
  const { a } = await app();
  const res = await a.inject({ method: 'POST', url: '/api/skills', payload: { url: URL_ } });
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.json(), { error: 'skill_error', reason: 'invalid skill: too big' });
  await a.close();
});

test('GET /api/skills lists skills with paths and sizes but no contents', async () => {
  stubRegistry([stored('pdf-tools')]);
  const { a } = await app();
  const res = (await a.inject({ url: '/api/skills' })).json();
  assert.equal(res.skills.length, 1);
  assert.equal(res.skills[0].id, 'pdf-tools');
  assert.equal(res.skills[0].files[0].path, 'SKILL.md');
  assert.equal('content' in res.skills[0].files[0], false);
  await a.close();
});

test('PATCH /api/skills/:id sets enabled and roles; a missing enabled keeps the current one; unknown is 404', async () => {
  const { calls } = stubRegistry([stored('pdf-tools', { enabled: true })]);
  const { a } = await app();
  const roles = await a.inject({ method: 'PATCH', url: '/api/skills/pdf-tools', payload: { roles: ['reviewer'] } });
  assert.equal(roles.statusCode, 200, roles.body);
  assert.equal(roles.json().skill.enabled, true);
  assert.deepEqual(roles.json().skill.roles, ['reviewer']);
  assert.deepEqual(calls.find((c) => c.op === 'setSkillState'), { op: 'setSkillState', id: 'pdf-tools', enabled: true, roles: ['reviewer'] });

  const off = await a.inject({ method: 'PATCH', url: '/api/skills/pdf-tools', payload: { enabled: false } });
  assert.equal(off.json().skill.enabled, false);
  assert.deepEqual(off.json().skill.roles, ['reviewer']);

  assert.equal((await a.inject({ method: 'PATCH', url: '/api/skills/pdf-tools', payload: { roles: ['boss'] } })).statusCode, 400);
  assert.equal((await a.inject({ method: 'PATCH', url: '/api/skills/pdf-tools', payload: { enabled: 'yes' } })).statusCode, 400);
  assert.equal((await a.inject({ method: 'PATCH', url: '/api/skills/nope', payload: { enabled: true } })).statusCode, 404);
  assert.equal((await a.inject({ method: 'PATCH', url: '/api/skills/NOT_AN_ID', payload: { enabled: true } })).statusCode, 404);
  await a.close();
});

test('POST /api/skills/:id/refresh re-reads the stored link and keeps enabled, roles and who added it', async () => {
  const { skills } = stubRegistry([stored('mine', { enabled: true, roles: ['tester'], addedBy: 'ann', commitSha: 'b'.repeat(40), sourceUrl: 'https://gitlab.com/g/p/-/tree/dev/pdf' })]);
  const { a, urls } = await app();
  const res = await a.inject({ method: 'POST', url: '/api/skills/mine/refresh' });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(urls, ['https://gitlab.com/g/p/-/tree/dev/pdf']);
  const s = skills.get('mine')!;
  assert.equal(s.commitSha, 'a'.repeat(40));
  assert.equal(s.enabled, true);
  assert.deepEqual(s.roles, ['tester']);
  assert.equal(s.addedBy, 'ann');

  assert.equal((await a.inject({ method: 'POST', url: '/api/skills/nope/refresh' })).statusCode, 404);
  await a.close();
});

test('DELETE /api/skills/:id removes a skill; unknown is 404', async () => {
  stubRegistry([stored('pdf-tools')]);
  const { a } = await app();
  assert.equal((await a.inject({ method: 'DELETE', url: '/api/skills/pdf-tools' })).statusCode, 200);
  assert.equal((await a.inject({ method: 'DELETE', url: '/api/skills/pdf-tools' })).statusCode, 404);
  assert.equal((await a.inject({ method: 'DELETE', url: '/api/skills/NOT_AN_ID' })).statusCode, 404);
  await a.close();
});

test('routes hand the saved credentials to the fetcher, for preview, add and refresh', async () => {
  stubRegistry([stored('pdf-tools')]);
  const seen: unknown[] = [];
  const a = Fastify();
  registerSkillRoutes(a, {
    credentials: async () => ({ github: 'ghp-x' }),
    fetchSkill: async (_url, opts) => { seen.push(opts?.credentials); return fetched(); },
  });
  await a.ready();
  await a.inject({ method: 'POST', url: '/api/skills/preview', payload: { url: URL_ } });
  await a.inject({ method: 'POST', url: '/api/skills', payload: { url: URL_, id: 'another' } });
  await a.inject({ method: 'POST', url: '/api/skills/pdf-tools/refresh' });
  assert.deepEqual(seen, [{ github: 'ghp-x' }, { github: 'ghp-x' }, { github: 'ghp-x' }]);
});
