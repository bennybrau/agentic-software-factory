import { useEffect, useRef, useState } from 'react';
import { useMe } from '../useMe';
import { clearOperatorName, getOperatorName, nameInitial, onOperatorNameChange, setOperatorName, MAX_NAME } from '../operator-name';

/**
 * The name this browser acts under when there is no sign-in (#129): the name with
 * a Change button, or "Set your name". Editing opens a small box with Save, Clear
 * and the reason a name can't be used. Only shown in AUTH_MODE=none; behind a
 * sign-in proxy the server says who you are. Nothing checks the name, so there
 * is no verified mark.
 */
export function OperatorName() {
  const me = useMe();
  const [name, setName] = useState(getOperatorName);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => onOperatorNameChange(() => setName(getOperatorName())), []);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setEditing(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  if (me.mode !== 'none') return null;

  const open = () => { setDraft(name ?? ''); setProblem(null); setEditing(true); };
  const save = () => {
    const why = setOperatorName(draft);
    setProblem(why);
    if (!why) setEditing(false);
  };
  const clear = () => { clearOperatorName(); setEditing(false); };

  return (
    <div className="operator-name" ref={ref}>
      {name
        ? <span className="muted" title="The name your actions are recorded under in this browser">{name}</span>
        : null}
      <button className="btn ghost sm" onClick={() => (editing ? setEditing(false) : open())}
        title={name ? `${name}: change the name your actions are recorded under` : 'Set the name your actions are recorded under'}
        aria-label={name ? `Change your name (${name})` : 'Set your name'}>
        {/* The words everywhere except the tablet icon rail, which only has room for one letter. */}
        <span className="op-full">{name ? 'Change' : 'Set your name'}</span>
        <span className="op-chip" aria-hidden="true">{nameInitial(name)}</span>
      </button>
      {editing && (
        <form className="card status-pop" onSubmit={(e) => { e.preventDefault(); save(); }}>
          <label className="small">
            Your name
            <input autoFocus value={draft} maxLength={MAX_NAME * 2} onChange={(e) => { setDraft(e.target.value); setProblem(null); }}
              style={{ display: 'block', width: '100%', marginTop: 4 }} />
          </label>
          <p className="muted small">Kept in this browser and shown on what you approve, reject and send. Nothing checks it.</p>
          {problem && <p className="bad small">{problem}</p>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn sm" type="submit">Save</button>
            {name && <button className="btn ghost sm" type="button" onClick={clear}>Clear</button>}
          </div>
        </form>
      )}
    </div>
  );
}
