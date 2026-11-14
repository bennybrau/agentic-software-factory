import { useEffect, useRef, useState } from 'react';

/** What the button is showing: ready to copy, just copied, or the clipboard refused. */
export type CopyState = 'idle' | 'copied' | 'failed';
const RESET_MS = 1500;

/**
 * Material Symbols icon and accessible label per state; the label doubles as the
 * hover tooltip. Keep `icon: '<name>'` literal: icons.test.ts scans for it to check
 * the vendored font subset covers every icon.
 */
export const COPY_LOOK: Record<CopyState, { icon: string; label: string }> = {
  idle: { icon: 'link', label: 'Copy link to this run' },
  copied: { icon: 'check', label: 'Link copied' },
  failed: { icon: 'link_off', label: "Couldn't copy the link" },
};

/** The run page's full address; matches the `run/:runId` route (the router has no basename). */
export function runPageUrl(origin: string, runId: string): string {
  return `${origin}/run/${encodeURIComponent(runId)}`;
}

type Schedule = (fn: () => void, ms: number) => unknown;

/**
 * Copies `url` and shows the outcome for a moment. It stops the click from
 * reaching a clickable parent (an Activity row), so copying never opens the run.
 */
export async function copyLink(
  e: { stopPropagation(): void },
  writeText: ((text: string) => Promise<void>) | undefined,
  url: string,
  setState: (s: CopyState) => void,
  schedule: Schedule = setTimeout,
): Promise<unknown> {
  e.stopPropagation();
  let ok = false;
  if (writeText) {
    try { await writeText(url); ok = true; } catch { ok = false; }
  }
  setState(ok ? 'copied' : 'failed');
  return schedule(() => setState('idle'), RESET_MS);
}

export function CopyLinkButtonView({ state, onClick }: { state: CopyState; onClick?: (e: React.MouseEvent) => void }) {
  const { icon, label } = COPY_LOOK[state];
  return (
    <button type="button" className={`icon-btn copy-link ${state}`} aria-label={label} title={label} onClick={onClick}>
      <span className="material-symbols-outlined" aria-hidden="true">{icon}</span>
      <span className="sr-only" aria-live="polite">{state === 'idle' ? '' : label}</span>
    </button>
  );
}

/** A small link icon that copies the run page's address. Used on the run page and each Activity row. */
export function CopyLinkButton({ runId }: { runId: string }) {
  const [state, setState] = useState<CopyState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const onClick = (e: React.MouseEvent) => {
    clearTimeout(timer.current);
    const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    const writeText = clip?.writeText ? (text: string) => clip.writeText(text) : undefined;
    void copyLink(e, writeText, runPageUrl(window.location.origin, runId), setState, (fn, ms) => {
      timer.current = setTimeout(fn, ms);
      return timer.current;
    });
  };
  return <CopyLinkButtonView state={state} onClick={onClick} />;
}
