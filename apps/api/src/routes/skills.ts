import type { FastifyInstance, FastifyReply } from 'fastify';
import { SKILL_ID_RE, skillRolesSchema } from '@asf/shared';
import type { ThirdPartySkill } from '@asf/shared';
import { registry } from '../registry/client.js';
import { resolveIdentity } from '../identity.js';
import { fetchSkill } from '../skills/fetch.js';
import type { SkillCredentials } from '../skills/fetch.js';
import { cfg } from '../settings.js';
import { resolveProviderSecret } from '../providers/secrets.js';

/**
 * Third-party skills: an operator points at a GitHub or GitLab folder holding a
 * SKILL.md; the api fetches it (pinned to a commit) and the registry stores it,
 * off until enabled for some roles. Refresh re-reads the same link.
 *
 * A private repository is read with the SCM token already saved in Settings
 * (GITHUB_TOKEN, or GITLAB_TOKEN for the GITLAB_BASE_URL host), sent only to
 * that host. The workers never fetch skills, so they never see the token.
 */

/** The saved SCM tokens, resolved now so a token changed in Settings applies at once. A bad pointer means anonymous. */
export async function savedSkillCredentials(): Promise<SkillCredentials> {
  const creds: SkillCredentials = {};
  const resolve = async (v: string) => (v ? resolveProviderSecret(v).catch(() => '') : '');
  const github = await resolve(cfg('GITHUB_TOKEN'));
  if (github) creds.github = github;
  const gitlab = await resolve(cfg('GITLAB_TOKEN'));
  let host = '';
  try { host = new URL(cfg('GITLAB_BASE_URL')).hostname.toLowerCase(); } catch { /* not a URL: no GitLab token */ }
  if (gitlab && host) creds.gitlab = { host, token: gitlab };
  return creds;
}

const bad = (reply: FastifyReply, code: number, error: string, reason: string) => reply.code(code).send({ error, reason });

/** `{ url, id? }`, or null. */
function urlBody(body: unknown): { url: string; id?: string } | null {
  const b = (body ?? {}) as { url?: unknown; id?: unknown };
  if (typeof b.url !== 'string' || !b.url.trim() || b.url.length > 2048) return null;
  if (b.id !== undefined && typeof b.id !== 'string') return null;
  return { url: b.url, id: b.id };
}

/** The list shape: everything but the file contents. */
const summary = (s: ThirdPartySkill) => ({
  ...s, files: s.files.map((f) => ({ path: f.path, size: Buffer.byteLength(f.content, 'utf8') })),
});

/** An id from a frontmatter name: no leading dashes, at most 32 characters. Null when nothing usable is left. */
export function idFromName(name: string): string | null {
  const id = name.replace(/^-+/, '').slice(0, 32);
  return SKILL_ID_RE.test(id) ? id : null;
}

/** The registry's reason when it refused with a 409 (skill_error), else null. */
const conflict = (e: unknown): string | null => /registry rpc \w+ failed: 409 (.*)$/.exec((e as Error).message)?.[1]?.trim() ?? null;

export function registerSkillRoutes(app: FastifyInstance, deps: { fetchSkill?: typeof fetchSkill; credentials?: () => Promise<SkillCredentials> } = {}): void {
  const credentials = deps.credentials ?? savedSkillCredentials;
  const fetcher = async (url: string) => (deps.fetchSkill ?? fetchSkill)(url, { credentials: await credentials() });

  /** The stored skill for a route id, or null (an id that can't exist is just unknown). */
  const find = async (id: string) => (SKILL_ID_RE.test(id) ? (await registry.getSkill(id)).skill : null);

  const save = async (reply: FastifyReply, run: () => Promise<{ skill: ThirdPartySkill }>) => {
    try {
      return (await run()).skill;
    } catch (e) {
      const reason = conflict(e);
      if (reason !== null) { bad(reply, 409, 'skill_error', reason); return null; }
      throw e;
    }
  };

  app.get('/api/skills', async () => {
    const { skills } = await registry.listSkills();
    return { skills: skills.map(summary) };
  });

  // What adding this link would store, and what it would leave out. Nothing is saved.
  app.post('/api/skills/preview', async (req, reply) => {
    const body = urlBody(req.body);
    if (!body) return bad(reply, 400, 'bad_request', 'Send { url }.');
    const got = await fetcher(body.url);
    if (!got.ok) return bad(reply, 400, 'bad_skill', got.reason);
    return { skill: got.skill, skipped: got.skipped };
  });

  app.post('/api/skills', async (req, reply) => {
    const body = urlBody(req.body);
    if (!body) return bad(reply, 400, 'bad_request', 'Send { url } and, if you like, an id.');
    const wanted = body.id?.trim();
    if (wanted !== undefined && wanted !== '' && !SKILL_ID_RE.test(wanted)) return bad(reply, 400, 'bad_request', 'Use an id of 2–32 lower-case letters, digits or dashes.');
    const got = await fetcher(body.url);
    if (!got.ok) return bad(reply, 400, 'bad_skill', got.reason);
    const id = wanted || idFromName(got.skill.name);
    if (!id) return bad(reply, 400, 'bad_request', `"${got.skill.name}" can't be used as an id. Give the skill an id of 2–32 lower-case letters, digits or dashes.`);
    if (await find(id)) return bad(reply, 409, 'skill_exists', `There is already a skill "${id}". Refresh it, or give this one another id.`);
    const skill = await save(reply, () => registry.putSkill({ ...got.skill, id, addedBy: resolveIdentity(req).user || null }));
    if (!skill) return reply;
    return reply.code(201).send({ skill: summary(skill), skipped: got.skipped });
  });

  app.patch<{ Params: { id: string } }>('/api/skills/:id', async (req, reply) => {
    const b = (req.body ?? {}) as { enabled?: unknown; roles?: unknown };
    if (b.enabled !== undefined && typeof b.enabled !== 'boolean') return bad(reply, 400, 'bad_request', 'enabled must be true or false.');
    const roles = b.roles === undefined ? undefined : skillRolesSchema.safeParse(b.roles);
    if (roles && !roles.success) return bad(reply, 400, 'bad_request', roles.error.issues[0]?.message ?? 'Send roles as a list of planner, implementer, tester, reviewer.');
    const current = await find(req.params.id);
    if (!current) return bad(reply, 404, 'not_found', `no skill ${req.params.id}`);
    const enabled = typeof b.enabled === 'boolean' ? b.enabled : current.enabled;
    const skill = await save(reply, () => registry.setSkillState(current.id, enabled, roles?.data));
    if (!skill) return reply;
    return { skill: summary(skill) };
  });

  // Re-read the stored link (same ref, so a branch moves to its newest commit). Enabled and roles stay as they are.
  app.post<{ Params: { id: string } }>('/api/skills/:id/refresh', async (req, reply) => {
    const current = await find(req.params.id);
    if (!current) return bad(reply, 404, 'not_found', `no skill ${req.params.id}`);
    const got = await fetcher(current.sourceUrl);
    if (!got.ok) return bad(reply, 400, 'bad_skill', got.reason);
    const skill = await save(reply, () => registry.putSkill({ ...got.skill, id: current.id, addedBy: current.addedBy }));
    if (!skill) return reply;
    return { skill: summary(skill), skipped: got.skipped };
  });

  app.delete<{ Params: { id: string } }>('/api/skills/:id', async (req, reply) => {
    const { id } = req.params;
    if (!SKILL_ID_RE.test(id)) return bad(reply, 404, 'not_found', `no skill ${id}`);
    const { deleted } = await registry.deleteSkill(id);
    if (!deleted) return bad(reply, 404, 'not_found', `no skill ${id}`);
    return { ok: true };
  });
}
