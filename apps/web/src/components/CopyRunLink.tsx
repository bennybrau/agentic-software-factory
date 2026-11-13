import { useEffect, useRef, useState } from 'react';

/** The shareable address of a run page (the router has no basename). */
export function runUrl(origin: string, runId: string): string {
  return `${origin}/run/${encodeURIComponent(runId)}`;
}

/**
 * Copy a run link without opening the row it sits in. On success the label
 * flips to "Copied" for 1.5s; if the clipboard is missing or refuses, nothing
 * changes and nothing is thrown.
 */
export async function copyRunLink(
  e: { stopPropagation(): void },
  opts: {
    url: string;
    writeText: ((text: string) => Promise<void>) | undefined;
    setCopied: (v: boolean) => void;
    schedule: (fn: () => void, ms: number) => unknown;
  },
): Promise<void> {
  e.stopPropagation();
  if (!opts.writeText) return;
  try {
    await opts.writeText(opts.url);
  } catch {
    return;
  }
  opts.setCopied(true);
  opts.schedule(() => opts.setCopied(false), 1500);
}

export function CopyRunLinkView({ copied, onClick }: { copied: boolean; onClick?: (e: React.MouseEvent) => void }) {
  return (
    <button type="button" className="btn ghost sm" aria-label="Copy link to this run" onClick={onClick}>
      {copied ? 'Copied' : 'Copy link'}
    </button>
  );
}

export function CopyRunLink({ runId }: { runId: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  return (
    <CopyRunLinkView
      copied={copied}
      onClick={(e) => void copyRunLink(e, {
        url: runUrl(window.location.origin, runId),
        writeText: clipboard ? (t) => clipboard.writeText(t) : undefined,
        setCopied,
        schedule: (fn, ms) => { clearTimeout(timer.current); timer.current = setTimeout(fn, ms); },
      })}
    />
  );
}
