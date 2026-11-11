import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scheduleSchema, type RecurringTask, type Schedule } from '@asf/shared/ui';
import { browserTimeZone, DEFAULT_SCHEDULE_FORM, findRepo, formatNextRun, formToSchedule, lastRunView, recurringFormProblem, repoLabel, repoOptionId, scheduleToForm, TITLE_MAX, type RecurringForm } from './recurring';

const TASK: RecurringTask = {
  id: 'rec_1', title: 'Bump dependencies', body: '', repoId: '1',
  schedule: { kind: 'weekly', weekdays: [1], time: '09:00' }, timezone: 'Europe/London', paused: false,
  nextRunAt: '2026-10-05T08:00:00.000Z', lastRun: null, createdBy: null, createdAt: '2026-10-01T00:00:00.000Z',
};
const LAST = { adhocId: 'adhoc:abc', key: 'ADHOC-ABC', runId: 'run_1', state: 'succeeded' as const, deliveryOutcome: null, skipped: false, at: '2026-10-01T08:00:00.000Z' };
const FORM: RecurringForm = { title: 'Bump dependencies', body: '', repoId: '1', timezone: 'Europe/London', schedule: DEFAULT_SCHEDULE_FORM };

test('each schedule kind survives the round trip through the form', () => {
  const kinds: Schedule[] = [
    { kind: 'daily', time: '07:30' },
    { kind: 'weekly', weekdays: [1, 3, 5], time: '09:00' },
    { kind: 'monthly', day: 31, time: '23:59' },
  ];
  for (const s of kinds) {
    assert.deepEqual(formToSchedule(scheduleToForm(s)), s);
    assert.ok(scheduleSchema.safeParse(formToSchedule(scheduleToForm(s))).success);
  }
});

test('switching kind keeps what was typed for the others', () => {
  const f = scheduleToForm({ kind: 'monthly', day: 15, time: '10:00' });
  assert.deepEqual(formToSchedule({ ...f, kind: 'weekly' }), { kind: 'weekly', weekdays: DEFAULT_SCHEDULE_FORM.weekdays, time: '10:00' });
  assert.deepEqual(formToSchedule({ ...f, kind: 'daily' }), { kind: 'daily', time: '10:00' });
  // Weekdays come out sorted and deduplicated, as the schema stores them.
  assert.deepEqual(formToSchedule({ ...f, kind: 'weekly', weekdays: [5, 1, 5] }), { kind: 'weekly', weekdays: [1, 5], time: '10:00' });
});

test('a weekly schedule with no weekday is rejected', () => {
  assert.match(recurringFormProblem({ ...FORM, schedule: { ...DEFAULT_SCHEDULE_FORM, kind: 'weekly', weekdays: [] } })!, /at least one weekday/);
  // ...but the same empty list doesn't matter once the kind is daily.
  assert.equal(recurringFormProblem({ ...FORM, schedule: { ...DEFAULT_SCHEDULE_FORM, kind: 'daily', weekdays: [] } }), null);
});

test('the form needs a title, a repository, a time, a valid day and a zone', () => {
  assert.equal(recurringFormProblem(FORM), null);
  assert.match(recurringFormProblem({ ...FORM, title: '  ' })!, /title/);
  assert.match(recurringFormProblem({ ...FORM, repoId: '' })!, /repository/);
  assert.match(recurringFormProblem({ ...FORM, schedule: { ...DEFAULT_SCHEDULE_FORM, time: '' } })!, /time/);
  assert.match(recurringFormProblem({ ...FORM, schedule: { ...DEFAULT_SCHEDULE_FORM, kind: 'monthly', day: 32 } })!, /1 to 31/);
  assert.match(recurringFormProblem({ ...FORM, timezone: '' })!, /time zone/);
});

test('no last run shows nothing; a fired run links to it with its state', () => {
  assert.equal(lastRunView(TASK), null);
  assert.deepEqual(lastRunView({ lastRun: LAST }), { label: 'Done', pill: 'succeeded', href: '/run/run_1' });
  assert.deepEqual(lastRunView({ lastRun: { ...LAST, runId: null, state: null } }), { label: 'Waiting to start', pill: '', href: '/dispatch/adhoc%3Aabc' });
});

test('a skipped last run says the previous run was still going, with no link', () => {
  const v = lastRunView({ lastRun: { ...LAST, runId: null, state: null, skipped: true } })!;
  assert.match(v.label, /skipped: previous run still going/i);
  assert.equal(v.href, null);
});

test('a paused task keeps its schedule; with no next run the time reads as a dash', () => {
  const paused = { ...TASK, paused: true, nextRunAt: null };
  assert.equal(formatNextRun(paused.nextRunAt, paused.timezone), '—');
  assert.deepEqual(formToSchedule(scheduleToForm(paused.schedule)), paused.schedule);
});

test('the next run is shown in the task’s own zone', () => {
  assert.match(formatNextRun('2026-10-05T08:00:00.000Z', 'Europe/London'), /Mon.*5 Oct.*9:00/);
  assert.match(formatNextRun('2026-10-05T08:00:00.000Z', 'Asia/Tokyo'), /Mon.*5 Oct.*5:00/);
});

test('an empty list has nothing to show for any task', () => {
  const tasks: RecurringTask[] = [];
  assert.deepEqual(tasks.map(lastRunView), []);
});

test('a title over the max length is rejected', () => {
  assert.equal(recurringFormProblem({ ...FORM, title: 'x'.repeat(TITLE_MAX) }), null);
  assert.match(recurringFormProblem({ ...FORM, title: 'x'.repeat(TITLE_MAX + 1) })!, /200 characters/);
});

test('browserTimeZone returns a non-empty zone name to prefill the form', () => {
  assert.ok(browserTimeZone().length > 0);
});

test('a stored repoId matches its listed repository by native id; shown by path, else native id', () => {
  const repos = [{ id: 'gitlab:acme/web', path: 'acme/web' }, { id: 'gitlab:7', path: 'acme/api' }];
  assert.equal(findRepo(repos, '7')?.path, 'acme/api');
  assert.equal(findRepo(repos, 'gitlab:7')?.path, 'acme/api');
  assert.equal(findRepo(repos, '8'), null);
  assert.equal(repoOptionId(repos, '7'), 'gitlab:7', 'a bare stored id opens with the qualified option selected');
  assert.equal(repoOptionId(repos, 'gitlab:9'), 'gitlab:9');
  assert.equal(repoLabel(repos, 'gitlab:7'), 'acme/api');
  assert.equal(repoLabel(repos, 'gitlab:acme/gone'), 'acme/gone');
});
