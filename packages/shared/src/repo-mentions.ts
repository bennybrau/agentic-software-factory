/**
 * Which connected repositories a ticket names in its title or description, best first.
 * No AI: plain text matching, so the dispatch page can preselect the repository a
 * ticket mentions and say why. A person still confirms before anything starts.
 */

import { isAdhocId, withoutRepoList } from './adhoc.js';

/** `url` (the provider web URL) and `connection` (the SCM connection) tell same-path repos on different hosts apart. */
export interface MentionableRepo { id: string; path: string; url?: string; connection?: string }
export interface RepoMention { id: string; path: string; where: 'title' | 'body'; /** The name as it is matched (the full path or the last segment), lower case. */ name: string }

/** Characters that can be part of a repository name. A '.' is too, except at the end (sentence punctuation). */
const NAME_CHAR = /[a-z0-9_.-]/i;
const NAME_CHAR_NO_DOT = /[a-z0-9_-]/i;
/** Shorter last segments (`web`, `api`, `ui`) are too common as words to count on their own. */
export const MIN_SHORT_NAME = 4;

interface Hit { repo: MentionableRepo; name: string; where: 'title' | 'body'; start: number; end: number }

/** Is `text[start, end)` a whole name: not glued to other name characters on either side? */
function wholeToken(text: string, start: number, end: number): boolean {
  const before = text[start - 1];
  if (before !== undefined && NAME_CHAR.test(before)) return false;
  const after = text[end];
  if (after === undefined || !NAME_CHAR.test(after)) return true;
  if (after !== '.') return false;
  // A '.' ends a sentence (or precedes `.git` in a clone URL); `shared-ui.v2` is another name.
  const rest = text.slice(end);
  if (/^\.git(?![a-z0-9_.-])/i.test(rest)) return true;
  const next = text[end + 1];
  return next === undefined || !NAME_CHAR_NO_DOT.test(next);
}

/**
 * The names each repository answers to: its full path (and id, when that is a path too), and
 * its last segment when that is unique and long enough. A path that repos on two or more
 * connections share (`acme/web` on GitHub and on GitLab) names neither; their qualified ids
 * (`github:acme/web`) and URLs still do.
 */
function namesFor(repos: MentionableRepo[]): Map<MentionableRepo, string[]> {
  const lastSegment = (p: string) => p.slice(p.lastIndexOf('/') + 1).toLowerCase();
  const shortCount = new Map<string, number>();
  const connections = new Map<string, Set<string>>();
  for (const r of repos) {
    const s = lastSegment(r.path);
    shortCount.set(s, (shortCount.get(s) ?? 0) + 1);
    const p = r.path.toLowerCase();
    // Repos without a connection count as one: a one-connection install behaves as before.
    connections.set(p, (connections.get(p) ?? new Set()).add(r.connection ?? ''));
  }
  const out = new Map<MentionableRepo, string[]>();
  for (const r of repos) {
    const names = new Set<string>();
    const path = r.path.toLowerCase();
    const onSeveralHosts = (connections.get(path)?.size ?? 0) > 1;
    if (path && !onSeveralHosts) names.add(path);
    const id = r.id.toLowerCase();
    if (id.includes('/') && !(onSeveralHosts && id === path)) names.add(id);
    const s = lastSegment(r.path);
    // Two repos called `shared-ui` in different groups (or hosts): the bare name could be either, so neither.
    if (s.length >= MIN_SHORT_NAME && shortCount.get(s) === 1 && !onSeveralHosts) names.add(s);
    out.set(r, [...names].filter(Boolean));
  }
  return out;
}

/** A repo URL's host and path (no trailing slash), lower case; null when it doesn't parse. */
function hostAndPath(url: string | undefined): { host: string; path: string } | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return { host: u.host.toLowerCase(), path: u.pathname.replace(/\/+$/, '').toLowerCase() };
  } catch {
    return null;
  }
}

/**
 * `https://host/…` links to a repository: same host as the repo's URL, and a path that is the
 * repo's or continues past it (`/-/issues/3`, `/tree/main`, `.git`). The longest repo path wins.
 */
function urlHitsIn(text: string, where: 'title' | 'body', repos: MentionableRepo[]): Hit[] {
  const targets = repos.flatMap((repo) => {
    const at = hostAndPath(repo.url);
    return at && at.path ? [{ repo, ...at }] : [];
  });
  if (!targets.length) return [];
  const hits: Hit[] = [];
  for (const m of text.matchAll(/https?:\/\/[^\s<>()[\]{}"'`]+/gi)) {
    const token = m[0].replace(/[.,;:!?]+$/, '');
    const at = hostAndPath(token);
    if (!at) continue;
    let best: (typeof targets)[number] | undefined;
    for (const t of targets) {
      if (t.host !== at.host || !at.path.startsWith(t.path)) continue;
      if (!/^(?:$|\/|\.git(?:\/|$))/.test(at.path.slice(t.path.length))) continue;
      if (!best || t.path.length > best.path.length) best = t;
    }
    if (best) hits.push({ repo: best.repo, name: best.repo.path.toLowerCase(), where, start: m.index, end: m.index + token.length });
  }
  return hits;
}

function hitsIn(text: string, where: 'title' | 'body', names: Map<MentionableRepo, string[]>): Hit[] {
  const lower = text.toLowerCase();
  const hits: Hit[] = urlHitsIn(text, where, [...names.keys()]);
  for (const [repo, list] of names) {
    for (const name of list) {
      for (let at = lower.indexOf(name); at >= 0; at = lower.indexOf(name, at + 1)) {
        if (wholeToken(lower, at, at + name.length)) hits.push({ repo, name, where, start: at, end: at + name.length });
      }
    }
  }
  // `acme/platform` inside `acme/platform/web/shared-ui` names the longer repo, not both.
  return hits.filter((h) => !hits.some((o) => o.repo !== h.repo && o.start <= h.start && o.end >= h.end && o.end - o.start > h.end - h.start));
}

/**
 * The repositories `text` names, best first: title mentions before description
 * mentions, then by where the first mention is. Matches the full path
 * (`acme/platform/web/shared-ui`, also inside URLs and backticks) or the last
 * segment (`shared-ui`), case-insensitively and as a whole name only. A link to
 * the repo (`https://gitlab.example.com/acme/web/-/issues/3`) names it by host, so
 * `acme/web` on GitHub and on GitLab are told apart; the bare shared path names
 * neither. Each repo appears once.
 */
export function reposMentioned(text: { title: string; body: string }, repos: MentionableRepo[]): RepoMention[] {
  if (!repos.length) return [];
  const names = namesFor(repos);
  const hits = [...hitsIn(text.title ?? '', 'title', names), ...hitsIn(text.body ?? '', 'body', names)];
  hits.sort((a, b) => (a.where === b.where ? 0 : a.where === 'title' ? -1 : 1) || a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const seen = new Set<string>();
  const out: RepoMention[] = [];
  for (const h of hits) {
    if (seen.has(h.repo.id)) continue;
    seen.add(h.repo.id);
    out.push({ id: h.repo.id, path: h.repo.path, where: h.where, name: h.name });
  }
  return out;
}

/**
 * The repositories a ticket names, as reposMentioned, reading what a person wrote: an older
 * chat task's body ends with the connected-repository list an api appended, and every repo
 * on that list would otherwise count as named.
 */
export function ticketReposMentioned(ticket: { id: string; title?: string | null; body?: string | null }, repos: MentionableRepo[]): RepoMention[] {
  const body = isAdhocId(ticket.id) ? withoutRepoList(ticket.body ?? '') : (ticket.body ?? '');
  return reposMentioned({ title: ticket.title ?? '', body }, repos);
}
