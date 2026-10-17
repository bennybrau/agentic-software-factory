import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { attachmentProblem, type AdhocFileInput, type AdhocLimits } from '@asf/shared/ui';
import { formatBytes, mimeOf, type PickedMeta } from '../new-task';

export interface Picked { key: number; file: File; mime: string; preview: string | null }

export const ATTACH_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,text/plain,text/markdown,.md,text/csv,application/pdf';

/** The file's bytes as base64 (the data: URL minus its prefix). */
function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error ?? new Error(`could not read ${file.name}`));
    r.readAsDataURL(file);
  });
}

export const pickedMeta = (p: Picked): PickedMeta => ({ name: p.file.name, mime: p.mime, size: p.file.size });

/**
 * Screenshots and files attached to an ad-hoc task: drop, paste or pick. A batch
 * that breaks a limit is refused whole, with the reason passed to `onProblem`.
 */
export function useAttachments(limits: AdhocLimits, onProblem: (reason: string | null) => void) {
  const [files, setFiles] = useState<Picked[]>([]);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const nextKey = useRef(0);
  const previews = useRef<string[]>([]);

  // Object URLs for image thumbnails live until the page does.
  useEffect(() => () => { previews.current.forEach((u) => URL.revokeObjectURL(u)); }, []);

  const add = (incoming: File[]) => {
    if (!incoming.length) return;
    const picked = incoming.map((file): Picked => ({ key: nextKey.current++, file, mime: mimeOf(file.name, file.type), preview: null }));
    // Refuse the whole batch with the reason, rather than silently dropping some of it.
    const problem = attachmentProblem([...files, ...picked].map(pickedMeta), limits);
    if (problem) { onProblem(problem); return; }
    for (const p of picked) {
      if (p.mime.startsWith('image/')) { p.preview = URL.createObjectURL(p.file); previews.current.push(p.preview); }
    }
    onProblem(null);
    setFiles((cur) => [...cur, ...picked]);
  };
  const remove = (key: number) => setFiles((cur) => cur.filter((p) => p.key !== key));
  const clear = () => setFiles([]);

  // A pasted screenshot arrives as a file on the clipboard; plain text pastes as usual.
  const onPaste = (e: ClipboardEvent) => {
    const pasted = Array.from(e.clipboardData.files);
    if (pasted.length) { e.preventDefault(); add(pasted); }
  };
  const dropProps = {
    onDragOver: (e: DragEvent) => { e.preventDefault(); setDragging(true); },
    onDragLeave: (e: DragEvent) => { if (e.currentTarget === e.target) setDragging(false); },
    onDrop: (e: DragEvent) => { e.preventDefault(); setDragging(false); add(Array.from(e.dataTransfer.files)); },
    onPaste,
  };
  const pick = () => input.current?.click();
  const payload = (): Promise<AdhocFileInput[]> =>
    Promise.all(files.map(async (p) => ({ name: p.file.name, mime: p.mime, contentBase64: await toBase64(p.file) })));
  const fileInput = (
    <input ref={input} type="file" multiple hidden accept={ATTACH_ACCEPT}
      onChange={(e) => { add(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
  );

  return { files, dragging, dropProps, pick, remove, clear, payload, fileInput };
}

/** Thumbnails for picked images, an icon for other files, each with a remove button. */
export function AttachmentList({ files, onRemove }: { files: Picked[]; onRemove: (key: number) => void }) {
  if (!files.length) return null;
  return (
    <ul className="attachments">
      {files.map((p) => (
        <li key={p.key} className="attachment">
          {p.preview
            ? <img src={p.preview} alt={p.file.name} />
            : <span className="material-symbols-outlined attachment-icon" aria-hidden="true">{p.mime === 'application/pdf' ? 'picture_as_pdf' : 'description'}</span>}
          <span className="attachment-name" title={p.file.name}>{p.file.name}</span>
          <span className="muted small">{formatBytes(p.file.size)}</span>
          <button className="attachment-remove" onClick={() => onRemove(p.key)} aria-label={`Remove ${p.file.name}`} title="Remove">×</button>
        </li>
      ))}
    </ul>
  );
}
