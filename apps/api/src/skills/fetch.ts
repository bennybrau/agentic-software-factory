import {
  SKILL_ALLOWED_EXTENSIONS, SKILL_ENTRY_FILE, SKILL_MAX_FILES, SKILL_MAX_TOTAL_BYTES, SKILL_NAME_RE, skillFileSchema,
} from '@asf/shared';
import type { SkillFile } from '@asf/shared';

/**
 * Third-party skills from a GitHub or GitLab folder. Public repositories are
 * read anonymously. For a private one, the caller may pass the SCM token that
 * belongs to that exact host (`SkillCredentials`); it is sent only there and
 * never follows a redirect. The ref in the URL is pinned to the commit it names
 * right now, and only text files make it in; anything else is skipped and
 * reported so the operator sees what was left out.
 */

const TIMEOUT_MS = 10_000;
/** A ref like `release/1.2` is ambiguous with the path after it; try this many leading segments. */
const MAX_REF_SEGMENTS = 5;
/** GitLab lists the tree 100 entries a page; past this many pages the folder is far too big anyway. */
const MAX_TREE_PAGES = 20;
const DESCRIPTION_MAX = 1024;

export interface SkillLocation {
  kind: 'github' | 'gitlab';
  host: string;
  /** `owner/repo` on GitHub; `group/…/project` on GitLab. */
  project: string;
  /** The first-segment guess. A ref with slashes is found by fetchSkill. */
  ref: string;
  /** The skill folder in the repository, '' for the root. */
  path: string;
  /** The ref and path segments together, for retrying a ref with slashes. */
  segments: string[];
}

export type ParsedSkillUrl = ({ ok: true } & SkillLocation) | { ok: false; reason: string };

export interface FetchedSkill {
  name: string;
  description: string;
  sourceUrl: string;
  sourceRef: string;
  commitSha: string;
  files: SkillFile[];
}

/**
 * Tokens the fetcher may use. A token is only ever sent to its own host: `github`
 * to github.com, `gitlab.token` to `gitlab.host` (the GITLAB_BASE_URL host).
 * A link to any other host is fetched anonymously.
 */
export interface SkillCredentials {
  github?: string;
  gitlab?: { host: string; token: string };
}

export type SkillFetchResult =
  | { ok: true; skill: FetchedSkill; skipped: { path: string; reason: string }[] }
  | { ok: false; reason: string };

const refuse = (reason: string) => ({ ok: false as const, reason });

const isIpLiteral = (host: string) => host.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || /^\d+$/.test(host);

/** Where a GitHub or GitLab folder URL points, or why it can't be used. */
export function parseSkillUrl(raw: string): ParsedSkillUrl {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return refuse('That is not a URL.'); }
  if (u.protocol !== 'https:') return refuse('Use an https:// link.');
  if (u.username || u.password) return refuse('Use a link without a user name or password in it.');
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || isIpLiteral(host)) return refuse('Use a link to a public GitHub or GitLab host, not a local address.');
  let parts: string[];
  try { parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent); } catch { return refuse('The link has a broken path.'); }
  if (parts.some((p) => p === '.' || p === '..' || /[/\\]/.test(p))) return refuse('The link has a broken path.');

  let kind: SkillLocation['kind'];
  let project: string;
  let mode: string;
  let rest: string[];
  if (host === 'github.com' || host === 'www.github.com') {
    if (parts.length < 4 || (parts[2] !== 'tree' && parts[2] !== 'blob')) {
      return refuse('Use a GitHub folder link like https://github.com/owner/repo/tree/main/skills/my-skill.');
    }
    kind = 'github';
    project = `${parts[0]}/${parts[1]}`;
    mode = parts[2];
    rest = parts.slice(3);
  } else {
    const dash = parts.indexOf('-');
    if (dash < 2 || parts.length < dash + 3 || (parts[dash + 1] !== 'tree' && parts[dash + 1] !== 'blob')) {
      return refuse('Use a GitHub or GitLab folder link, like https://github.com/owner/repo/tree/main/skills/my-skill or https://gitlab.com/group/project/-/tree/main/skills/my-skill.');
    }
    kind = 'gitlab';
    project = parts.slice(0, dash).join('/');
    mode = parts[dash + 1];
    rest = parts.slice(dash + 2);
  }
  if (mode === 'blob') {
    if (rest.length < 2 || rest[rest.length - 1] !== SKILL_ENTRY_FILE) return refuse(`Link to the skill's folder or to its ${SKILL_ENTRY_FILE}, not to another file.`);
    rest = rest.slice(0, -1);
  }
  return { ok: true, kind, host: kind === 'github' ? 'github.com' : host, project, ref: rest[0], path: rest.slice(1).join('/'), segments: rest };
}

/** The bits of `key: value` frontmatter a SKILL.md needs. Nested keys are ignored; `>` and `|` blocks are read. */
export function parseFrontmatter(text: string): Record<string, string> | null {
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  if (lines[0]?.trim() !== '---') return null;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end < 0) return null;
  const out: Record<string, string> = {};
  for (let i = 1; i < end; i++) {
    const m = /^([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec(lines[i].replace(/\s+$/, ''));
    if (!m) continue;
    const key = m[1];
    const value = (m[2] ?? '').trim();
    const block = /^([>|])[+-]?\d*$/.exec(value);
    if (block) {
      const body: string[] = [];
      while (i + 1 < end && (lines[i + 1].trim() === '' || /^\s/.test(lines[i + 1]))) body.push(lines[++i]);
      const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
      const stripped = body.map((l) => l.slice(Number.isFinite(indent) ? indent : 0).replace(/\s+$/, ''));
      while (stripped.length && stripped[stripped.length - 1] === '') stripped.pop();
      out[key] = block[1] === '|'
        ? stripped.join('\n')
        : stripped.reduce((acc, l) => (l === '' ? `${acc}\n` : acc === '' || acc.endsWith('\n') ? acc + l : `${acc} ${l}`), '');
      continue;
    }
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      out[key] = value.slice(1, -1).replace(/\\(["\\n])/g, (_s, c: string) => (c === 'n' ? '\n' : c));
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      out[key] = value.slice(1, -1).replace(/''/g, "'");
    } else {
      out[key] = value.replace(/\s+#.*$/, '');
    }
  }
  return out;
}

const extension = (path: string): string => {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
};

class Refusal extends Error {}

type TreeEntry = { path: string; size: number | null };

/** One source: how to pin a ref, list a folder, and download a file. */
interface Source {
  commit(ref: string): Promise<string | null>;
  tree(sha: string, path: string): Promise<{ entries: TreeEntry[]; symlinks: string[] }>;
  raw(sha: string, path: string): Promise<Response>;
}

async function get(fetchImpl: typeof fetch, url: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new Refusal(`Could not reach ${new URL(url).host}: ${(e as Error).message}`);
  }
}

const NO_TOKEN_HINT = 'Only public repositories can be read without a token; to use a private one, set the host\u2019s access token in Settings (GITHUB_TOKEN or GITLAB_TOKEN, with read access to the repository).';

function failed(res: Response, what: string, authed = false): Refusal {
  if (authed && (res.status === 401 || res.status === 403 || res.status === 404)) {
    return new Refusal(`${what} was refused (${res.status}) even with the saved access token. Check the token is valid, has read access to the repository (read_repository on GitLab), and that the link is right.`);
  }
  if (res.status === 403 || res.status === 429) return new Refusal(`${what} was refused (${res.status}); the host may be rate-limiting anonymous requests. Try again later.`);
  if (res.status === 401 || res.status === 404) return new Refusal(`${what} was not found (${res.status}). ${NO_TOKEN_HINT}`);
  return new Refusal(`${what} failed (${res.status}).`);
}

async function json<T>(res: Response, what: string): Promise<T> {
  try { return (await res.json()) as T; } catch { throw new Refusal(`${what} did not answer with JSON.`); }
}

function githubSource(loc: SkillLocation, fetchImpl: typeof fetch, token?: string): Source {
  const api = `https://api.github.com/repos/${loc.project}`;
  const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'user-agent': 'asf-skills', ...(token ? { authorization: `Bearer ${token}` } : {}) };
  // With a token, never follow a redirect: it could carry the token somewhere else.
  const init: RequestInit = token ? { headers, redirect: 'error' } : { headers };
  return {
    async commit(ref) {
      const res = await get(fetchImpl, `${api}/commits/${encodeURIComponent(ref)}`, init);
      if (res.status === 404 || res.status === 422) return null;
      if (!res.ok) throw failed(res, `Looking up ${ref} in ${loc.project}`, !!token);
      return (await json<{ sha?: string }>(res, 'GitHub')).sha ?? null;
    },
    async tree(sha, path) {
      const res = await get(fetchImpl, `${api}/git/trees/${sha}?recursive=1`, init);
      if (!res.ok) throw failed(res, `Listing ${loc.project}`, !!token);
      const body = await json<{ truncated?: boolean; tree?: { path: string; type: string; mode?: string; size?: number }[] }>(res, 'GitHub');
      if (body.truncated) throw new Refusal(`${loc.project} is too big for GitHub to list in one go. Use a smaller repository.`);
      const prefix = path ? `${path}/` : '';
      const inside = (body.tree ?? []).filter((e) => e.type === 'blob' && e.path.startsWith(prefix));
      return {
        entries: inside.filter((e) => e.mode !== '120000').map((e) => ({ path: e.path, size: e.size ?? null })),
        symlinks: inside.filter((e) => e.mode === '120000').map((e) => e.path),
      };
    },
    // Anonymous: raw.githubusercontent.com. With a token: the contents API, which accepts it for private repositories.
    raw: (sha, path) => {
      const enc = path.split('/').map(encodeURIComponent).join('/');
      if (!token) return get(fetchImpl, `https://raw.githubusercontent.com/${loc.project}/${sha}/${enc}`);
      return get(fetchImpl, `${api}/contents/${enc}?ref=${sha}`, { headers: { ...headers, accept: 'application/vnd.github.raw+json' }, redirect: 'error' });
    },
  };
}

function gitlabSource(loc: SkillLocation, fetchImpl: typeof fetch, token?: string): Source {
  const api = `https://${loc.host}/api/v4/projects/${encodeURIComponent(loc.project)}/repository`;
  // Any host can be a GitLab; don't follow it somewhere else.
  const init: RequestInit = { redirect: 'error', ...(token ? { headers: { 'private-token': token } } : {}) };
  const authed = !!token;
  return {
    async commit(ref) {
      const res = await get(fetchImpl, `${api}/commits/${encodeURIComponent(ref)}`, init);
      if (res.status === 404) return null;
      if (!res.ok) throw failed(res, `Looking up ${ref} in ${loc.project}`, authed);
      return (await json<{ id?: string }>(res, 'GitLab')).id ?? null;
    },
    async tree(sha, path) {
      const entries: TreeEntry[] = [];
      const symlinks: string[] = [];
      for (let page = 1; page <= MAX_TREE_PAGES; page++) {
        const q = new URLSearchParams({ recursive: 'true', ref: sha, path, per_page: '100', page: String(page) });
        const res = await get(fetchImpl, `${api}/tree?${q}`, init);
        if (!res.ok) throw failed(res, `Listing ${path || 'the root'} of ${loc.project}`, authed);
        const rows = await json<{ path: string; type: string; mode?: string }[]>(res, 'GitLab');
        for (const e of rows) {
          if (e.type !== 'blob') continue;
          if (e.mode === '120000') symlinks.push(e.path); else entries.push({ path: e.path, size: null });
        }
        const next = res.headers.get('x-next-page');
        if (!next || rows.length === 0) return { entries, symlinks };
      }
      throw new Refusal(`The folder has more than ${MAX_TREE_PAGES * 100} files. A skill can have at most ${SKILL_MAX_FILES}.`);
    },
    raw: (sha, path) => get(fetchImpl, `${api}/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(sha)}`, init),
  };
}

/** The body as bytes, stopping as soon as it passes `limit`. */
async function readCapped(res: Response, limit: number): Promise<Uint8Array | null> {
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const chunks: Uint8Array[] = [];
  let n = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > limit) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

const tooBig = () => new Refusal(`The skill is bigger than ${SKILL_MAX_TOTAL_BYTES / 1024} KB of text files.`);

/** The token that belongs to this link's host, or undefined (anonymous). */
export function tokenFor(loc: SkillLocation, creds: SkillCredentials | undefined): string | undefined {
  if (!creds) return undefined;
  if (loc.kind === 'github') return creds.github?.trim() || undefined;
  const g = creds.gitlab;
  return g?.token.trim() && g.host.toLowerCase() === loc.host ? g.token.trim() : undefined;
}

/** Fetch a skill folder from a GitHub or GitLab repository, pinned to the commit its ref names now. Private ones need `opts.credentials`. */
export async function fetchSkill(url: string, opts: { fetch?: typeof fetch; credentials?: SkillCredentials } = {}): Promise<SkillFetchResult> {
  const loc = parseSkillUrl(url);
  if (!loc.ok) return loc;
  const fetchImpl = opts.fetch ?? fetch;
  const token = tokenFor(loc, opts.credentials);
  const source = loc.kind === 'github' ? githubSource(loc, fetchImpl, token) : gitlabSource(loc, fetchImpl, token);
  try {
    let pinned: { ref: string; path: string; sha: string } | null = null;
    for (let k = 1; k <= Math.min(MAX_REF_SEGMENTS, loc.segments.length); k++) {
      const ref = loc.segments.slice(0, k).join('/');
      const sha = await source.commit(ref);
      if (sha) { pinned = { ref, path: loc.segments.slice(k).join('/'), sha }; break; }
    }
    if (!pinned) return refuse(`Could not find ${loc.ref} in ${loc.project}. Check the link. ${token ? 'The saved access token could not see it.' : NO_TOKEN_HINT}`);
    const { ref, path, sha } = pinned;
    if (!/^[0-9a-f]{7,64}$/i.test(sha)) return refuse(`${loc.host} answered with an odd commit id for ${ref}.`);

    const { entries, symlinks } = await source.tree(sha, path);
    const prefix = path ? `${path}/` : '';
    const skipped: { path: string; reason: string }[] = symlinks.map((p) => ({ path: p.slice(prefix.length), reason: 'symbolic links are not copied' }));
    const wanted: TreeEntry[] = [];
    for (const e of entries) {
      const rel = e.path.slice(prefix.length);
      if (!(SKILL_ALLOWED_EXTENSIONS as readonly string[]).includes(extension(rel))) {
        skipped.push({ path: rel, reason: `only ${SKILL_ALLOWED_EXTENSIONS.join(', ')} files are copied` });
        continue;
      }
      const ok = skillFileSchema.shape.path.safeParse(rel);
      if (!ok.success) { skipped.push({ path: rel, reason: ok.error.issues[0]?.message ?? 'bad path' }); continue; }
      wanted.push({ path: rel, size: e.size });
    }
    if (!wanted.some((e) => e.path === SKILL_ENTRY_FILE)) return refuse(`There is no ${SKILL_ENTRY_FILE} in ${path || 'the root'} of ${loc.project} at ${ref}.`);
    if (wanted.length > SKILL_MAX_FILES) return refuse(`The skill has ${wanted.length} text files; at most ${SKILL_MAX_FILES} are allowed.`);
    if (wanted.reduce((n, e) => n + (e.size ?? 0), 0) > SKILL_MAX_TOTAL_BYTES) throw tooBig();

    const files: SkillFile[] = [];
    let total = 0;
    const utf8 = new TextDecoder('utf-8', { fatal: true });
    for (const e of wanted.sort((a, b) => a.path.localeCompare(b.path))) {
      const res = await source.raw(sha, prefix + e.path);
      if (!res.ok) throw failed(res, `Downloading ${e.path}`, !!token);
      const bytes = await readCapped(res, SKILL_MAX_TOTAL_BYTES - total);
      if (!bytes) throw tooBig();
      total += bytes.length;
      let content: string;
      try { content = utf8.decode(bytes); } catch { skipped.push({ path: e.path, reason: 'not UTF-8 text' }); continue; }
      if (content.includes('\0')) { skipped.push({ path: e.path, reason: 'not text (contains a NUL byte)' }); continue; }
      files.push({ path: e.path, content });
    }

    const entry = files.find((f) => f.path === SKILL_ENTRY_FILE);
    if (!entry) return refuse(`${SKILL_ENTRY_FILE} is not UTF-8 text.`);
    const fm = parseFrontmatter(entry.content);
    if (!fm) return refuse(`${SKILL_ENTRY_FILE} must start with --- frontmatter holding a name and a description.`);
    const name = (fm.name ?? '').trim();
    const description = (fm.description ?? '').trim();
    if (!name) return refuse(`${SKILL_ENTRY_FILE} has no name in its frontmatter.`);
    if (!SKILL_NAME_RE.test(name)) return refuse(`The name "${name.slice(0, 80)}" in ${SKILL_ENTRY_FILE} must be 1–64 lower-case letters, digits or hyphens.`);
    if (!description) return refuse(`${SKILL_ENTRY_FILE} has no description in its frontmatter.`);
    if (description.length > DESCRIPTION_MAX) return refuse(`The description in ${SKILL_ENTRY_FILE} is longer than ${DESCRIPTION_MAX} characters.`);

    return { ok: true, skill: { name, description, sourceUrl: url.trim(), sourceRef: ref, commitSha: sha, files }, skipped };
  } catch (e) {
    if (e instanceof Refusal) return refuse(e.message);
    throw e;
  }
}
