import { useEffect, useRef, useState } from 'react';
import { THEME_ROLE_SLOTS, type ThemeManifest, type ThemeMood, type ThemeSlot } from '@asf/shared/ui';
import { useTheme } from '../useTheme';
import { hiveFocus, memberStates, pictureState, type FocusEvent, type FocusGate, type FocusRun, type FocusTask } from '../hive-focus';
import { memberName, moodLine, quipFor } from '../theme-view';
import { stageLabel } from '../words';
import { StillImage, usePrefersReducedMotion } from './StillImage';

const QUIP_EVERY_MS = 6000;
const BURST = 8;
/** A run that finished this recently still gets the delivery burst when its page is opened. */
const FRESH_DELIVERY_MS = 60_000;

/** A short name for the placeholder: "The Queen" → "Q", "Builder" → "B". */
export const initialOf = (name: string) => (name.replace(/^the\s+/i, '').trim()[0] ?? '?').toUpperCase();

export interface HiveStageProps {
  run: FocusRun & { finishedAt?: string | null };
  tasks: readonly FocusTask[];
  gates?: readonly FocusGate[];
  events?: readonly FocusEvent[];
}

/**
 * The Hive stage (M12 WP4): only the member in the spotlight (whoever hiveFocus
 * picks: the working role, or the coordinator at a gate, while idle, delivering
 * or done), shown large, with what it is saying in a speech bubble beside it.
 * The picture is keyed on the member and the bubble on its text, so each change
 * replays a short entrance. A theme with no pictures at all (classic, out of the
 * box) renders as just the quiet caption line.
 */
export function HiveStage(props: HiveStageProps) {
  const { theme, pictureFor, hasStatePictures } = useTheme();
  const reduced = usePrefersReducedMotion();
  const terminal = ['succeeded', 'failed', 'halted', 'cancelled', 'stale'].includes(props.run.state);
  const now = useNow(terminal ? null : 1000);
  const f = hiveFocus({ ...props, now });
  const states = memberStates(props.tasks);
  const hasPictures = (['orchestrator', ...THEME_ROLE_SLOTS] as ThemeSlot[]).some((s) => pictureFor(s));

  const running = props.tasks.find((t) => t.state === 'running' && t.role === f.member);
  const since = running?.startedAt ? Math.max(0, now - Date.parse(running.startedAt)) : 0;
  const caption = stageCaption(theme, f.mood, f.member, since / QUIP_EVERY_MS);
  const announcement = stageCaption(theme, f.mood, f.member, 0);

  const burst = useDeliveryBurst(f.mood, props.run.finishedAt ?? null, reduced || !hasPictures);
  const glyph = theme.handoffGlyph ?? null;

  const live = <span className="sr-only" aria-live="polite">{announcement}</span>;
  if (!hasPictures) {
    return (
      <div className={`hive-quiet mood-${f.mood}`}>
        <span className={`dot ${f.mood === 'failed' ? 'failed' : f.mood === 'delivered' ? 'done' : 'running'}`} />
        <span aria-hidden="true">{caption}</span>
        {live}
      </div>
    );
  }

  const slot = f.focus;
  const name = memberName(theme, slot) ?? slot;
  const state = slot === 'orchestrator' ? null : states[slot] ?? 'pending';
  const pic = pictureState(slot, f, state ?? undefined);
  const url = pictureFor(slot, pic);
  const own = hasStatePictures(slot);
  // The one on stage moves; a stopped job keeps it still.
  const animate = !reduced && f.mood !== 'failed';
  const cls = ['hive-member', 'on', state ? `st-${state}` : '', own ? 'own-states' : ''].filter(Boolean).join(' ');

  return (
    <div className={`hive-stage mood-${f.mood}${reduced ? ' still' : ''}`}>
      <div className={cls} key={slot} data-slot={slot} data-picture={pic}>
        <span className="hive-pic">
          {url
            ? <StillImage src={url} animate={animate} className={`hive-img${own ? ' whole' : ''}`} />
            : <span className="hive-img hive-initial" aria-hidden="true">{initialOf(name)}</span>}
          {burst !== null && Array.from({ length: BURST }, (_, i) => (
            <span key={`${burst}-${i}`} className={`hive-glyph burst${glyph ? '' : ' dot-glyph'}`} aria-hidden="true"
              style={{ ['--a' as string]: `${(360 / BURST) * i}deg` }}>
              {glyph}
            </span>
          ))}
        </span>
        <span className="hive-name">{name}</span>
        {slot !== 'orchestrator' && <span className="hive-step">{stageLabel(slot)}</span>}
      </div>
      <div className="hive-bubble" key={caption} aria-hidden="true">{caption}</div>
      {live}
    </div>
  );
}

/** Working shows the member's rotating quip; every other mood its mood line. */
export function stageCaption(theme: ThemeManifest, mood: ThemeMood, member: ThemeSlot | null, tick: number): string {
  if (mood === 'working' && member) return `${quipFor(theme, member, tick)}…`;
  return moodLine(theme, mood, { member: member ? memberName(theme, member) ?? member : undefined });
}

/** A clock that ticks every `everyMs` (or stands still when null, e.g. a finished run). */
function useNow(everyMs: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (everyMs == null) return;
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

/** One burst of glyphs when the job is delivered: on the transition, or on opening a just-finished run. */
function useDeliveryBurst(mood: ThemeMood, finishedAt: string | null, off: boolean): number | null {
  const prev = useRef<ThemeMood | null>(null);
  const [burst, setBurst] = useState<number | null>(null);
  useEffect(() => {
    const was = prev.current;
    prev.current = mood;
    if (off || mood !== 'delivered' || was === 'delivered') return;
    const fresh = was !== null || (finishedAt != null && Date.now() - Date.parse(finishedAt) < FRESH_DELIVERY_MS);
    if (!fresh) return;
    setBurst(Date.now());
    const id = setTimeout(() => setBurst(null), 1600);
    return () => clearTimeout(id);
  }, [mood, finishedAt, off]);
  return burst;
}
