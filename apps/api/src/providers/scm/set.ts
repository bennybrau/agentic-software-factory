import { formatRef, parseRef } from '@asf/shared';
import type { ChangeRequest, Repo, ScmProvider } from '@asf/shared';

/**
 * The SCM provider with qualified repository ids at the seam (M12, see refs.ts).
 * `getRepo` accepts a bare (pre-M12) or qualified id or a path; every Repo handed
 * back carries its connection and a qualified id, and every Repo handed in is
 * passed on with its native id, so the provider never sees a prefix. `kind` is
 * read through on every access, so this wraps a registry's `live` proxy safely.
 */
export function qualifyScm(provider: ScmProvider): ScmProvider {
  const kind = () => provider.kind;
  const native = (ref: string) => parseRef(ref, kind()).native;
  const qualify = (r: Repo): Repo => ({ ...r, connection: kind(), id: formatRef(kind(), r.id) });
  const unqualify = (r: Repo): Repo => ({ ...r, id: native(r.id) });
  const qualifyCr = <T extends ChangeRequest>(cr: T): T => ({ ...cr, repoId: formatRef(kind(), cr.repoId) });
  const wrapped: Omit<ScmProvider, 'kind'> = {
    preflight: () => provider.preflight(),
    searchRepos: async (q) => (await provider.searchRepos(q)).map(qualify),
    getRepo: async (idOrPath) => qualify(await provider.getRepo(native(idOrPath))),
    cloneCredential: (repo) => provider.cloneCredential(unqualify(repo)),
    openChangeRequest: async (repo, input) => qualifyCr(await provider.openChangeRequest(unqualify(repo), input)),
    listChangeRequests: async (repo, q) => (await provider.listChangeRequests(unqualify(repo), q)).map(qualifyCr),
    getChangeRequest: async (repo, number) => qualifyCr(await provider.getChangeRequest(unqualify(repo), number)),
    listReviewComments: (repo, number) => provider.listReviewComments(unqualify(repo), number),
    replyToThread: (repo, number, threadId, body) => provider.replyToThread(unqualify(repo), number, threadId, body),
    comment: (repo, number, body, anchor) => provider.comment(unqualify(repo), number, body, anchor),
    markReady: (repo, number) => provider.markReady(unqualify(repo), number),
    merge: (repo, number, opts) => provider.merge(unqualify(repo), number, opts),
    ...(provider.changedFiles ? { changedFiles: (repo: Repo, number: number, limit: number) => provider.changedFiles!(unqualify(repo), number, limit) } : {}),
  };
  Object.defineProperty(wrapped, 'kind', { get: kind, enumerable: true });
  return wrapped as ScmProvider;
}
