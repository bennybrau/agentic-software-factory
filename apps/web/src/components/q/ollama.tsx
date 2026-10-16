import { useState } from 'react';
import { OLLAMA_MIN_CONTEXT, type OllamaCheck, type OllamaModel, type OllamaModelsResult, type OllamaSource } from '@asf/shared/ui';
import { api } from '../../api';

/**
 * The Ollama question's two halves (M11 WP5; docs/M11_OLLAMA.md §Settings UI): a local
 * server and Ollama Cloud. Each lists the models the api can see; ticking one runs the
 * api's check on it (tools, plan, one tiny reply, >= 64k context), and only a model that
 * passes stays ticked. Save adds the ticked models to the factory's catalogue at $0.
 */

export type RowState = { state: 'checking' } | { state: 'ok'; note: string } | { state: 'bad'; reason: string };

export interface OllamaDraft {
  /** Model ids ticked AND passed their check this session (the ones Save adds). */
  picked: Record<string, { id: string; tier: string }>;
  rows: Record<string, RowState>;
}
export const emptyOllamaDraft = (): OllamaDraft => ({ picked: {}, rows: {} });

const gb = (b: number | null) => (b ? `${(b / 1e9).toFixed(b >= 1e10 ? 0 : 1)} GB` : '');
const k = (n: number | null) => (n ? `${Math.round(n / 1000)}k context` : 'context unknown');

/** The note shown beside a model in the list, before any check. */
export function modelNote(m: OllamaModel): { text: string; warn: boolean } {
  if (!m.tools) return { text: 'can’t call tools, so it can’t do a job', warn: true };
  const bits = [m.paramsB ? `${m.paramsB}B` : '', gb(m.sizeBytes), k(m.maxContext)].filter(Boolean).join(' · ');
  if (m.maxContext !== null && m.maxContext < OLLAMA_MIN_CONTEXT) return { text: `${bits} · too small: jobs need ${OLLAMA_MIN_CONTEXT / 1000}k`, warn: true };
  return { text: bits, warn: false };
}

/** A check's answer as the row shows it. */
export function checkRow(c: OllamaCheck): RowState {
  if (!c.ok) return { state: 'bad', reason: c.reason };
  const ctx = c.effectiveContext ? `${Math.round(c.effectiveContext / 1000)}k context` : 'context not reported';
  return { state: 'ok', note: `works · ${ctx}` };
}

export function OllamaModels({ source, inCatalogue, draft, setDraft, beforeList }: {
  source: OllamaSource;
  /** Ids already in the factory's catalogue (shown ticked, not re-checked). */
  inCatalogue: string[];
  draft: OllamaDraft;
  setDraft: (f: (d: OllamaDraft) => OllamaDraft) => void;
  /** Save the URL / key on screen first, so the list is for what's typed. False = stop. */
  beforeList: () => Promise<boolean>;
}) {
  const [list, setList] = useState<OllamaModelsResult | { ok: 'busy' } | null>(null);
  const find = async () => {
    if (!(await beforeList())) return;
    setList({ ok: 'busy' });
    setList(await api.ollamaModels(source).catch((e) => ({ ok: false as const, source, code: 'other' as const, reason: String(e) })));
  };
  const toggle = async (m: OllamaModel) => {
    if (draft.picked[m.id]) {
      setDraft((d) => { const { [m.id]: _, ...picked } = d.picked; return { ...d, picked }; });
      return;
    }
    setDraft((d) => ({ ...d, rows: { ...d.rows, [m.id]: { state: 'checking' } } }));
    const r = await api.ollamaCheck(source, m.name).catch((e) => ({ status: 0, body: { reason: String(e) } as OllamaCheck & { reason?: string } }));
    const row: RowState = r.status === 200 ? checkRow(r.body) : { state: 'bad', reason: (r.body as { reason?: string }).reason ?? `The check failed (${r.status}).` };
    setDraft((d) => ({
      rows: { ...d.rows, [m.id]: row },
      picked: row.state === 'ok' ? { ...d.picked, [m.id]: { id: m.id, tier: m.tier } } : d.picked,
    }));
  };
  const label = source === 'cloud' ? 'Find my Cloud models' : 'Find models on this server';
  return (
    <div className="ollama-models">
      <div className="row" style={{ marginTop: 10, flexWrap: 'wrap', gap: 10 }}>
        <button type="button" className="btn ghost sm" onClick={() => { void find(); }} disabled={list?.ok === 'busy'}>{label}</button>
        {list?.ok === 'busy' && <span className="spinner" />}
        {list && list.ok === false && <span className="bad">✗ {list.reason}</span>}
      </div>
      {list && list.ok === true && (list.models.length === 0
        ? <p className="muted small">{source === 'cloud' ? 'Ollama Cloud listed no models for this key.' : <>No models on this server yet. Pull one there, e.g. <span className="mono">ollama pull qwen3-coder</span>, then look again.</>}</p>
        : (
          <ul className="plain" style={{ listStyle: 'none', paddingLeft: 0, margin: '8px 0' }}>
            {list.models.map((m) => {
              const have = inCatalogue.includes(m.id);
              const row = draft.rows[m.id];
              const note = modelNote(m);
              return (
                <li key={m.id}>
                  <label style={{ display: 'flex', gap: 8, alignItems: 'baseline', opacity: m.tools ? 1 : 0.6 }}>
                    <input type="checkbox" disabled={have || !m.tools || row?.state === 'checking'} checked={have || !!draft.picked[m.id]} onChange={() => { void toggle(m); }} />
                    <span className="mono">{m.name}</span>
                    {have && <span className="muted small">already added</span>}
                    {!have && !row && <span className={note.warn ? 'warn small' : 'muted small'}>{note.text}</span>}
                    {row?.state === 'checking' && <><span className="spinner" /><span className="muted small">checking{source === 'local' ? ' (a model that isn’t loaded can take a minute)' : ''}…</span></>}
                    {row?.state === 'ok' && <span className="ok small">✓ {row.note}</span>}
                    {row?.state === 'bad' && <span className="bad small">✗ {row.reason}</span>}
                  </label>
                </li>
              );
            })}
          </ul>
        ))}
    </div>
  );
}
