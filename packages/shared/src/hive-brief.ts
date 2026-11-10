/**
 * Hive's briefing on a task (`POST /v1/brief`, #93): only the fields ASF reads. The api asks
 * for it and formats it once with formatHiveBrief; the worker puts the text in the planner's
 * and implementer's prompt.
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
