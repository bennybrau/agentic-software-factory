import { nativeId } from '@asf/shared/ui';

/**
 * Per-role runtime + model choice on the Dispatch page (#69). Pure, so the rules
 * are testable without a browser: the runtime narrows the models a role may use,
 * and only choices that differ from the defaults are sent.
 */
export interface ModelOption { id: string; label: string; runtimes: string[] }

/** The models a role may pick once it runs on `runtime`. */
export const modelsFor = <M extends ModelOption>(models: M[], runtime: string): M[] => models.filter((m) => m.runtimes.includes(runtime));

/** Keep `current` if it fits `runtime`; otherwise switch to the first model that does (or keep it, if none do). */
export function reconcileModel(models: ModelOption[], runtime: string, current: string): string {
  const fit = modelsFor(models, runtime);
  return fit.some((m) => m.id === current) ? current : (fit[0]?.id ?? current);
}

/** What the role's runtime select offers: what the fleet runs, always including the current choice. */
export const runtimeOptions = (fleet: string[], current: string): string[] => (fleet.includes(current) ? fleet : [current, ...fleet]);

/** Only the roles whose choice differs from the default. */
export const overridesDiff = (chosen: Record<string, string>, defaults: Record<string, string | null | undefined>): Record<string, string> =>
  Object.fromEntries(Object.entries(chosen).filter(([role, v]) => v && v !== defaults[role]));

/** Why a role's on/off switch is locked on this page, or null when the operator may flip it. */
export function roleLock(role: string, orgDisabled: string[]): string | null {
  if (orgDisabled.includes(role)) return 'Switched off for every job in Settings → pipeline stages.';
  if (role === 'implementer') return 'Someone has to write the code: the pull request needs a change to open.';
  return null;
}

/** The `skipRoles` to send: the roles switched off here, minus those the org already has off. */
export const skipRolesPayload = (off: Record<string, boolean>, orgDisabled: string[]): string[] =>
  Object.entries(off).filter(([role, isOff]) => isOff && !orgDisabled.includes(role)).map(([role]) => role);

/** What the page holds for this job, and the defaults it loaded with. */
export interface DispatchChoices {
  models: Record<string, string>; runtimes: Record<string, string>; efforts: Record<string, string>;
  gates: Record<string, string>; off: Record<string, boolean>;
}
export interface DispatchDefaults {
  defaultModels: Record<string, string | null | undefined>; defaultRuntimes: Record<string, string | null | undefined>;
  defaultEfforts: Record<string, string | null | undefined>; gates: Record<string, { mode: string }>; orgDisabledRoles?: string[];
}

/** Whether anything under "Advanced" differs from the defaults, so the collapsed summary can say so. */
export function isCustomised({ models, runtimes, efforts, gates, off }: DispatchChoices, preview: DispatchDefaults): boolean {
  const effortDefaults = Object.fromEntries(Object.entries(preview.defaultEfforts).map(([k, v]) => [k, v ?? '']));
  return Object.keys(overridesDiff(models, preview.defaultModels)).length > 0
    || Object.keys(overridesDiff(runtimes, preview.defaultRuntimes)).length > 0
    || Object.keys(overridesDiff(efforts, effortDefaults)).length > 0
    || Object.entries(gates).some(([g, mode]) => mode !== preview.gates[g]?.mode)
    || skipRolesPayload(off, preview.orgDisabledRoles ?? []).length > 0;
}

/** The check-ins worth asking about: no "after the plan" check-in when nobody writes a plan. */
export const gatesFor = (gates: string[], plannerOff: boolean): string[] => (plannerOff ? gates.filter((g) => g !== 'after_plan') : gates);

/** What the dispatch preview says about the repository it suggests. Older servers send only `suggestedRepoId`. */
export interface RepoSuggestion {
  repos: { id: string; path: string }[];
  suggestedRepoId: string | null;
  suggestedRepoReason?: string | null;
  mentionedRepoIds?: string[];
}

/** A repo's short name (its last path segment), or the full path when another connected repo shares that name. */
function shortRepoName(repos: { path: string }[], path: string): string {
  const last = (p: string) => p.slice(p.lastIndexOf('/') + 1);
  return repos.filter((r) => last(r.path) === last(path)).length > 1 ? path : last(path);
}

/**
 * The muted line under the Repository select: why it is preselected, and which
 * other repositories the ticket names. Shown only while the suggested repository
 * is the one selected; null otherwise (nothing to explain).
 */
export function repoHint(preview: RepoSuggestion, selected: string, isAdhoc: boolean): string | null {
  // Ids compare by native id: the browser doesn't know the default connection.
  const same = (a: string, b: string) => nativeId(a) === nativeId(b);
  if (!preview.suggestedRepoId || !same(selected, preview.suggestedRepoId)) return null;
  const reason = preview.suggestedRepoReason
    ?? (isAdhoc ? 'Suggested: the repository the run that added it was working in.' : 'Suggested: the issue\u2019s own repository.');
  const others = (preview.mentionedRepoIds ?? [])
    .filter((id) => !same(id, selected))
    .map((id) => preview.repos.find((r) => same(r.id, id)))
    .filter((r): r is { id: string; path: string } => Boolean(r))
    .map((r) => shortRepoName(preview.repos, r.path));
  return others.length ? `${reason} Also mentioned: ${others.join(', ')}.` : reason;
}
