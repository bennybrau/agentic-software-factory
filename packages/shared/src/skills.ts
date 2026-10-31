import { z } from 'zod';

/**
 * Third-party skills: SKILL.md bundles an operator adds for the fleet to use.
 * A skill is stored as its text files, pinned to the commit it was fetched at,
 * and is off until an operator enables it for one or more roles.
 *
 * Only text files are allowed, the paths are relative and never climb out of
 * the skill's directory, and the whole skill is bounded in size and count.
 */
export const SKILL_ID_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
/** The `name` in a SKILL.md frontmatter: lower-case letters, digits and hyphens, 1–64 chars. */
export const SKILL_NAME_RE = /^[a-z0-9-]{1,64}$/;

export const SKILL_MAX_FILES = 200;
export const SKILL_MAX_TOTAL_BYTES = 512 * 1024;
export const SKILL_ALLOWED_EXTENSIONS = ['.md', '.txt', '.json', '.yaml', '.yml', '.csv'] as const;
/** Every skill has this file at its root. */
export const SKILL_ENTRY_FILE = 'SKILL.md';

/** The roles a skill can be given to. Stricter than `roleSchema`, which accepts any string. */
export const SKILL_ROLES = ['planner', 'implementer', 'tester', 'reviewer'] as const;
export const skillRoleSchema = z.enum(SKILL_ROLES);
export type SkillRole = z.infer<typeof skillRoleSchema>;

const extension = (path: string): string => {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
};

const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;

export const skillFileSchema = z.object({
  path: z.string().min(1).max(255)
    .refine((p) => !p.startsWith('/'), 'a skill file path must be relative')
    .refine((p) => !p.split('/').includes('..'), 'a skill file path must not contain ".."')
    .refine((p) => (SKILL_ALLOWED_EXTENSIONS as readonly string[]).includes(extension(p)),
      `a skill file must end in ${SKILL_ALLOWED_EXTENSIONS.join(', ')}`),
  content: z.string(),
}).strict();
export type SkillFile = z.infer<typeof skillFileSchema>;

const skillFilesSchema = z.array(skillFileSchema).min(1).max(SKILL_MAX_FILES)
  .refine((fs) => new Set(fs.map((f) => f.path)).size === fs.length, 'skill file paths must be unique')
  .refine((fs) => fs.some((f) => f.path === SKILL_ENTRY_FILE), `a skill must include ${SKILL_ENTRY_FILE}`)
  .refine((fs) => fs.reduce((n, f) => n + utf8Bytes(f.content), 0) <= SKILL_MAX_TOTAL_BYTES,
    `a skill must be at most ${SKILL_MAX_TOTAL_BYTES / 1024} KB in total`);

/** The roles a skill is given to: at least one, no repeats. */
export const skillRolesSchema = z.array(skillRoleSchema).min(1)
  .refine((rs) => new Set(rs).size === rs.length, 'skill roles must be unique');

export const thirdPartySkillSchema = z.object({
  id: z.string().regex(SKILL_ID_RE, 'use 2–32 lower-case letters, digits or dashes'),
  name: z.string().regex(SKILL_NAME_RE, 'use 1–64 lower-case letters, digits or hyphens'),
  description: z.string().max(1024),
  sourceUrl: z.string().url(),
  sourceRef: z.string().min(1).max(255),
  commitSha: z.string().regex(/^[0-9a-f]{7,64}$/i, 'use a commit sha'),
  files: skillFilesSchema,
  enabled: z.boolean(),
  roles: skillRolesSchema,
  addedBy: z.string().nullable(),
  updatedAt: z.string(),
}).strict();
export type ThirdPartySkill = z.infer<typeof thirdPartySkillSchema>;

/** What putSkill takes. `enabled` and `roles` are set with setSkillState, and a replace keeps them. */
export const skillInputSchema = thirdPartySkillSchema.omit({ enabled: true, roles: true, updatedAt: true });
export type SkillInput = z.infer<typeof skillInputSchema>;

/** Enough RPC body for one full skill even if every byte is JSON-escaped (`\u0000`), plus headroom. */
export function skillBodyLimitBytes(): number {
  return SKILL_MAX_TOTAL_BYTES * 6 + 1024 * 1024;
}
