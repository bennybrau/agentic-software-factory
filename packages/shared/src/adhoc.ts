import { z } from 'zod';

/**
 * Ad-hoc tasks (#179): a ticket that lives in the factory's own Postgres instead
 * of a tracker. Its id is `adhoc:<id>` and its provider kind is `adhoc`, so once
 * created it rides the ordinary dispatch → planner → fleet flow unchanged. The
 * api routes an `adhoc:` id to a read-only provider backed by the registry.
 *
 * Browser-safe (re-exported from ui.ts): no node built-ins here.
 */
export const ADHOC_ID_PREFIX = 'adhoc:';
export const isAdhocId = (id: string): boolean => id.startsWith(ADHOC_ID_PREFIX);

/** Images, plain text and PDF only. SVG is left out: it is script-capable markup, not a picture. */
export const ADHOC_ALLOWED_MIME = [
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'text/plain', 'text/markdown', 'text/csv',
  'application/pdf',
] as const;
export const isAllowedAttachmentMime = (mime: string): boolean =>
  (ADHOC_ALLOWED_MIME as readonly string[]).includes(mime.split(';')[0].trim().toLowerCase());

/** Default limits; the api enforces ADHOC_MAX_ATTACHMENTS / ADHOC_MAX_ATTACHMENT_MB. */
export const ADHOC_DEFAULT_LIMITS = { maxFiles: 10, maxFileMb: 10 } as const;
export interface AdhocLimits { maxFiles: number; maxFileMb: number }

/**
 * Why a set of files cannot be attached, or null when they can. The one rule
 * both the New task screen (before upload) and POST /api/adhoc (authoritative) apply.
 */
export function attachmentProblem(files: ReadonlyArray<{ name: string; mime: string; size: number }>, l: AdhocLimits): string | null {
  if (files.length > l.maxFiles) return `At most ${l.maxFiles} files can be attached (got ${files.length}).`;
  for (const f of files) {
    if (!isAllowedAttachmentMime(f.mime)) return `${f.name}: only images (PNG, JPEG, GIF, WebP), plain text and PDF can be attached${f.mime ? ` (got ${f.mime})` : ''}.`;
    if (f.size === 0) return `${f.name} is empty.`;
    if (f.size > l.maxFileMb * 1024 * 1024) return `${f.name} is larger than ${l.maxFileMb} MB.`;
  }
  return null;
}

/**
 * A request body big enough for `maxFiles` files of `maxFileMb` each, base64
 * encoded (4/3), plus 1 MiB for the title, body and JSON framing. Used as the
 * route-level bodyLimit on the api's POST /api/adhoc and the registry's RPC.
 */
export function adhocBodyLimitBytes(l: AdhocLimits): number {
  return Math.ceil(l.maxFiles * l.maxFileMb * 1024 * 1024 * 4 / 3) + 1024 * 1024;
}

/**
 * The worker writes attachments to disk by name, so a name is reduced to a safe
 * basename: no directory parts, no leading dots, only [A-Za-z0-9._-]. Never empty.
 */
export function safeAttachmentName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').slice(0, 100);
  return cleaned || 'file';
}

export const attachmentSchema = z.object({
  name: z.string().min(1),
  mime: z.string().min(1),
  size: z.number().int().nonnegative(),
});
export type Attachment = z.infer<typeof attachmentSchema>;

export const adhocTaskSchema = z.object({
  id: z.string(),                 // adhoc:<id>
  key: z.string(),                // human handle, e.g. "ADHOC-3f2a9c"
  title: z.string(),
  body: z.string(),               // Markdown
  createdBy: z.string().nullable(),
  attachments: z.array(attachmentSchema),
  createdAt: z.string(),
  /** The recurring task (#188) that created this one, if any. */
  recurringId: z.string().nullable().optional(),
  /** That schedule's title; null when the schedule has since been deleted. */
  recurringTitle: z.string().nullable().optional(),
});
export type AdhocTask = z.infer<typeof adhocTaskSchema>;

/** One uploaded file on the wire (browser → api → registry). */
export const adhocFileInputSchema = z.object({
  name: z.string().min(1).max(255),
  mime: z.string().min(1),
  contentBase64: z.string(),
});
export type AdhocFileInput = z.infer<typeof adhocFileInputSchema>;

/** POST /api/adhoc. */
export const createAdhocRequestSchema = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().max(100_000).default(''),
  files: z.array(adhocFileInputSchema).default([]),
  /** Created from the chat: the api appends the connected repositories to the body. */
  chat: z.boolean().default(false),
});
export type CreateAdhocRequest = z.infer<typeof createAdhocRequestSchema>;

/** The registry's createAdhoc input: already validated and name-sanitised by the api. */
export const createAdhocInputSchema = z.object({
  title: z.string().min(1),
  body: z.string(),
  createdBy: z.string().nullable().default(null),
  attachments: z.array(adhocFileInputSchema),
});
export type CreateAdhocInput = z.infer<typeof createAdhocInputSchema>;

/** One attachment with its bytes, as the registry hands it back. */
export interface AdhocAttachmentWire extends Attachment { contentBase64: string }
