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
