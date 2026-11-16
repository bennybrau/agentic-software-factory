import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { SettingView } from '@asf/shared';
import { api } from '../../api';

/**
 * Building blocks for the plain-language settings questions (the /setup wizard
 * and /settings). The UI is for non-engineers: it never shows a setting's key.
 * The only place a key appears is the ⓘ tooltip (<Tip>), which tells an engineer
 * what to put in `.env` instead. A non-empty env value pins a key (env > org), so
 * its field renders locked as "set by your admin".
 */

export type ByKey = Record<string, SettingView>;

export interface SettingsStore {
  byKey: ByKey;
  loaded: boolean;
  err: string | null;
  /**
   * Write several keys in order; `null` reverts a key to its default. Stops at the
   * first rejection and returns its reason (or null on success).
   */
  saveMany: (entries: [string, unknown][]) => Promise<string | null>;
  reload: () => void;
}

export function useSettingsStore(): SettingsStore {
  const [settings, setSettings] = useState<SettingView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const reload = useCallback(() => {
    api.settings().then((d) => { setSettings(d.settings); setLoaded(true); setErr(null); }).catch((e) => setErr(String(e)));
  }, []);
  useEffect(() => { reload(); }, [reload]);
  const byKey = useMemo(() => Object.fromEntries(settings.map((s) => [s.key, s])), [settings]);

  const saveMany = useCallback(async (entries: [string, unknown][]): Promise<string | null> => {
    for (const [key, value] of entries) {
      if (value === null) {
        const d = await api.deleteSetting(key).catch((e) => { return { error: String(e) } as const; });
        if ('error' in d) return d.error;
        setSettings(d.settings);
        continue;
      }
      const { status, body } = await api.putSetting(key, value);
      if (status !== 200 || !body.settings) return body.reason || `Couldn't save (${status}).`;
      setSettings(body.settings);
    }
    return null;
  }, []);

  return { byKey, loaded, err, saveMany, reload };
}

/** A secret counts as present when stored in the UI (redacted, non-null) or pinned by env. */
export const secretIsSet = (s?: SettingView) => !!s && (s.orgValue != null || s.envPinned);
/** Never answered: no org value and not pinned by env. Only these get first-run suggestions,
 *  so re-running setup always starts from the operator's real answers. */
export const unanswered = (s?: SettingView) => !s || (s.orgValue == null && !s.envPinned);
export const str = (s?: SettingView) => (s?.value == null ? '' : String(s.value));

/** Credential health (#139): the saved token stopped working, or expires within 30 days. */
export const needsFix = (s?: SettingView) => !!s?.health && (!s.health.ok || !!s.health.expiresAt);

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

/** A token's health in plain words ("Your GitHub token stopped working on 3 Sep…"), or null when it's fine. */
export function HealthNote({ s, name }: { s?: SettingView; name: string }) {
  const h = s?.health;
  if (!h || !needsFix(s)) return null;
  let text: string;
  if (!h.ok) text = `Your ${name} stopped working${h.since ? ` on ${day(h.since)}` : ''}. Paste a new one to fix it.`;
  else if (Date.parse(h.expiresAt!) <= Date.now()) text = `Your ${name} expired on ${day(h.expiresAt!)}. Make a new one and paste it here.`;
  else text = `Your ${name} expires on ${day(h.expiresAt!)}. Make a new one before then and paste it here.`;
  return <span className="warn" style={{ display: 'block' }}>⚠ {text}</span>;
}

/** ⓘ — the engineer's view of a question: which `.env` keys answer it. */
export function Tip({ keys, byKey, note }: { keys: string[]; byKey: ByKey; note?: string }) {
  // Only env-tier keys can go in .env; org-only ones (PIPELINE_STAGES) are set in the UI on purpose.
  const envable = keys.filter((k) => byKey[k]?.tiers.includes('env'));
  const lines = envable.map((k) => {
    const s = byKey[k];
    const v = s.secret ? (secretIsSet(s) ? '…' : '') : s.type === 'json' ? '' : str(s);
    return `${k}=${v.length > 60 ? `${v.slice(0, 57)}…` : v}`;
  });
  const pinned = keys.filter((k) => byKey[k]?.envPinned);
  return (
    <span className="tip" onClick={(e) => e.stopPropagation()}>
      <button type="button" aria-label="Where this is configured">i</button>
      <span className="pop" role="tooltip">
        <span className="h">{lines.length > 0 ? 'For engineers: set in .env' : 'For engineers'}</span>
        {lines.length > 0 && <code>{lines.join('\n')}</code>}
        {note && <span className="note">{note}</span>}
        <span className="note">
          {pinned.length > 0
            ? ` Currently set in .env: ${pinned.join(', ')}. The .env value wins, so this is read-only here.`
            : lines.length > 0 ? ' A value in .env wins over this page and locks it here.' : ''}
        </span>
      </span>
    </span>
  );
}

export interface ChoiceOpt<V extends string> { v: V; title: string; sub?: string; disabled?: boolean; badge?: string }

export function Choices<V extends string>({ opts, value, onPick, column, disabled }: {
  opts: ChoiceOpt<V>[]; value: V | null; onPick: (v: V) => void; column?: boolean; disabled?: boolean;
}) {
  return (
    <div className={`choices${column ? ' column' : ''}`} role="radiogroup">
      {opts.map((o) => (
        <button key={o.v} type="button" role="radio" aria-checked={o.v === value}
          className={`choice${o.v === value ? ' on' : ''}`} disabled={disabled || o.disabled}
          onClick={() => onPick(o.v)}>
          <b>{o.title}{o.badge && <em className="badge">{o.badge}</em>}</b>
          {o.sub && <span>{o.sub}</span>}
        </button>
      ))}
    </div>
  );
}

/**
 * Several connections (M12 WP4b): tick any number of chips. The first chosen is
 * the default; with more than one, it carries a "Default" badge and the others a
 * "Make default" button.
 */
export function ConnectionChips({ opts, value, onToggle, onMakeDefault, disabled }: {
  opts: ChoiceOpt<string>[]; value: string[]; onToggle: (v: string) => void; onMakeDefault: (v: string) => void; disabled?: boolean;
}) {
  return (
    <div className="conn-chips" role="group">
      {opts.map((o) => {
        const on = value.includes(o.v);
        return (
          <div key={o.v} className="conn-chip">
            <button type="button" role="checkbox" aria-checked={on} className={`choice${on ? ' on' : ''}`}
              disabled={disabled || o.disabled} onClick={() => onToggle(o.v)}>
              <b>{o.title}{o.badge && <em className="badge">{o.badge}</em>}</b>
              {o.sub && <span>{o.sub}</span>}
            </button>
            {on && value.length > 1 && (value[0] === o.v
              ? <em className="badge">Default</em>
              : <button type="button" className="linkish" disabled={disabled} onClick={() => onMakeDefault(o.v)}>Make default</button>)}
          </div>
        );
      })}
    </div>
  );
}

/** "Set by your admin" — shown when the key driving a question is pinned in .env. */
export function Locked({ children }: { children?: ReactNode }) {
  return <div className="locked">🔒 <span>{children ?? 'Set by your admin in the server’s configuration, so it can’t be changed here.'}</span></div>;
}

export function HowTo({ steps, open }: { steps: ReactNode[]; open?: boolean }) {
  return (
    <details className="howto" open={open}>
      <summary>How do I get this?</summary>
      <ol>{steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
    </details>
  );
}

/** A plain text/number field bound to a setting; locked when env-pinned. */
export function Field({ s, label, help, value, onChange, placeholder, type = 'text', multiline, width }: {
  s?: SettingView; label: string; help?: ReactNode; value: string; onChange: (v: string) => void;
  placeholder?: string; type?: 'text' | 'number'; multiline?: boolean; width?: number;
}) {
  const pinned = !!s?.envPinned;
  return (
    <label className="inp">
      <span className="lbl">{label}{pinned && <span className="muted"> 🔒 set by your admin</span>}</span>
      {multiline
        ? <textarea rows={5} value={pinned ? str(s) : value} disabled={pinned} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
        : <input type={type} value={pinned ? str(s) : value} disabled={pinned} placeholder={placeholder} style={width ? { width } : undefined} onChange={(e) => onChange(e.target.value)} />}
      {help && <span className="help">{help}</span>}
    </label>
  );
}

/** A write-only secret: never pre-filled, submits only what is typed. */
export function SecretField({ s, label, value, onChange, placeholder, howTo }: {
  s?: SettingView; label: string; value: string; onChange: (v: string) => void; placeholder?: string; howTo?: ReactNode[];
}) {
  if (s?.envPinned) {
    return <label className="inp"><span className="lbl">{label}</span><Locked>Provided by your admin in the server’s configuration.</Locked></label>;
  }
  const set = secretIsSet(s);
  return (
    <label className="inp">
      <span className="lbl">{label}</span>
      <input type="password" autoComplete="off" value={value}
        placeholder={set ? '•••••••• saved. Paste a new one to replace it' : placeholder ?? 'Paste it here'}
        onChange={(e) => onChange(e.target.value)} />
      {howTo && <HowTo steps={howTo} open={!set} />}
      <span className="help">Stored securely. We never show it again.</span>
    </label>
  );
}

/** "Check it works": runs a live preflight and shows who we connected as. */
export function CheckButton({ run, save }: { run: () => Promise<{ ok: boolean; identity?: string; reason?: string; code?: string }>; save: () => Promise<boolean> }) {
  const [state, setState] = useState<'idle' | 'busy' | { ok: boolean; text: string }>('idle');
  const go = async () => {
    setState('busy');
    // Save first so the check tests what's on screen. A validation error shows by the Save button.
    if (!(await save())) return setState('idle');
    try {
      const r = await run();
      setState(r.ok ? { ok: true, text: r.identity ? `Connected as ${r.identity}` : 'Connected' } : { ok: false, text: r.code && r.reason ? r.reason : friendlyReason(r.reason) }); // a coded answer is already written for people
    } catch (e) { setState({ ok: false, text: friendlyReason(String(e)) }); }
  };
  return (
    <div className="row" style={{ marginTop: 14, flexWrap: 'wrap' }}>
      <button type="button" className="btn ghost sm" onClick={go} disabled={state === 'busy'}>Save and check it works</button>
      {state === 'busy' && <span className="spinner" />}
      {typeof state === 'object' && <span className={state.ok ? 'ok' : 'bad'}>{state.ok ? '✓' : '✗'} {state.text}</span>}
    </div>
  );
}

function friendlyReason(r?: string): string {
  if (!r) return 'That didn’t work. Double-check the details above.';
  if (/401|403|unauthori[sz]ed|forbidden|invalid/i.test(r)) return 'The token or key was rejected. Check you copied all of it and it has the right access.';
  if (/404|not found/i.test(r)) return 'We connected, but couldn’t find that. Check the address and names above.';
  if (/ENOTFOUND|ECONNREFUSED|fetch failed|network/i.test(r)) return 'We couldn’t reach it. Check the address.';
  return r;
}
