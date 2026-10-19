/** One review finding that names a file and line, ready to post as a line comment. */
export interface AnchoredComment { path: string; line: number; body: string }

// `- \`path:line\` — text` (also `*` bullets, and `–`, `-` or `:` as the separator).
// The path is greedy, so `a:b.ts:12` anchors at line 12 of `a:b.ts`.
const ANCHORED = /^\s*[-*]\s+`([^`]+):(\d+)`\s*(?:—|–|-|:)\s*(.*)$/;

/**
 * Split a reviewer's review.md into line comments (`path:line` bullets, with their
 * indented continuation lines) and everything else (the summary). Never throws.
 */
export function reviewComments(md: string): { summary: string; anchored: AnchoredComment[] } {
  const anchored: AnchoredComment[] = [];
  const summary: string[] = [];
  let current: AnchoredComment | null = null;
  for (const raw of String(md ?? '').split(/\r?\n/)) {
    const m = ANCHORED.exec(raw);
    const line = m ? Number(m[2]) : 0;
    if (m && m[1].trim() && line > 0) {
      current = { path: m[1].trim(), line, body: m[3].trim() };
      anchored.push(current);
    } else if (current && /^\s+\S/.test(raw)) {
      current.body = current.body ? `${current.body}\n${raw.trim()}` : raw.trim();
    } else {
      current = null;
      summary.push(raw);
    }
  }
  return { summary: summary.join('\n').trim(), anchored };
}
