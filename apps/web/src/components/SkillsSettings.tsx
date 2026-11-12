import { useEffect, useState } from 'react';
import { SKILL_ROLES } from '@asf/shared/ui';
import type { SkillRole } from '@asf/shared';
import { api, type SkillPreview, type SkillSummary, type SkippedFile } from '../api';
import { checkSkillUrl, refusal, shortSha, skillEntryText, toggleRole } from '../skills-view';

/**
 * Settings → Skills (ADHOC-75B02597 part 4/4): add a third-party SKILL.md folder
 * from GitHub or GitLab after previewing it, then turn it on for some roles.
 * SKILL.md is shown as plain text, never rendered, so nothing third-party becomes HTML.
 */
export function SkillsSettings() {
  const [skills, setSkills] = useState<SkillSummary[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const load = () => api.skills().then((r) => { setSkills(r.skills); setLoadErr(null); }, (e) => setLoadErr(String((e as Error).message ?? e)));
  useEffect(() => { void load(); }, []);

  const replace = (s: SkillSummary) => setSkills((cur) => cur?.map((x) => (x.id === s.id ? s : x)) ?? cur);
  const remove = (id: string) => setSkills((cur) => cur?.filter((x) => x.id !== id) ?? cur);

  return (
    <section className="tier" aria-labelledby="skills-head">
      <div className="tier-head"><h3 id="skills-head">Skills</h3><span className="muted">Extra instructions from GitHub or GitLab, off until you pick roles for them</span></div>
      {loadErr && <p className="bad" role="alert">Couldn’t load skills: {loadErr}</p>}
      {skills?.map((s) => <SkillRow key={s.id} skill={s} onChange={replace} onRemoved={() => remove(s.id)} />)}
      {skills?.length === 0 && <p className="muted">No skills yet.</p>}
      <AddSkill onAdded={() => void load()} />
    </section>
  );
}

function AddSkill({ onAdded }: { onAdded: () => void }) {
  const [url, setUrl] = useState('');
  const [id, setId] = useState('');
  const [preview, setPreview] = useState<{ url: string; skill: SkillPreview; skipped: SkippedFile[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const doPreview = async () => {
    setErr(null); setMsg(null); setPreview(null);
    const checked = checkSkillUrl(url);
    if (!checked.ok) { setErr(checked.reason); return; }
    setBusy(true);
    try {
      const res = await api.previewSkill(checked.url);
      if (res.status < 300 && res.body.skill) setPreview({ url: checked.url, skill: res.body.skill, skipped: res.body.skipped ?? [] });
      else setErr(refusal(res));
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };

  const add = async () => {
    if (!preview) return;
    setBusy(true); setErr(null);
    try {
      const res = await api.addSkill(preview.url, id.trim() || undefined);
      if (res.status < 300 && res.body.skill) {
        setMsg(`Added “${res.body.skill.name}”. Turn it on and pick its roles above.`);
        setPreview(null); setUrl(''); setId('');
        onAdded();
      } else setErr(refusal(res));
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };

  return (
    <div className="guided skill-add">
      <span>
        <label className="q-title" htmlFor="skill-url">Add a skill</label>
        <span className="muted">A link to a folder with a SKILL.md, like <span className="mono">https://github.com/owner/repo/tree/main/skills/my-skill</span>. Private repositories work too: ASF uses the GitHub or GitLab token saved in Settings, for that host only.</span>
        <span className="row">
          <input id="skill-url" type="url" value={url} placeholder="https://github.com/…" disabled={busy}
            onChange={(e) => { setUrl(e.target.value); setPreview(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter') void doPreview(); }} />
          <button type="button" className="btn ghost sm" disabled={busy || !url.trim()} onClick={() => void doPreview()}>{busy && !preview ? 'Fetching…' : 'Preview'}</button>
        </span>
        {err && <span className="bad" role="alert">{err}</span>}
        {msg && <span className="muted" role="status">{msg}</span>}
        {preview && (
          <span className="skill-preview">
            <span className="q-title">{preview.skill.name} <span className="muted mono">{preview.skill.sourceRef} @ {shortSha(preview.skill.commitSha)}</span></span>
            {preview.skill.description && <span className="muted">{preview.skill.description}</span>}
            <span className="muted">Files: <span className="mono">{preview.skill.files.map((f) => f.path).join(', ')}</span></span>
            {preview.skipped.length > 0 && (
              <span className="muted">Left out:
                <ul>{preview.skipped.map((f) => <li key={f.path}><span className="mono">{f.path}</span>: {f.reason}</li>)}</ul>
              </span>
            )}
            <pre className="skill-entry mono">{skillEntryText(preview.skill.files)}</pre>
            <label className="muted" htmlFor="skill-id">Id (optional; needed if the name can’t be used as one)</label>
            <input id="skill-id" value={id} placeholder={preview.skill.name} disabled={busy} onChange={(e) => setId(e.target.value)} />
            <span className="row">
              <button type="button" className="btn sm" disabled={busy} onClick={() => void add()}>{busy ? 'Adding…' : 'Add'}</button>
              <button type="button" className="btn ghost sm" disabled={busy} onClick={() => { setPreview(null); setErr(null); }}>Cancel</button>
            </span>
          </span>
        )}
      </span>
    </div>
  );
}

function SkillRow({ skill, onChange, onRemoved }: { skill: SkillSummary; onChange: (s: SkillSummary) => void; onRemoved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [updatedSha, setUpdatedSha] = useState<string | null>(null);
  const label = `skill-${skill.id}`;

  const act = async <T,>(fn: () => Promise<{ status: number; body: T & { reason?: string } }>, ok: (body: T) => void) => {
    setBusy(true); setErr(null); setUpdatedSha(null);
    try {
      const res = await fn();
      if (res.status < 300) ok(res.body); else setErr(refusal(res));
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };

  const save = (state: { enabled?: boolean; roles?: SkillRole[] }) =>
    act(() => api.setSkillState(skill.id, state), (b) => { if (b.skill) onChange(b.skill); });
  const update = () => act(() => api.refreshSkill(skill.id), (b) => {
    if (!b.skill) return;
    onChange(b.skill);
    setUpdatedSha(b.skill.commitSha);
  });
  const del = () => {
    if (!window.confirm(`Remove the skill “${skill.name}”? Agents stop getting it from the next task.`)) return;
    void act(() => api.deleteSkill(skill.id), () => onRemoved());
  };

  return (
    <div className="guided">
      <span>
        <span className="q-title" id={label}>{skill.name}{skill.id !== skill.name && <span className="muted mono"> ({skill.id})</span>}</span>
        {skill.description && <span className="muted">{skill.description}</span>}
        <span className="muted">
          <a href={skill.sourceUrl} target="_blank" rel="noopener">{skill.sourceUrl}</a> · <span className="mono">{shortSha(skill.commitSha)}</span>
        </span>
        <span className="skill-roles" role="group" aria-label={`Roles for ${skill.name}`}>
          {SKILL_ROLES.map((r) => (
            <label key={r}>
              <input type="checkbox" checked={skill.roles.includes(r)} disabled={busy || (skill.roles.length === 1 && skill.roles.includes(r))}
                onChange={() => void save({ roles: toggleRole(skill.roles, r) })} /> {r}
            </label>
          ))}
        </span>
        {updatedSha && <span className="muted" role="status">Updated to <span className="mono">{shortSha(updatedSha)}</span></span>}
        {err && <span className="bad" role="alert">{err}</span>}
      </span>
      <div className="row">
        <button type="button" className="btn ghost sm" disabled={busy} onClick={() => void update()}>Update</button>
        <button type="button" className="btn ghost sm" disabled={busy} onClick={del}>Remove</button>
        <button type="button" role="switch" className="switch" aria-checked={skill.enabled} aria-labelledby={label} disabled={busy}
          onClick={() => void save({ enabled: !skill.enabled })}>
          <span className="switch-knob" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
