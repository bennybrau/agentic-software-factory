import { attachmentProblem, type AdhocLimits } from '@asf/shared/ui';

/** The file's metadata as the New task screen and the api check it. */
export interface PickedMeta { name: string; mime: string; size: number }

const BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown', csv: 'text/csv', pdf: 'application/pdf',
};

/** The browser leaves File.type blank for some text files (.md on most systems); fall back to the extension. */
export function mimeOf(name: string, type: string): string {
  if (type) return type;
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  return BY_EXT[ext] ?? '';
}

export const TITLE_MAX = 200;

/** Why the task cannot be submitted yet, or null. The api re-checks everything. */
export function newTaskProblem(title: string, files: PickedMeta[], limits: AdhocLimits): string | null {
  const t = title.trim();
  if (!t) return 'Give the task a title.';
  if (t.length > TITLE_MAX) return `Keep the title under ${TITLE_MAX} characters.`;
  return attachmentProblem(files, limits);
}

const CHAT_TITLE_MAX = 80;

/**
 * The task title for a chat message: its first non-empty line with the Markdown
 * stripped, cut at a word boundary to fit, or 'New chat' if nothing is left.
 */
export function chatTitle(text: string): string {
  const line = text.split('\n').map((l) => l
    .replace(/^\s*(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)+/, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .trim()).find(Boolean);
  if (!line) return 'New chat';
  if (line.length <= CHAT_TITLE_MAX) return line;
  const cut = line.slice(0, CHAT_TITLE_MAX + 1);
  const space = cut.lastIndexOf(' ');
  return (space > 0 ? cut.slice(0, space) : line.slice(0, CHAT_TITLE_MAX)).trimEnd();
}

/** Why the chat message cannot be sent yet, or null. */
export function chatProblem(text: string, files: PickedMeta[], limits: AdhocLimits): string | null {
  if (!text.trim()) return 'Say what we should work on.';
  return attachmentProblem(files, limits);
}

/** The repository a chat starts in: the one the task names, else the first connected one. */
export function pickChatRepo(preview: { suggestedRepoId: string | null; repos: { id: string }[] }): string | null {
  return preview.suggestedRepoId ?? preview.repos[0]?.id ?? null;
}

/**
 * Where to go after saving an ad-hoc task: straight to the Start screen for it
 * ('start'), or back to the Things-to-do list ('later'). The id must already be
 * encoded (see `encodeTicketId`) so this stays pure and testable.
 */
export function adhocNext(choice: 'start' | 'later', encodedId: string): string {
  return choice === 'start' ? `/dispatch/${encodedId}` : '/backlog';
}

/**
 * Remove an ad-hoc task, then refresh the list. Split out of the view so the
 * delete-then-refetch sequence stays pure and testable.
 */
export async function removeAdhoc(
  deps: { delete: (id: string) => Promise<unknown>; refetch: () => Promise<unknown> },
  id: string,
): Promise<void> {
  await deps.delete(id);
  await deps.refetch();
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
