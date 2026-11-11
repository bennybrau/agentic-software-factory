/**
 * Hive's briefing on a task (`POST /v1/brief`, #93): only the fields ASF reads. The api asks
 * for it and formats it once with formatHiveBrief; the worker puts the text in the planner's,
 * implementer's and reviewer's prompt.
 */
export interface HiveBriefItem { text: string; fact_ids?: string[] }
export interface HiveBriefFact { id: string; text: string; kind?: string; scope?: string; verify?: string | null }
export interface HiveBrief {
  playbook?: { title: string; scope?: string; steps?: HiveBriefItem[]; pitfalls?: HiveBriefItem[] }[];
  gotchas?: HiveBriefFact[];
  facts?: HiveBriefFact[];
  locations?: { ref?: string; path?: string }[];
  runs?: { ref?: string; title?: string | null; pr_url?: string | null }[];
  tests?: { path: string }[];
}

const ref = (id: string) => `[hive:${String(id).slice(0, 8)}]`;

function factLine(f: HiveBriefFact): string {
  const scope = f.scope ?? '';
  const label = scope.startsWith('personal:') ? 'personal' : scope;
  const note = f.verify === 'drifted' ? ', source changed since' : f.verify === 'missing' ? ', source gone' : '';
  const meta = [label, f.kind ?? ''].filter(Boolean).join(', ');
  return `- ${f.text.trim()}${meta || note ? ` (${meta}${note})` : ''} ${ref(f.id)}`;
}

const item = (s: HiveBriefItem) => `${s.text.trim()}${(s.fact_ids ?? []).map((id) => ` ${ref(id)}`).join('')}`;

/**
 * The brief as prompt text, modelled on the Hive plugin's `format_brief`: playbook (numbered
 * steps, then pitfalls), gotchas, facts, where to look, past runs, tests. Every fact line ends
 * with its `[hive:<id8>]`; playbook items carry the facts they rest on. Nothing in it = ''.
 */
export function formatHiveBrief(b: HiveBrief): string {
  const lines: string[] = [];
  for (const pb of b.playbook ?? []) {
    lines.push(`Playbook: ${pb.title}${pb.scope ? ` (${pb.scope})` : ''}`);
    if (pb.steps?.length) lines.push('Steps:', ...pb.steps.map((s, i) => `${i + 1}. ${item(s)}`));
    if (pb.pitfalls?.length) lines.push('Pitfalls:', ...pb.pitfalls.map((s) => `- ${item(s)}`));
  }
  if (b.gotchas?.length) lines.push('Gotchas:', ...b.gotchas.map(factLine));
  if (b.facts?.length) lines.push('Facts:', ...b.facts.map(factLine));
  if (b.locations?.length) lines.push(`Where to look: ${b.locations.map((l) => l.ref || l.path || '').join(', ')}`);
  if (b.runs?.length) lines.push('Past runs:', ...b.runs.map((r) => `- ${r.title || r.ref || ''}${r.pr_url ? ` (${r.pr_url})` : ''}`));
  if (b.tests?.length) lines.push(`Tests: ${b.tests.map((t) => t.path).join(', ')}`);
  return lines.join('\n');
}

/** How the plan accounted for one remembered fact (its `## Team memory` line, #108). */
export interface TeamMemoryVerdict { verdict: 'applied' | 'overridden' | 'not_applicable'; reason?: string }

const TEAM_MEMORY_HEADING = /^#{1,6}\s*team memory\s*$/i;
const TEAM_MEMORY_LINE = /^[-*]?\s*\[hive:([0-9a-z]+)\]\s*(.*)$/i;
// The verdict closes the line, after a `:` or a spaced dash (a dash inside a word, as in
// "Things-to-do", is not a separator). An override's reason runs to the end of the line.
const SEP = String.raw`(?::|\s[-–—]|[–—])`;
const VERDICT = new RegExp(String.raw`${SEP}\s*(?:(overridden)(?:\s*${SEP}?\s*(.*))?|(applied|does(?:n['’]t| not) apply(?: here)?)\.?)\s*$`, 'i');

/**
 * The plan's `## Team memory` section as id8 → verdict: `- [hive:<id8>] <fact>: applied`,
 * `: overridden: <reason>` or `: doesn't apply here`. Only lines under that heading (up to the
 * next heading or `Change-Type:`); a malformed line is skipped, and with `knownIds` (the brief's
 * fact ids, compared on their first 8 characters) a tag the brief didn't carry is dropped.
 * Never throws: anything unexpected = {}.
 */
export function parseTeamMemory(plan: string, knownIds?: Iterable<string>): Record<string, TeamMemoryVerdict> {
  try {
    const known = knownIds ? new Set([...knownIds].map((id) => String(id).slice(0, 8).toLowerCase())) : null;
    const out: Record<string, TeamMemoryVerdict> = {};
    let inSection = false;
    for (const raw of plan.split(/\r?\n/)) {
      const line = raw.trim();
      if (TEAM_MEMORY_HEADING.test(line)) { inSection = true; continue; }
      if (!inSection) continue;
      if (/^#/.test(line) || /^change-type:/i.test(line)) break;
      const tag = TEAM_MEMORY_LINE.exec(line);
      if (!tag) continue;
      const id = tag[1].slice(0, 8).toLowerCase();
      if (known && !known.has(id)) continue;
      const v = VERDICT.exec(tag[2]);
      if (!v) continue;
      if (v[1]) {
        const reason = (v[2] ?? '').trim();
        out[id] = reason ? { verdict: 'overridden', reason } : { verdict: 'overridden' };
      } else {
        out[id] = { verdict: /^applied$/i.test(v[3]) ? 'applied' : 'not_applicable' };
      }
    }
    return out;
  } catch {
    return {};
  }
}
