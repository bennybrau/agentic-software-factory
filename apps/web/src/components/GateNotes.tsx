import type { GateWire } from '@asf/shared';
import { gateTitle } from '../words';

/** Shown under a gate note or chat message the Hive hook sent (#108). Never set while Hive is off. */
export const HIVE_SENT = 'Sent to team memory for review';

/** The notes people left when they decided a gate, oldest first. Nothing when there are none. */
export function GateNotes({ gates }: { gates: GateWire[] }) {
  const noted = gates.filter((g) => g.decidedAt && g.note?.trim() && (g.state === 'approved' || g.state === 'rejected'));
  if (!noted.length) return null;
  return (
    <div className="card">
      <b>Gate notes</b>
      {noted.map((g) => (
        <div key={g.id} style={{ marginTop: 8 }}>
          <div className="muted small">
            {gateTitle(g.gateName)} · {g.state === 'approved' ? 'Approved' : 'Rejected'} by {g.decidedBy || 'someone'}
          </div>
          <div style={{ whiteSpace: 'pre-wrap' }}>{g.note}</div>
          {g.hiveSentAt && <div className="muted small">{HIVE_SENT}</div>}
        </div>
      ))}
    </div>
  );
}
