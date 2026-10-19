import type { FastifyInstance } from 'fastify';
import { ADHOC_ALLOWED_MIME, adhocBodyLimitBytes, attachmentProblem, createAdhocRequestSchema, isAdhocId, safeAttachmentName } from '@asf/shared';
import type { AdhocFileInput, AdhocLimits, ScmProvider } from '@asf/shared';
import { config } from '../config.js';
import { registry } from '../registry/client.js';
import { cfg } from '../settings.js';
import { resolveIdentity } from '../identity.js';
import { startReadiness } from '../start-readiness.js';

export function adhocLimits(): AdhocLimits {
  return { maxFiles: cfg('ADHOC_MAX_ATTACHMENTS'), maxFileMb: cfg('ADHOC_MAX_ATTACHMENT_MB') };
}

// The chat path lists the connected repositories under this heading, after what was typed.
const REPO_LIST_HEADING = '\n\nRepositories connected:\n';

/** A chat-started task's body without the repository list the chat appended: what the person typed. */
export function withoutRepoList(body: string): string {
  const at = body.lastIndexOf(REPO_LIST_HEADING);
  return at < 0 ? body : body.slice(0, at);
}

/** Sanitised, de-duplicated names: the worker writes each file to disk under this name. */
function uniqueNames(files: AdhocFileInput[]): AdhocFileInput[] {
  const seen = new Set<string>();
  return files.map((f) => {
    let name = safeAttachmentName(f.name);
    const dot = name.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    for (let n = 2; seen.has(name); n++) name = `${stem}-${n}${ext}`;
    seen.add(name);
    return { ...f, name };
  });
}

/**
 * Ad-hoc tasks (#179): work that has no tracker ticket. The browser posts a
 * title, a Markdown body and its files (base64 JSON, so no multipart
 * dependency); the registry stores them and returns an `adhoc:<id>` the
 * ordinary /dispatch screen then starts. The worker fetches the files back
 * through the secret-guarded attachments route.
 */
export function registerAdhocRoutes(app: FastifyInstance, deps: { scm: ScmProvider }): void {
  const limits = adhocLimits();

  app.addHook('onRequest', async (req, reply) => {
    if (!/^\/api\/runs\/[^/]+\/attachments\//.test(req.url)) return;
    if (req.headers['x-run-secret'] !== config.runEventSecret) {
      reply.code(401).send({ error: 'unauthorized', reason: 'missing or wrong X-Run-Secret' });
    }
  });

  app.get('/api/adhoc/limits', async () => ({ ...limits, allowedMime: ADHOC_ALLOWED_MIME }));

  // Only this route takes a big body: up to maxFiles files of maxFileMb each, base64.
  app.post('/api/adhoc', { bodyLimit: adhocBodyLimitBytes(limits) }, async (req, reply) => {
    const parsed = createAdhocRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', reason: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
    const { title, chat } = parsed.data;
    let { body } = parsed.data;
    const files = uniqueNames(parsed.data.files);
    // The declared size is the decoded size, so a lying client cannot slip a big file past the check.
    const problem = attachmentProblem(files.map((f) => ({ name: f.name, mime: f.mime, size: Buffer.byteLength(f.contentBase64, 'base64') })), limits);
    if (problem) return reply.code(400).send({ error: 'bad_attachment', reason: problem });
    // From the chat: list the connected repositories so the planner can hand a part off to one.
    // If the lookup fails the task is still created, just without the list.
    if (chat) {
      const ready = await startReadiness(deps.scm);
      if (ready.ok) body = `${body}${REPO_LIST_HEADING}${ready.repos.map((r) => `- ${r.path}`).join('\n')}`;
    }
    const { task } = await registry.createAdhoc({ title, body, createdBy: resolveIdentity(req).user || null, attachments: files });
    return reply.code(201).send({ task });
  });

  // Ad-hoc tasks not yet turned into a run — the raw material for a later "things to do" list.
  app.get('/api/adhoc', async () => {
    const { tasks } = await registry.listAdhoc();
    return { tasks };
  });

  app.delete<{ Params: { id: string } }>('/api/adhoc/:id', async (req, reply) => {
    const { ok } = await registry.deleteAdhoc(req.params.id);
    if (!ok) return reply.code(404).send({ error: 'not_found', reason: `no ad-hoc task ${req.params.id}` });
    return reply.code(204).send();
  });

  // Worker-only: one attachment of the run's ad-hoc task, as raw bytes.
  app.get<{ Params: { id: string; name: string } }>('/api/runs/:id/attachments/:name', async (req, reply) => {
    const got = await registry.getRun(req.params.id);
    if (!got) return reply.code(404).send({ error: 'not_found', reason: `no run ${req.params.id}` });
    if (!isAdhocId(got.run.ticketId)) return reply.code(404).send({ error: 'not_found', reason: 'this run has no attachments' });
    const { attachment } = await registry.getAdhocAttachment(got.run.ticketId, req.params.name);
    if (!attachment) return reply.code(404).send({ error: 'not_found', reason: `no attachment ${req.params.name}` });
    return reply.type(attachment.mime).send(Buffer.from(attachment.contentBase64, 'base64'));
  });
}
