import { ticketProviderKindSchema } from './ticket.js';
import { scmProviderKindSchema } from './scm.js';

/**
 * Qualified references (M12): `<connection>:<native id>`, e.g. `jira:PROJ-12`,
 * `github:acme/web#42`, `gitlab:acme/platform/web/shared-ui`. A ref without a
 * known connection prefix belongs to the namespace's default connection, so
 * pre-M12 ids keep working. Zod-only and browser-safe (exported from `ui.ts`).
 */

/** Every connection id a ref may be prefixed with: the ticket and SCM provider kinds, deduped. */
export const KNOWN_CONNECTIONS: readonly string[] = [
  ...new Set<string>([...ticketProviderKindSchema.options, ...scmProviderKindSchema.options]),
];

/** Is `id` a known connection id? Exact and case-sensitive. */
export function isKnownConnection(id: string): boolean {
  return KNOWN_CONNECTIONS.includes(id);
}

/**
 * The provider kind of a connection id. This is the ONLY place a kind is read
 * from an id: today a connection id is its kind; once an install can hold
 * several connections of one kind, this returns the part before `:`.
 */
export function connectionKind(id: string): string {
  return id;
}

const CONNECTION_LABEL: Record<string, string> = {
  mock: 'Sample', jira: 'Jira', github: 'GitHub', gitlab: 'GitLab', trello: 'Trello',
  monday: 'monday.com', linear: 'Linear', todoist: 'Todoist', adhoc: 'Ad-hoc',
};

/** The name a person sees for a connection id (`Jira`, `GitHub`), read through its kind. Unknown ids come back unchanged. */
export function connectionLabel(id: string): string {
  return CONNECTION_LABEL[connectionKind(id)] ?? id;
}

/**
 * A comma list of connections (TICKET_PROVIDERS / SCM_PROVIDERS): split, trimmed,
 * deduped, keeping only names in `known`. Nothing left falls back to `single`
 * (TICKET_PROVIDER / SCM_PROVIDER), so a pre-M12 install needs no change. The
 * first is the default connection. Shared by the api and the Settings page.
 */
export function connectionList(list: unknown, single: unknown, known: Iterable<string>): string[] {
  const ok = new Set<string>(known);
  const out = [...new Set(String(list ?? '').split(',').map((s) => s.trim()).filter((s) => ok.has(s)))];
  return out.length ? out : [String(single)];
}

export interface ParsedRef {
  connection: string;
  native: string;
  /** True when the ref carried a known connection prefix; false when it fell back to the default. */
  qualified: boolean;
}

/**
 * Split a ref into its connection and native id. The connection is the text
 * before the first `:`, and only counts if it is a known connection; anything
 * else is a native id of `defaultConnection`. Ad-hoc ids keep their `adhoc:`
 * prefix as the native id, because that is the stored id the adhoc provider expects.
 */
export function parseRef(ref: string, defaultConnection: string): ParsedRef {
  const i = ref.indexOf(':');
  if (i > 0) {
    const connection = ref.slice(0, i);
    if (isKnownConnection(connection)) {
      return { connection, native: connection === 'adhoc' ? ref : ref.slice(i + 1), qualified: true };
    }
  }
  return { connection: defaultConnection, native: ref, qualified: false };
}

/** Qualify a native id with its connection. Idempotent: an already-prefixed id is returned unchanged. */
export function formatRef(connection: string, native: string): string {
  return native.startsWith(`${connection}:`) ? native : `${connection}:${native}`;
}

/** The native id of a ref, with any known connection prefix stripped. */
export function nativeId(ref: string): string {
  return parseRef(ref, '').native;
}

/** Do two refs name the same object? Bare refs resolve against `defaultConnection`. */
export function sameRef(a: string, b: string, defaultConnection: string): boolean {
  const pa = parseRef(a, defaultConnection);
  const pb = parseRef(b, defaultConnection);
  return pa.connection === pb.connection && pa.native === pb.native;
}
