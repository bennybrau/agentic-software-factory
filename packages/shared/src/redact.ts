/**
 * Mask secrets in free text before it is stored or shown: tool summaries (a Bash
 * command line), git error messages. Best effort — it catches the shapes an agent
 * or a failed command actually produces, and keeps enough (the URL host, a token's
 * prefix, the variable name) to tell what was there.
 */

/** Longest tool summary the api stores (applied after redaction). */
export const TOOL_SUMMARY_MAX = 160;

const SECRET_NAME = /TOKEN|SECRET|PASSW(OR)?D|API_?KEY/i;

// A flag or header name whose last -/_ segment(s) are a secret word: matched on
// segments, so --access-token and X-Api-Key match but --tokenizer and --max-tokens don't.
const SECRET_WORD = String.raw`(?:[A-Za-z0-9]+[-_])*(?:token|secret|passw(?:or)?d|api[-_]?key)(?![A-Za-z0-9_-])`;
const HEADER = String.raw`(?:${SECRET_WORD}:[ \t]*|Authorization:[ \t]*(?:[A-Za-z]+[ \t]+)?)`;
// --token v, --password=v, --auth "a b": the value is masked whole, quotes kept; a
// following --flag is not a value.
const SECRET_FLAG = new RegExp(String.raw`(--(?:${SECRET_WORD}|auth(?![A-Za-z0-9_-]))(?:\s+|=))("[^"]*"|'[^']*'|(?!--)[^\s'"]+)`, 'gi');
// curl -u user:pass, --user user:pass, --user=user:pass: the user is kept.
const USER_PASS = /(^|\s)(-u\s+|--user(?:\s+|=))(?:(["'])([^"':]*):(?:(?!\3).)+\3|([^\s'":]*):[^\s'"]+)/g;
// A header inside quotes ("X-Api-Key: v w"): its value runs to the closing quote.
// Authorization keeps its scheme (Basic, token, Bearer, ...).
const QUOTED_HEADER = new RegExp(String.raw`(["'])(${HEADER})(?:(?!\1).)+(?=\1)`, 'gi');
const BARE_HEADER = new RegExp(String.raw`(^|\s)(${HEADER})[^\s'"]+`, 'gi');
const MASKED = /^(["']?)\*\*\*\1$/;

export function redactSecrets(text: string): string {
  return text
    // user:token@ in any URL.
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, '$1***@')
    // Authorization: Bearer <token>
    .replace(/\b(Bearer\s+)[^\s'"]+/gi, '$1***')
    .replace(USER_PASS, (_m, pre: string, flag: string, q: string | undefined, quotedUser: string, bareUser: string) =>
      q ? `${pre}${flag}${q}${quotedUser}:***${q}` : `${pre}${flag}${bareUser}:***`)
    .replace(SECRET_FLAG, (_m, flag: string, value: string) =>
      value[0] === '"' || value[0] === "'" ? `${flag}${value[0]}***${value[0]}` : `${flag}***`)
    .replace(QUOTED_HEADER, '$1$2***')
    .replace(BARE_HEADER, '$1$2***')
    // NAME=value where NAME looks like a secret; the value may be quoted. One a rule
    // above already masked (--token="***") is left as it is.
    .replace(/\b([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s'"]+)/g, (m, name: string, value: string) =>
      SECRET_NAME.test(name) && !MASKED.test(value) ? `${name}=***` : m)
    // Known token shapes, prefix kept.
    .replace(/\b(github_pat_|gh[pousr]_|glpat-|sk-ant-|sk-|xox[bpas]-)[A-Za-z0-9_-]{8,}/g, '$1***')
    .replace(/\bAKIA[A-Z0-9]{12,}\b/g, 'AKIA***');
}
