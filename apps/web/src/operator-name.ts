/**
 * The name this browser acts under when there is no sign-in (AUTH_MODE=none, #129).
 * Kept in localStorage and sent with every api request as X-Operator, so gate
 * decisions, chat messages and dispatches say who did them. Nothing checks it.
 *
 * Storage can throw (private mode, disabled storage, quota); every access is
 * guarded, and then the name only lasts until the page is reloaded.
 */

export const OPERATOR_NAME_KEY = 'asf.operator.name';
export const MAX_NAME = 40;

export type NameStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function local(): NameStore | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

let store: NameStore | null = local();
let current: string | null = read();
const listeners = new Set<() => void>();

function read(): string | null {
  try { const v = store?.getItem(OPERATOR_NAME_KEY)?.trim(); return v && !validateName(v) ? v : null; } catch { return null; }
}

/** Why a name can't be used, or null when it can. Counted in characters after trimming. */
export function validateName(s: string): string | null {
  const n = [...s.trim()].length;
  if (n === 0) return 'Enter a name.';
  if (n > MAX_NAME) return `Keep it to ${MAX_NAME} characters.`;
  return null;
}

/** The saved name, or null when none is set. */
export function getOperatorName(): string | null { return current; }

/** Saves the trimmed name and tells listeners. Returns the reason instead when it isn't valid. */
export function setOperatorName(s: string): string | null {
  const problem = validateName(s);
  if (problem) return problem;
  const name = s.trim();
  try { store?.setItem(OPERATOR_NAME_KEY, name); } catch { /* storage unavailable or full */ }
  if (name !== current) { current = name; notify(); }
  return null;
}

export function clearOperatorName(): void {
  try { store?.removeItem(OPERATOR_NAME_KEY); } catch { /* storage unavailable */ }
  if (current !== null) { current = null; notify(); }
}

/** Called after the name changes; returns the unsubscribe. */
export function onOperatorNameChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function notify() { for (const fn of [...listeners]) fn(); }

/** The request headers that carry the name: X-Operator, percent-encoded (a header can't carry "Zoë" as-is). */
export function operatorHeaders(name: string | null = current): Record<string, string> {
  return name ? { 'X-Operator': encodeURIComponent(name) } : {};
}

/** The one letter shown where there is no room for the name (the tablet icon rail): its first character, upper-cased; '?' when no name is set. */
export function nameInitial(name: string | null): string {
  const first = name ? [...name.trim()][0] : undefined;
  return first ? first.toLocaleUpperCase() : '?';
}

/** For tests: read from another store, as if the page had just loaded. */
export function setNameStore(s: NameStore | null): void { store = s; current = read(); }
