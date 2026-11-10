/**
 * Whole-key matching of a ticket key inside a change request's title or branch.
 *
 * A plain `includes` matched PROJ-12 inside "PROJ-123: …" and "agent/PROJ-123-abcd1234",
 * so a ticket could pick up another ticket's change request. A key only counts here when it
 * stands on its own: no letter or digit right before it (XPROJ-12 is not PROJ-12) and none
 * right after it (PROJ-123, and ADHOC-CE17 inside ADHOC-CE1722DF, are not matches). Anything
 * else may surround it, such as ':', ' ', ')', '_', '/' or '-', so an agent branch
 * `agent/<KEY>-<8 hex>` still matches its key. The match ignores case, so a hand-made branch
 * like `feature/proj-12-login` counts too.
 */

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** True when `key` appears in `text` as a whole key (see module doc). */
export function mentionsTicketKey(text: string, key: string): boolean {
  if (!key) return false;
  return new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(key)}(?![A-Za-z0-9])`, 'i').test(text);
}

/**
 * The form a key takes in a branch name when its non-word characters are replaced with '-'
 * (a GitHub issue key `acme/web#42` becomes `acme-web-42`).
 */
export const branchSafeKey = (key: string): string => key.replace(/[^\w-]/g, '-');

/** True when a change request's title or branch names `key` as a whole key. */
export function changeRequestMentionsKey(cr: { title: string; branch: string }, key: string): boolean {
  return mentionsTicketKey(cr.title, key)
    || mentionsTicketKey(cr.branch, key)
    || mentionsTicketKey(cr.branch, branchSafeKey(key));
}
