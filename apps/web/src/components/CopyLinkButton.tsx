import { useEffect, useRef, useState } from 'react';

export const COPY_LABEL = 'Copy link';
export const COPIED_LABEL = 'Copied';
export const COPY_FAILED_LABEL = "Couldn't copy";
const RESET_MS = 1500;

/** The run page's full address; matches the `run/:runId` route (the router has no basename). */
export function runPageUrl(origin: string, runId: string): string {
  return `${origin}/run/${encodeURIComponent(runId)}`;
}

type Schedule = (fn: () => void, ms: number) => unknown;

/** Copies `url` and shows the outcome on the label for a moment. Returns the reset timer. */
export async function copyLink(
  writeText: ((text: string) => Promise<void>) | undefined,
  url: string,
  setLabel: (label: string) => void,
  schedule: Schedule = setTimeout,
): Promise<unknown> {
  let ok = false;
  if (writeText) {
    try { await writeText(url); ok = true; } catch { ok = false; }
  }
  setLabel(ok ? COPIED_LABEL : COPY_FAILED_LABEL);
  return schedule(() => setLabel(COPY_LABEL), RESET_MS);
}

export function CopyLinkButtonView({ label, onClick }: { label: string; onClick?: () => void }) {
  return <button type="button" className="btn ghost sm copy-link" aria-live="polite" onClick={onClick}>{label}</button>;
}

export function CopyLinkButton({ runId }: { runId: string }) {
  const [label, setLabel] = useState(COPY_LABEL);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const onClick = () => {
    clearTimeout(timer.current);
    const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    const writeText = clip?.writeText ? (text: string) => clip.writeText(text) : undefined;
    void copyLink(writeText, runPageUrl(window.location.origin, runId), setLabel, (fn, ms) => {
      timer.current = setTimeout(fn, ms);
      return timer.current;
    });
  };
  return <CopyLinkButtonView label={label} onClick={onClick} />;
}
