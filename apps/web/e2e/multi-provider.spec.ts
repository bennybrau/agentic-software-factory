import { test, expect, type Page, type Route } from '@playwright/test';

/**
 * Several trackers and code hosts (M12 WP5b), in a real browser against a stubbed
 * api: the repository pickers group by host, the badges say which host and
 * tracker, nothing scrolls sideways at 375px, and the badges follow a change in
 * the connections without a reload. Screenshots land in e2e/screenshots/.
 */

type Conns = { tickets: string[]; scm: string[] };
const SEVERAL: Conns = { tickets: ['jira', 'github'], scm: ['github', 'gitlab'] };
const ONE: Conns = { tickets: ['jira'], scm: ['github'] };

const REPOS = [
  { id: 'github:acme/web', path: 'acme/web' },
  { id: 'gitlab:acme/web', path: 'acme/web' },
  { id: 'gitlab:acme/platform/shared-ui', path: 'acme/platform/shared-ui' },
];
const now = new Date().toISOString();
const ticket = (id: string, key: string, connection: string, title: string) => ({
  id, key, connection, title, bucket: 'todo', priority: null, status: 'To Do', url: `https://example.test/${key}`, body: '', updatedAt: now,
});
const TICKETS = [
  ticket('jira:PROJ-1', 'PROJ-1', 'jira', 'Header overlaps on the pricing page'),
  ticket('github:acme/web#3', 'acme/web#3', 'github', 'Totals are off by one'),
];
const run = {
  id: 'run_1', ticketId: 'PROJ-1', ticketKey: 'PROJ-1', ticketProvider: 'jira', state: 'succeeded', teamName: 'standard',
  team: { name: 'standard', roles: [] }, gates: {}, repoId: 'gitlab:acme/web', worktreePath: null, branchName: 'agent/PROJ-1',
  changeRequestUrl: 'https://gitlab.com/acme/web/-/merge_requests/12', changeRequestNumber: 12, changeRequestState: 'merged',
  deliveryOutcome: 'merged', costUsd: 1.23, maxCostUsd: 15, reviewIterations: 0, dispatchedBy: 'ann', reason: null,
  createdAt: now, startedAt: now, lastEventAt: now, cancelRequestedAt: null, finishedAt: now,
};
const runs = [run, { ...run, id: 'run_2', ticketId: 'acme/web#3', ticketKey: 'acme/web#3', ticketProvider: 'github', repoId: 'github:acme/web' }];

/** Answer every `/api/**` call from `conns`; the caller may change `conns` mid-test. */
async function stubApi(page: Page, state: { conns: Conns }) {
  const ok = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route(/\/(api\/.*|health)(\?.*)?$/, (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    const { conns } = state;
    const repos = REPOS.filter((r) => conns.scm.some((c) => r.id.startsWith(`${c}:`)));
    // All asks each tracker on its own (`?connection=jira`).
    const asked = url.searchParams.get('connection')?.split(',') ?? conns.tickets;
    const tickets = TICKETS.filter((t) => conns.tickets.includes(t.connection) && asked.includes(t.connection));
    if (p === '/api/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': stub\n\n' });
    if (p === '/api/connections') return ok(route, conns);
    if (p === '/api/me') return ok(route, { user: 'ann', verified: true, mode: 'trusted' });
    if (p === '/api/tickets') return ok(route, { tickets, sources: asked.map((c) => ({ connection: c, ok: true })) });
    if (p === '/api/start-readiness') return ok(route, { ok: true, repos });
    if (p === '/api/tickets/repo-preview') {
      const ids = (route.request().postDataJSON() as { ids: string[] }).ids;
      return ok(route, { repos, previews: ids.map((id) => ({ ticketId: id, repoId: null, reason: 'Choose which repository it should change.', mentionedRepoIds: [] })) });
    }
    if (p.endsWith('/dispatch')) {
      return ok(route, {
        ticket: TICKETS[0], team: {}, gates: {}, repos, suggestedRepoId: repos.at(-1)!.id,
        suggestedRepoReason: conns.scm.length > 1 ? 'The ticket title mentions shared-ui on GitLab.' : null,
        mentionedRepoIds: [], whyNot: [], blocker: null, models: [], runtimes: [], defaultModels: {}, defaultRuntimes: {}, efforts: [], defaultEfforts: {},
      });
    }
    if (p.startsWith('/api/tickets/')) return ok(route, TICKETS[0]);
    if (p === '/api/runs') return ok(route, { runs, total: runs.length });
    if (p === '/api/runs/run_1') return ok(route, { run, tasks: [], gates: [], artifacts: [], messages: [] });
    if (p === '/api/today') return ok(route, { waitingOnYou: [], running: [], queued: [], refused: [], doneToday: [], comingUp: [] });
    if (p === '/api/queue') return ok(route, { entries: [] });
    if (p === '/api/fleet') return ok(route, { workers: [], monthCostUsd: 0 });
    if (p === '/api/notifications') return ok(route, { notifications: [], unread: 0 });
    if (p === '/api/setup/status') return ok(route, { items: [], complete: true });
    if (p === '/api/adhoc') return ok(route, { tasks: [] });
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not_stubbed"}' });
  });
}

/** Nothing on the page is wider than the viewport. */
async function noSidewaysScroll(page: Page) {
  const width = page.viewportSize()!.width;
  const scroll = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scroll).toBeLessThanOrEqual(width);
}

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}-${test.info().project.name}.png`, fullPage: true });

for (const [label, conns] of [['several', SEVERAL], ['one-of-each', ONE]] as const) {
  test.describe(label, () => {
    test.beforeEach(async ({ page }) => { await stubApi(page, { conns }); });

    test('Start: the repository picker groups by host and says which', async ({ page }) => {
      await page.goto('/dispatch/jira%3APROJ-1');
      const select = page.locator('.repo-select select').first();
      await expect(select).toBeVisible();
      if (conns === SEVERAL) {
        await expect(select.locator('optgroup')).toHaveCount(2);
        await expect(select.locator('optgroup').first()).toHaveAttribute('label', 'GitHub');
        await expect(page.locator('.repo-select .pill.source').first()).toHaveText('GitLab');
      } else {
        await expect(select.locator('optgroup')).toHaveCount(0);
        await expect(page.locator('.repo-select .pill.source')).toHaveCount(0);
      }
      await noSidewaysScroll(page);
      await shot(page, `start-${label}`);
    });

    test('Planned tasks: the confirm panel groups each picker by host', async ({ page }) => {
      await page.goto('/backlog');
      const rows = page.locator('tbody input[type="checkbox"]');
      await expect(rows.first()).toBeVisible();
      if (conns === ONE) {
        // One repository: nothing to confirm, so the panel never opens. Just the list.
        await noSidewaysScroll(page);
        return shot(page, `planned-${label}`);
      }
      for (const box of await rows.all()) await box.check();
      await page.getByRole('button', { name: 'Start all at once' }).click();
      const panel = page.locator('.queue-confirm');
      await expect(panel).toBeVisible();
      await expect(panel.locator('optgroup[label="GitLab"]').first()).toBeAttached();
      await panel.getByLabel('Repository for PROJ-1').selectOption('gitlab:acme/web');
      await expect(panel.locator('.pill.source', { hasText: 'GitLab' })).toBeVisible();
      await noSidewaysScroll(page);
      await shot(page, `confirm-${label}`);
    });

    test('Run: the tracker after the key and the host beside the change request', async ({ page }) => {
      await page.goto('/run/run_1');
      await expect(page.locator('.run-title')).toBeVisible();
      const badges = page.locator('.pill.source');
      if (conns === SEVERAL) {
        await expect(page.locator('.run-key .pill.source')).toHaveText('Jira');
        await expect(badges.filter({ hasText: 'GitLab' })).toBeVisible();
      } else {
        await expect(badges).toHaveCount(0);
      }
      await noSidewaysScroll(page);
      await shot(page, `run-${label}`);
    });

    test('Activity: each run names its tracker', async ({ page }) => {
      await page.goto('/runs');
      await expect(page.getByText('acme/web#3')).toBeVisible();
      if (conns === SEVERAL) {
        await expect(page.locator('tbody .pill.source')).toHaveText(['Jira', 'GitHub']);
      } else {
        await expect(page.locator('tbody .pill.source')).toHaveCount(0);
      }
      await noSidewaysScroll(page);
      await shot(page, `activity-${label}`);
    });
  });
}

test('the badges appear when a second tracker and host are connected, without a reload', async ({ page }) => {
  const state = { conns: ONE };
  await stubApi(page, state);
  await page.clock.install();
  await page.goto('/run/run_1');
  await expect(page.locator('.run-title')).toBeVisible();
  await expect(page.locator('.pill.source')).toHaveCount(0);
  state.conns = SEVERAL;
  await page.clock.runFor(31_000); // the shared ['connections'] query re-reads every 30s
  await expect(page.locator('.run-key .pill.source')).toHaveText('Jira');
  await expect(page.locator('.pill.source', { hasText: 'GitLab' })).toBeVisible();
});
