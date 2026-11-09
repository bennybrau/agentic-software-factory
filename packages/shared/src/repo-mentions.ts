/**
 * Which connected repositories a ticket names in its title or description, best first.
 * No AI: plain text matching, so the dispatch page can preselect the repository a
 * ticket mentions and say why. A person still confirms before anything starts.
 */

export interface MentionableRepo { id: string; path: string }
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

/** The names each repository answers to: its full path (and id, when that is a path too), and its last segment when that is unique and long enough. */
function namesFor(repos: MentionableRepo[]): Map<MentionableRepo, string[]> {
  const lastSegment = (p: string) => p.slice(p.lastIndexOf('/') + 1).toLowerCase();
  const shortCount = new Map<string, number>();
  for (const r of repos) {
    const s = lastSegment(r.path);
    shortCount.set(s, (shortCount.get(s) ?? 0) + 1);
  }
  const out = new Map<MentionableRepo, string[]>();
  for (const r of repos) {
    const names = new Set<string>();
    if (r.path) names.add(r.path.toLowerCase());
    if (r.id.includes('/')) names.add(r.id.toLowerCase());
    const s = lastSegment(r.path);
    // Two repos called `shared-ui` in different groups: the bare name could be either, so neither.
    if (s.length >= MIN_SHORT_NAME && shortCount.get(s) === 1) names.add(s);
    out.set(r, [...names].filter(Boolean));
  }
  return out;
}

function hitsIn(text: string, where: 'title' | 'body', names: Map<MentionableRepo, string[]>): Hit[] {
  const lower = text.toLowerCase();
  const hits: Hit[] = [];
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
 * segment (`shared-ui`), case-insensitively and as a whole name only. Each repo
 * appears once.
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
