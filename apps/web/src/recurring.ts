import { nativeId } from '@asf/shared/ui';
import type { RecurringTask, Schedule } from '@asf/shared/ui';
import { encodeTicketId } from './api';
import { runStateLabel } from './words';

/**
 * Pure helpers for the Recurring page (#188), unit-tested without a DOM. The form
 * keeps every kind's fields at once, so switching daily → weekly → monthly and back
 * doesn't throw away what was typed.
 */
export type ScheduleKind = Schedule['kind'];
export interface ScheduleForm { kind: ScheduleKind; time: string; weekdays: number[]; day: number }
export interface RecurringForm { title: string; body: string; repoId: string; timezone: string; schedule: ScheduleForm }

export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const TITLE_MAX = 200;

/** A new task's schedule: weekdays at 9:00 AM. */
export const DEFAULT_SCHEDULE_FORM: ScheduleForm = { kind: 'weekly', time: '09:00', weekdays: [1, 2, 3, 4, 5], day: 1 };

export function scheduleToForm(s: Schedule): ScheduleForm {
  return {
    ...DEFAULT_SCHEDULE_FORM,
    kind: s.kind,
    time: s.time,
    ...(s.kind === 'weekly' ? { weekdays: [...s.weekdays] } : {}),
    ...(s.kind === 'monthly' ? { day: s.day } : {}),
  };
}

export function formToSchedule(f: ScheduleForm): Schedule {
  switch (f.kind) {
    case 'daily': return { kind: 'daily', time: f.time };
    case 'weekly': return { kind: 'weekly', weekdays: [...new Set(f.weekdays)].sort((a, b) => a - b), time: f.time };
    case 'monthly': return { kind: 'monthly', day: f.day, time: f.time };
  }
}

/** Why the form can't be saved yet, in words, or null when it can. */
export function recurringFormProblem(f: RecurringForm): string | null {
  if (!f.title.trim()) return 'Give the task a title.';
  if (f.title.trim().length > TITLE_MAX) return `Keep the title under ${TITLE_MAX} characters.`;
  if (!f.repoId) return 'Choose the repository the work goes into.';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(f.schedule.time)) return 'Pick a time of day.';
  if (f.schedule.kind === 'weekly' && f.schedule.weekdays.length === 0) return 'Pick at least one weekday.';
  if (f.schedule.kind === 'monthly' && !(Number.isInteger(f.schedule.day) && f.schedule.day >= 1 && f.schedule.day <= 31)) return 'Pick a day of the month from 1 to 31.';
  if (!f.timezone.trim()) return 'Choose a time zone.';
  return null;
}

/**
 * The connected repository a stored repoId names, matched by native id (a task saved
 * before M12 holds a bare id; the list hands out qualified ones). Null when none is.
 */
export function findRepo<R extends { id: string }>(repos: R[], repoId: string): R | null {
  return repos.find((r) => nativeId(r.id) === nativeId(repoId)) ?? null;
}

/** The dropdown value for a stored repoId: the matching listed option's id, else the stored id as it is. */
export function repoOptionId(repos: { id: string }[], repoId: string): string {
  return findRepo(repos, repoId)?.id ?? repoId;
}

/** A repository as text: its path when it is connected, else its id without the connection prefix. */
export function repoLabel(repos: { id: string; path: string }[], repoId: string): string {
  return findRepo(repos, repoId)?.path ?? nativeId(repoId);
}

/** What the list shows for the last time the schedule fired: a pill and, where there is one, a link. */
export interface LastRunView { label: string; pill: string; href: string | null }

export function lastRunView(task: Pick<RecurringTask, 'lastRun'>): LastRunView | null {
  const last = task.lastRun;
  if (!last) return null;
  if (last.skipped) return { label: 'Skipped: previous run still going', pill: 'awaiting_checkpoint', href: null };
  if (last.runId) return { label: runStateLabel(last.state ?? 'queued'), pill: last.state ?? '', href: `/run/${encodeURIComponent(last.runId)}` };
  // Fired, but no run yet: the ad-hoc task is waiting to be started.
  return { label: 'Waiting to start', pill: '', href: `/dispatch/${encodeTicketId(last.adhocId)}` };
}

/** e.g. "Mon 5 Oct, 9:00 AM" in the task's own zone; "—" when nothing is scheduled. */
export function formatNextRun(iso: string | null, tz: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }).format(d);
  } catch {
    return d.toISOString();
  }
}

/** The browser's own zone, to prefill a new task. */
export function browserTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}
