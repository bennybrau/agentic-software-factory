import { parseTeamMemory } from '@asf/shared/ui';
import type { TeamMemoryVerdict } from '@asf/shared';
import type { RunDetail } from '../api';

/** How the plan's `## Team memory` section accounted for a fact, as a label; '' when it didn't say. */
export function verdictText(v: TeamMemoryVerdict | undefined): string {
  if (!v) return '';
  if (v.verdict === 'applied') return 'Applied';
  if (v.verdict === 'not_applicable') return 'Doesn\'t apply';
  return 'Overridden';
}

/**
 * Team memory (#108): the Hive facts the agents were given for this run, each with its
 * `[hive:<id8>]` tag (a link to the fact in the Hive dashboard when HIVE_DASHBOARD_URL is
 * set) and what the plan said about it. Nothing saved = nothing shown.
 */
export function TeamMemory({ brief, planMd }: { brief: RunDetail['hiveBrief']; planMd?: string }) {
  if (!brief?.facts.length) return null;
  const verdicts = parseTeamMemory(planMd ?? '', brief.facts.map((f) => f.id));
  return (
    <div className="card">
      <b>Team memory</b>
      <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 13 }}>
        {brief.facts.map((f) => {
          const tag = `[hive:${f.id.slice(0, 8)}]`;
          const v = verdicts[f.id.slice(0, 8).toLowerCase()];
          const verdict = verdictText(v);
          return (
            <li key={f.id} style={{ marginBottom: 4 }}>
              {brief.dashboardUrl
                ? <a href={`${brief.dashboardUrl}/facts/${encodeURIComponent(f.id)}`} target="_blank" rel="noreferrer"><code>{tag}</code></a>
                : <code>{tag}</code>}
              {' '}<span className="muted">{f.kind}</span> {f.text}
              {f.scope && <span className="muted"> ({f.scope})</span>}
              {verdict && <> · <b>{verdict}</b>{v?.reason && <span className="muted">: {v.reason}</span>}</>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
