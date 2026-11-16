import { test, expect, type Page, type Route } from '@playwright/test';

/**
 * Move to another repo on the run page (M10 WP5), in a real browser against a stubbed
 * api: the planner is asking, so the card is up; pick a repo, Confirm, and the call
 * carries it; a refusal shows inline; nothing scrolls sideways at 375px.
 */

const now = new Date().toISOString();
const run = {
  id: 'run_1', ticketId: 'PROJ-1', ticketKey: 'PROJ-1', ticketProvider: 'jira', state: 'awaiting_checkpoint', teamName: 'standard',
  team: { name: 'standard', roles: [] }, gates: {}, repoId: 'github:acme/web', worktreePath: null, branchName: null,
  changeRequestUrl: null, changeRequestNumber: null, changeRequestState: null, deliveryOutcome: null, costUsd: 0.4, maxCostUsd: 15,
  reviewIterations: 0, dispatchedBy: 'ann', reason: null, createdAt: now, startedAt: now, lastEventAt: now, cancelRequestedAt: null, finishedAt: null,
};
const planner = { id: 't_1', runId: 'run_1', role: 'planner', seq: 1, attempt: 1, state: 'needs_human', reason: 'Which repository holds the billing code?',
  runtime: 'claude-code', model: 'claude-opus-5-5', costUsd: 0.4, startedAt: now, finishedAt: now };
const repos = [{ id: 'github:acme/web', path: 'acme/web' }, { id: 'gitlab:acme/platform/api/billing-service-with-a-long-name', path: 'acme/platform/api/billing-service-with-a-long-name' }];

async function stubApi(page: Page, move: { status: number; body: unknown }, posted: unknown[]) {
  const ok = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route(/\/(api\/.*|health)(\?.*)?$/, (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === '/api/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': stub\n\n' });
    if (p === '/api/connections') return ok(route, { tickets: ['jira'], scm: ['github', 'gitlab'] });
    if (p === '/api/me') return ok(route, { user: 'ann', verified: true, mode: 'trusted' });
    if (p === '/api/start-readiness') return ok(route, { ok: true, repos });
    if (p === '/api/runs/run_1/move') {
      posted.push(route.request().postDataJSON());
      return route.fulfill({ status: move.status, contentType: 'application/json', body: JSON.stringify(move.body) });
    }
    if (p === '/api/runs/run_1') return ok(route, { run, tasks: [planner], gates: [], artifacts: [], messages: [] });
    if (p === '/api/notifications') return ok(route, { notifications: [], unread: 0 });
    if (p === '/api/fleet') return ok(route, { workers: [], monthCostUsd: 0 });
    if (p === '/api/setup/status') return ok(route, { items: [], complete: true });
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not_stubbed"}' });
  });
}

async function noSidewaysScroll(page: Page) {
  const width = page.viewportSize()!.width;
  const scroll = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scroll).toBeLessThanOrEqual(width);
}
const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}-${test.info().project.name}.png`, fullPage: true });

test('the planner asks: move the run to another repo, with a note and a Confirm step', async ({ page }) => {
  const posted: unknown[] = [];
  await stubApi(page, { status: 200, body: { ok: true } }, posted);
  await page.goto('/run/run_1');
  await expect(page.locator('.repo-line')).toContainText('acme/web');
  await expect(page.locator('.repo-line .pill.source')).toHaveText('GitHub');
  const card = page.locator('.move-repo');
  await card.getByRole('button', { name: 'Move to another repo' }).click();
  await card.getByLabel('Move to repository').selectOption('gitlab:acme/platform/api/billing-service-with-a-long-name');
  await card.getByLabel('Why move').fill('billing lives in the API');
  await noSidewaysScroll(page);
  await shot(page, 'move-form');
  await card.getByRole('button', { name: 'Move…' }).click();
  await expect(card).toContainText('Move this run to acme/platform/api/billing-service-with-a-long-name');
  await noSidewaysScroll(page);
  await shot(page, 'move-confirm');
  await card.getByRole('button', { name: 'Confirm' }).click();
  await expect.poll(() => posted).toEqual([{ repoId: 'gitlab:acme/platform/api/billing-service-with-a-long-name', note: 'billing lives in the API' }]);
});

test('a refused move says why, inline', async ({ page }) => {
  await stubApi(page, { status: 409, body: { error: 'move_refused', reason: 'run run_1 has a task running, wait for it to finish' } }, []);
  await page.goto('/run/run_1');
  const card = page.locator('.move-repo');
  await card.getByRole('button', { name: 'Move to another repo' }).click();
  await card.getByLabel('Move to repository').selectOption('gitlab:acme/platform/api/billing-service-with-a-long-name');
  await card.getByRole('button', { name: 'Move…' }).click();
  await card.getByRole('button', { name: 'Confirm' }).click();
  await expect(card).toContainText('has a task running, wait for it to finish');
  await noSidewaysScroll(page);
  await shot(page, 'move-refused');
});
