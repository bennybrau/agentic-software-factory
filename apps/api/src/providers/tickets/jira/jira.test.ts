import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  JiraTicketProvider, bucketOf, priorityOf, parseJiraBucketMap, parseJiraTeams, jqlQuote, renderJql,
  type JiraTicketConfig,
} from './jira.js';

// --- recorded fixtures (trimmed real Jira REST v3 shapes) ---
// An ADF description with one paragraph the codec CAN represent and a table it
// cannot (held aside as a preserved block).
const ADF_DESC = {
  type: 'doc',
  version: 1,
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Add a token bucket.' }] },
    {
      type: 'table',
      attrs: { isNumberColumnEnabled: false, layout: 'default' },
      content: [{
        type: 'tableRow',
        content: [
          { type: 'tableHeader', attrs: {}, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Limit' }] }] },
          { type: 'tableCell', attrs: {}, content: [{ type: 'paragraph', content: [{ type: 'text', text: '100/min' }] }] },
        ],
      }],
    },
  ],
};

const ISSUE = {
  id: '10042',
  key: 'SWL-42',
  fields: {
    summary: 'Add rate limiting to the API',
    description: ADF_DESC,
    updated: '2026-09-14T12:00:00.000+0000',
    labels: ['backend', 'agent'],
    status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
    priority: { name: 'High' },
    assignee: { displayName: 'Octo Cat', emailAddress: 'octo@acme.test' },
    parent: { key: 'SWL-1' },
    subtasks: [{ key: 'SWL-43' }, { key: 'SWL-44' }],
    project: { key: 'SWL', name: 'Swirl' },
  },
};

const cfg = (over: Partial<JiraTicketConfig> = {}): JiraTicketConfig => ({
  baseUrl: 'https://acme.atlassian.net',
  email: 'bot@acme.test',
  apiToken: 't',
  projects: ['SWL', 'OO'],
  boards: [],
  teams: [],
  jqlTemplate: 'project in ({{projects}}) ORDER BY updated DESC',
  bucketMap: parseJiraBucketMap('In Progress=inflight,In Review=review'),
  ...over,
});

// Stub global.fetch with a router over method+path; returns recorded JSON.
function stubFetch(routes: Array<{ m: string; re: RegExp; status?: number; json?: unknown; text?: string }>) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const r = routes.find((x) => x.m === method && x.re.test(String(url)));
    if (!r) throw new Error(`no stub for ${method} ${url}`);
    return {
      ok: (r.status ?? 200) < 400, status: r.status ?? 200,
      json: async () => r.json, text: async () => r.text ?? JSON.stringify(r.json),
    } as Response;
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

// ---------------------------------------------------------------- pure logic
test('parseJiraBucketMap parses status=bucket rules and drops invalid buckets', () => {
  assert.deepEqual(parseJiraBucketMap('In Review=review, Foo=nonsense, Blocked=blocked'),
    [{ status: 'In Review', bucket: 'review' }, { status: 'Blocked', bucket: 'blocked' }]);
  assert.deepEqual(parseJiraBucketMap(''), []);
});

test('parseJiraTeams parses "name=id,id; name=id" board groups and drops invalid parts', () => {
  assert.deepEqual(parseJiraTeams('payments=42,43; identity=51'),
    [{ team: 'payments', boards: ['42', '43'] }, { team: 'identity', boards: ['51'] }]);
  assert.deepEqual(parseJiraTeams('nogroup; =7; team='), []);
  assert.deepEqual(parseJiraTeams(''), []);
});

test('jqlQuote escapes backslashes and quotes', () => {
  assert.equal(jqlQuote('SWL'), '"SWL"');
  assert.equal(jqlQuote('a"b\\c'), '"a\\"b\\\\c"');
});

test('renderJql expands {{projects}} to quoted comma-joined keys', () => {
  assert.equal(renderJql('project in ({{projects}}) ORDER BY updated DESC', ['SWL', 'OO']),
    'project in ("SWL", "OO") ORDER BY updated DESC');
  // No projects → empty list, but the template shape is preserved (caller's problem to bound).
  assert.equal(renderJql('assignee = currentUser()', []), 'assignee = currentUser()');
});

test('bucketOf: status rule wins, else statusCategory maps new/indeterminate/done', () => {
  const map = parseJiraBucketMap('In Progress=inflight');
  assert.equal(bucketOf({ name: 'In Progress', statusCategory: { key: 'indeterminate' } }, map), 'inflight');
  // rule miss → fall back to category
  assert.equal(bucketOf({ name: 'To Do', statusCategory: { key: 'new' } }, map), 'backlog');
  assert.equal(bucketOf({ name: 'Reviewing', statusCategory: { key: 'indeterminate' } }, map), 'inflight');
  assert.equal(bucketOf({ name: 'Done', statusCategory: { key: 'done' } }, map), 'done');
  // case-insensitive rule match
  assert.equal(bucketOf({ name: 'in progress' }, map), 'inflight');
  assert.equal(bucketOf(null, map), 'backlog');
});

test('priorityOf maps Jira default priority names to 1..5, unknown→null', () => {
  assert.equal(priorityOf({ name: 'Highest' }), 1);
  assert.equal(priorityOf({ name: 'High' }), 2);
  assert.equal(priorityOf({ name: 'Medium' }), 3);
  assert.equal(priorityOf({ name: 'Low' }), 4);
  assert.equal(priorityOf({ name: 'Lowest' }), 5);
  assert.equal(priorityOf({ name: 'P1-Critical' }), null);
  assert.equal(priorityOf(null), null);
});

// ----------------------------------------------------- provider over stubbed fetch
test('list walks JQL pages, maps issues to tickets, applies bucket filter', async () => {
  const closed = { ...ISSUE, id: '10007', key: 'SWL-7', fields: { ...ISSUE.fields, summary: 'Old', status: { name: 'Done', statusCategory: { key: 'done' } }, updated: '2026-09-01T00:00:00.000+0000' } };
  const s = stubFetch([
    // first page carries a token, second page is last
    { m: 'GET', re: /\/rest\/api\/3\/search\/jql\?(?!.*nextPageToken)/, json: { issues: [ISSUE], nextPageToken: 'tok2' } },
    { m: 'GET', re: /\/rest\/api\/3\/search\/jql\?.*nextPageToken=tok2/, json: { issues: [closed], isLast: true } },
  ]);
  try {
    const p = new JiraTicketProvider(cfg());
    const { tickets } = await p.list({ scope: ['SWL'], limit: 50 });
    assert.equal(tickets.length, 2, 'both pages fetched');
    const open = tickets.find((t) => t.key === 'SWL-42')!;
    assert.equal(open.id, 'SWL-42');
    assert.equal(open.url, 'https://acme.atlassian.net/browse/SWL-42');
    assert.equal(open.bucket, 'inflight');
    assert.equal(open.priority, 2);
    assert.equal(open.assignee, 'Octo Cat');
    assert.equal(open.parentId, 'SWL-1');
    assert.deepEqual(open.children, ['SWL-43', 'SWL-44']);
    // the ADF table the editing grammar can't spell is shown as a readable
    // table, not as a ⟦jira-block-N⟧ token (DCP-15671: tokens hid the text)
    assert.match(open.body, /Add a token bucket\./);
    assert.doesNotMatch(open.body, /jira-block|⟦/);
    assert.match(open.body, /\| Limit \| 100\/min \|/);

    // the JQL the walk sent was rendered from the template + scope
    const firstUrl = s.calls[0]!.url;
    assert.match(decodeURIComponent(firstUrl).replace(/\+/g, ' '), /project in \("SWL"\) ORDER BY updated DESC/);

    const done = await p.list({ scope: ['SWL'], bucket: ['done'], limit: 50 });
    assert.deepEqual(done.tickets.map((t) => t.key), ['SWL-7']);
  } finally { s.restore(); }
});

test('list uses the Agile board endpoints when boards are configured, paging by startAt', async () => {
  const two = { ...ISSUE, id: '10043', key: 'SWL-99', fields: { ...ISSUE.fields, summary: 'Second', updated: '2026-09-20T00:00:00.000+0000' } };
  const s = stubFetch([
    // board 42: two pages (total 2, page size stubbed via the response total)
    { m: 'GET', re: /\/rest\/agile\/1\.0\/board\/42\/issue\?.*startAt=0/, json: { startAt: 0, total: 2, issues: [ISSUE] } },
    { m: 'GET', re: /\/rest\/agile\/1\.0\/board\/42\/issue\?.*startAt=1/, json: { startAt: 1, total: 2, issues: [two] } },
  ]);
  try {
    const p = new JiraTicketProvider(cfg({ boards: ['42'] }));
    const { tickets } = await p.list({ scope: [], limit: 50 });
    assert.deepEqual(tickets.map((t) => t.key).sort(), ['SWL-42', 'SWL-99']);
    // it never touched the platform search endpoint
    assert.equal(s.calls.some((c) => /\/search\/jql/.test(c.url)), false);
  } finally { s.restore(); }
});

test('list scope narrows the configured boards to the requested subset', async () => {
  const s = stubFetch([
    { m: 'GET', re: /\/rest\/agile\/1\.0\/board\/51\/issue\?.*startAt=0/, json: { startAt: 0, total: 1, issues: [ISSUE] } },
  ]);
  try {
    // configured boards are 42,51 but scope asks only for 51
    const p = new JiraTicketProvider(cfg({ boards: ['42', '51'] }));
    const { tickets } = await p.list({ scope: ['51'], limit: 50 });
    assert.deepEqual(tickets.map((t) => t.key), ['SWL-42']);
    assert.equal(s.calls.every((c) => /board\/51\//.test(c.url)), true, 'only board 51 was queried');
  } finally { s.restore(); }
});

test('list ignores a scope id that is not a configured board and falls back to all configured boards', async () => {
  const s = stubFetch([
    { m: 'GET', re: /\/rest\/agile\/1\.0\/board\/42\/issue\?/, json: { startAt: 0, total: 1, issues: [ISSUE] } },
  ]);
  try {
    // A stale 'DCP' (a project key, not a board) must never reach /board/DCP/issue.
    const p = new JiraTicketProvider(cfg({ boards: ['42'] }));
    const { tickets } = await p.list({ scope: ['DCP'], limit: 50 });
    assert.deepEqual(tickets.map((t) => t.key), ['SWL-42']);
    assert.equal(s.calls.some((c) => /\/board\/DCP\//.test(c.url)), false, 'never queried the bogus board id');
    assert.equal(s.calls.every((c) => /\/board\/42\//.test(c.url)), true, 'fell back to the configured board');
  } finally { s.restore(); }
});

test('list dedupes an issue that appears on more than one scoped board', async () => {
  const s = stubFetch([
    { m: 'GET', re: /\/rest\/agile\/1\.0\/board\/42\/issue\?.*startAt=0/, json: { startAt: 0, total: 1, issues: [ISSUE] } },
    { m: 'GET', re: /\/rest\/agile\/1\.0\/board\/51\/issue\?.*startAt=0/, json: { startAt: 0, total: 1, issues: [ISSUE] } },
  ]);
  try {
    const p = new JiraTicketProvider(cfg({ boards: ['42', '51'] }));
    const { tickets } = await p.list({ scope: [], limit: 50 });
    assert.deepEqual(tickets.map((t) => t.key), ['SWL-42'], 'the shared issue appears once');
  } finally { s.restore(); }
});

test('list pushes a status filter down to the Agile jql= param (filtering happens in Jira)', async () => {
  const s = stubFetch([
    { m: 'GET', re: /\/rest\/agile\/1\.0\/board\/42\/issue\?/, json: { startAt: 0, total: 1, issues: [ISSUE] } },
  ]);
  try {
    const p = new JiraTicketProvider(cfg({ boards: ['42'] }));
    await p.list({ scope: [], status: ['In Progress', 'In Review'], limit: 50 });
    const url = decodeURIComponent(s.calls[0]!.url).replace(/\+/g, ' ');
    assert.match(url, /jql=status in \("In Progress", "In Review"\)/);
  } finally { s.restore(); }
});

test('list excludeDone pushes statusCategory != Done down and drops any done-bucket issue returned', async () => {
  const done = { ...ISSUE, id: '10009', key: 'SWL-9', fields: { ...ISSUE.fields, status: { name: 'Done', statusCategory: { key: 'done' } } } };
  const s = stubFetch([
    { m: 'GET', re: /\/rest\/agile\/1\.0\/board\/42\/issue\?/, json: { startAt: 0, total: 2, issues: [ISSUE, done] } },
  ]);
  try {
    const p = new JiraTicketProvider(cfg({ boards: ['42'] }));
    const { tickets } = await p.list({ scope: [], excludeDone: true, limit: 50 });
    assert.match(decodeURIComponent(s.calls[0]!.url).replace(/\+/g, ' '), /jql=statusCategory != Done/);
    assert.deepEqual(tickets.map((t) => t.key), ['SWL-42'], 'the done issue is filtered out client-side too');
  } finally { s.restore(); }
});

test('list updatedWithinDays pushes an updated>= window into the Agile jql', async () => {
  const s = stubFetch([
    { m: 'GET', re: /\/rest\/agile\/1\.0\/board\/42\/issue\?/, json: { startAt: 0, total: 1, issues: [ISSUE] } },
  ]);
  try {
    const p = new JiraTicketProvider(cfg({ boards: ['42'] }));
    await p.list({ scope: [], excludeDone: false, updatedWithinDays: 7, limit: 50 });
    assert.match(decodeURIComponent(s.calls[0]!.url).replace(/\+/g, ' '), /jql=updated >= -7d/);
  } finally { s.restore(); }
});

test('list does not request the description field for the backlog list (lighter payload)', async () => {
  const s = stubFetch([
    { m: 'GET', re: /\/rest\/agile\/1\.0\/board\/42\/issue\?/, json: { startAt: 0, total: 1, issues: [ISSUE] } },
  ]);
  try {
    await new JiraTicketProvider(cfg({ boards: ['42'] })).list({ scope: [], limit: 50 });
    const fields = new URL(s.calls[0]!.url).searchParams.get('fields') ?? '';
    assert.equal(fields.includes('description'), false, 'list omits description');
    assert.equal(fields.includes('summary'), true, 'but keeps summary');
  } finally { s.restore(); }
});

test('list sprint=active queries the board issues with sprint in openSprints() (ANDed with status)', async () => {
  const s = stubFetch([
    { m: 'GET', re: /\/rest\/agile\/1\.0\/board\/42\/issue\?/, json: { startAt: 0, total: 1, issues: [ISSUE] } },
  ]);
  try {
    const p = new JiraTicketProvider(cfg({ boards: ['42'] }));
    await p.list({ scope: [], sprint: ['active'], status: ['In Progress'], limit: 50 });
    const url = decodeURIComponent(s.calls[0]!.url).replace(/\+/g, ' ');
    assert.match(url, /jql=sprint in openSprints\(\) AND status in \("In Progress"\)/);
  } finally { s.restore(); }
});

test('list sprint=backlog reads the board backlog endpoint', async () => {
  const s = stubFetch([
    { m: 'GET', re: /\/rest\/agile\/1\.0\/board\/42\/backlog\?/, json: { startAt: 0, total: 1, issues: [ISSUE] } },
  ]);
  try {
    const p = new JiraTicketProvider(cfg({ boards: ['42'] }));
    const { tickets } = await p.list({ scope: [], sprint: ['backlog'], limit: 50 });
    assert.deepEqual(tickets.map((t) => t.key), ['SWL-42']);
  } finally { s.restore(); }
});

test('list sprint=<id> reads that sprint\'s issues', async () => {
  const s = stubFetch([
    { m: 'GET', re: /\/rest\/agile\/1\.0\/board\/42\/sprint\/9\/issue\?/, json: { startAt: 0, total: 1, issues: [ISSUE] } },
  ]);
  try {
    const p = new JiraTicketProvider(cfg({ boards: ['42'] }));
    const { tickets } = await p.list({ scope: [], sprint: ['9'], limit: 50 });
    assert.deepEqual(tickets.map((t) => t.key), ['SWL-42']);
  } finally { s.restore(); }
});

test('list ignores sprint when more than one board is scoped (sprint is per-board)', async () => {
  const s = stubFetch([
    { m: 'GET', re: /\/rest\/agile\/1\.0\/board\/42\/issue\?/, json: { startAt: 0, total: 1, issues: [ISSUE] } },
    { m: 'GET', re: /\/rest\/agile\/1\.0\/board\/51\/issue\?/, json: { startAt: 0, total: 0, issues: [] } },
  ]);
  try {
    const p = new JiraTicketProvider(cfg({ boards: ['42', '51'] }));
    await p.list({ scope: [], sprint: ['9'], limit: 50 });
    // it used the plain board issue endpoints, never a sprint endpoint
    assert.equal(s.calls.some((c) => /\/sprint\/9\//.test(c.url)), false);
  } finally { s.restore(); }
});

test('listScopes returns the configured boards with name/type and team annotation', async () => {
  const s = stubFetch([
    { m: 'GET', re: /\/rest\/agile\/1\.0\/board\/42$/, json: { id: 42, name: 'Payments Scrum', type: 'scrum' } },
    { m: 'GET', re: /\/rest\/agile\/1\.0\/board\/51$/, json: { id: 51, name: 'Ops Kanban', type: 'kanban' } },
  ]);
  try {
    const p = new JiraTicketProvider(cfg({ boards: ['42', '51'], teams: parseJiraTeams('payments=42') }));
    const scopes = await p.listScopes();
    assert.deepEqual(scopes, [
      { id: '42', name: 'Payments Scrum', kind: 'board', boardType: 'scrum', team: 'payments' },
      { id: '51', name: 'Ops Kanban', kind: 'board', boardType: 'kanban' },
    ]);
  } finally { s.restore(); }
});

test('listScopes falls back to the configured projects when no boards are set', async () => {
  const s = stubFetch([
    { m: 'GET', re: /\/rest\/api\/3\/project\/SWL$/, json: { key: 'SWL', name: 'Swirl' } },
    { m: 'GET', re: /\/rest\/api\/3\/project\/OO$/, json: { key: 'OO', name: 'Odd One' } },
  ]);
  try {
    const scopes = await new JiraTicketProvider(cfg()).listScopes();
    assert.deepEqual(scopes, [
      { id: 'SWL', name: 'Swirl', kind: 'project' },
      { id: 'OO', name: 'Odd One', kind: 'project' },
    ]);
  } finally { s.restore(); }
});

test('listSprints maps sprint state and pages a board', async () => {
  const s = stubFetch([
    { m: 'GET', re: /\/rest\/agile\/1\.0\/board\/42\/sprint\?/, json: {
      isLast: true, total: 3, values: [
        { id: 9, name: 'Sprint 9', state: 'active', originBoardId: 42 },
        { id: 10, name: 'Sprint 10', state: 'future' },
        { id: 8, name: 'Sprint 8', state: 'closed' },
      ],
    } },
  ]);
  try {
    const sprints = await new JiraTicketProvider(cfg({ boards: ['42'] })).listSprints('42');
    assert.deepEqual(sprints, [
      { id: '9', name: 'Sprint 9', state: 'active', boardId: '42' },
      { id: '10', name: 'Sprint 10', state: 'future', boardId: '42' },
      { id: '8', name: 'Sprint 8', state: 'closed', boardId: '42' },
    ]);
  } finally { s.restore(); }
});

test('listStatuses returns unique status names, sorted', async () => {
  const s = stubFetch([
    { m: 'GET', re: /\/rest\/api\/3\/status$/, json: [
      { name: 'In Review' }, { name: 'To Do' }, { name: 'In Review' }, { name: 'Done' },
    ] },
  ]);
  try {
    const statuses = await new JiraTicketProvider(cfg()).listStatuses();
    assert.deepEqual(statuses, ['Done', 'In Review', 'To Do']);
  } finally { s.restore(); }
});

test('get fetches one issue and maps id/key/url', async () => {
  const s = stubFetch([{ m: 'GET', re: /\/rest\/api\/3\/issue\/SWL-42\?/, json: ISSUE }]);
  try {
    const t = await new JiraTicketProvider(cfg()).get('SWL-42');
    assert.equal(t.id, 'SWL-42');
    assert.equal(t.key, 'SWL-42');
    assert.equal(t.url, 'https://acme.atlassian.net/browse/SWL-42');
    assert.equal(t.title, 'Add rate limiting to the API');
  } finally { s.restore(); }
});

test('update re-reads the description so a preserved block round-trips into the PUT', async () => {
  const s = stubFetch([
    { m: 'GET', re: /\/issue\/SWL-42\?fields=description$/, json: ISSUE },
    { m: 'PUT', re: /\/issue\/SWL-42\?notifyUsers=false$/, json: {} },
    { m: 'GET', re: /\/issue\/SWL-42\?fields=summary/, json: ISSUE },
  ]);
  try {
    // The caller edits only the paragraph, leaving the table token in place.
    await new JiraTicketProvider(cfg()).update('SWL-42', { body: 'Add a token bucket, 100/min.\n\n⟦jira-block-0: table⟧' });
    const put = s.calls.find((c) => c.method === 'PUT')!;
    const desc = (put.body as { fields: { description: { content: Array<{ type: string }> } } }).fields.description;
    // second block is the ORIGINAL table node, spliced back verbatim
    assert.equal(desc.content[1]!.type, 'table');
    assert.deepEqual(desc.content[1], ADF_DESC.content[1]);
  } finally { s.restore(); }
});

test('update refuses when a preserved block cannot be resolved (concurrent Jira edit)', async () => {
  // The issue as it stands now has NO table — the drawer still holds its token.
  const noTable = { ...ISSUE, fields: { ...ISSUE.fields, description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'changed' }] }] } } };
  const s = stubFetch([{ m: 'GET', re: /\/issue\/SWL-42\?fields=description$/, json: noTable }]);
  try {
    await assert.rejects(
      () => new JiraTicketProvider(cfg()).update('SWL-42', { body: '⟦jira-block-0: table⟧' }),
      /changed in Jira/,
    );
    // it never issued the PUT
    assert.equal(s.calls.filter((c) => c.method === 'PUT').length, 0);
  } finally { s.restore(); }
});

test('update priority maps 1..5 back to a Jira priority name', async () => {
  const s = stubFetch([
    { m: 'PUT', re: /\/issue\/SWL-42\?notifyUsers=false$/, json: {} },
    { m: 'GET', re: /\/issue\/SWL-42\?fields=summary/, json: ISSUE },
  ]);
  try {
    await new JiraTicketProvider(cfg()).update('SWL-42', { priority: 1 });
    const put = s.calls.find((c) => c.method === 'PUT')!;
    assert.deepEqual((put.body as { fields: { priority: unknown } }).fields.priority, { name: 'Highest' });
  } finally { s.restore(); }
});

test('comment posts an ADF body built from markdown', async () => {
  const s = stubFetch([{ m: 'POST', re: /\/issue\/SWL-42\/comment$/, json: { id: '90001' } }]);
  try {
    const r = await new JiraTicketProvider(cfg()).comment('SWL-42', 'Run **started** — see [the PR](https://gh.test/pr/2).');
    assert.equal(r.commentId, '90001');
    assert.match(r.url!, /focusedCommentId=90001/);
    const posted = (s.calls[0]!.body as { body: { type: string; content: unknown[] } }).body;
    assert.equal(posted.type, 'doc');
    // the bold + link marks made it into the ADF
    assert.match(JSON.stringify(posted), /"type":"strong"/);
    assert.match(JSON.stringify(posted), /"href":"https:\/\/gh.test\/pr\/2"/);
  } finally { s.restore(); }
});

test('listComments renders ADF bodies to text and names preserved blocks', async () => {
  const s = stubFetch([{
    m: 'GET', re: /\/issue\/SWL-42\/comment$/, json: {
      comments: [{ id: '1', author: { displayName: 'Ada' }, created: '2026-09-14T00:00:00.000+0000',
        body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'looks good' }] }] } }],
    },
  }]);
  try {
    const cs = await new JiraTicketProvider(cfg()).listComments('SWL-42');
    assert.equal(cs.length, 1);
    assert.equal(cs[0]!.author, 'Ada');
    assert.equal(cs[0]!.markdown, 'looks good');
  } finally { s.restore(); }
});

test('transitions are read live; transition posts the chosen id', async () => {
  const s = stubFetch([
    { m: 'GET', re: /\/issue\/SWL-42\/transitions$/, json: { transitions: [{ id: '31', name: 'In Review', to: { name: 'In Review' } }, { id: '41', name: 'Done', to: { name: 'Done' } }] } },
    { m: 'POST', re: /\/issue\/SWL-42\/transitions$/, json: {} },
  ]);
  try {
    const p = new JiraTicketProvider(cfg());
    const ts = await p.transitions('SWL-42');
    assert.deepEqual(ts, [{ id: '31', name: 'In Review', toStatus: 'In Review' }, { id: '41', name: 'Done', toStatus: 'Done' }]);
    await p.transition('SWL-42', '31');
    assert.deepEqual((s.calls.at(-1)!.body as { transition: unknown }).transition, { id: '31' });
  } finally { s.restore(); }
});

test('assign PUTs the accountId (Cloud assigns by accountId, not name)', async () => {
  const s = stubFetch([{ m: 'PUT', re: /\/issue\/SWL-42\/assignee$/, status: 204 }]);
  try {
    await new JiraTicketProvider(cfg()).assign('SWL-42', '557058:bot-account-id');
    assert.deepEqual(s.calls.at(-1)!.body, { accountId: '557058:bot-account-id' });
  } finally { s.restore(); }
});

test('assign(null) unassigns via accountId:null', async () => {
  const s = stubFetch([{ m: 'PUT', re: /\/issue\/SWL-42\/assignee$/, status: 204 }]);
  try {
    await new JiraTicketProvider(cfg()).assign('SWL-42', null);
    assert.deepEqual(s.calls.at(-1)!.body, { accountId: null });
  } finally { s.restore(); }
});

test('preflight fails clearly on empty config', async () => {
  assert.deepEqual(await new JiraTicketProvider(cfg({ baseUrl: '' })).preflight(), { ok: false, reason: 'JIRA_BASE_URL is empty' });
  assert.deepEqual(await new JiraTicketProvider(cfg({ apiToken: '' })).preflight(),
    { ok: false, reason: 'JIRA_EMAIL / JIRA_API_TOKEN is empty' });
});

test('preflight uses /myself (not search) so a dead token is a 401, not empty 200', async () => {
  const ok = stubFetch([{ m: 'GET', re: /\/rest\/api\/3\/myself$/, json: { accountId: 'a1', displayName: 'Bot' } }]);
  try {
    assert.deepEqual(await new JiraTicketProvider(cfg()).preflight(), { ok: true, identity: 'Bot' });
    assert.match(ok.calls[0]!.url, /\/rest\/api\/3\/myself$/);
  } finally { ok.restore(); }

  const dead = stubFetch([{ m: 'GET', re: /\/rest\/api\/3\/myself$/, status: 401, text: 'Unauthorized' }]);
  try {
    const r = await new JiraTicketProvider(cfg()).preflight();
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /401/);
  } finally { dead.restore(); }
});

test('capabilities: subtasks/priority/transitions/assignable yes, links no (Jira has no links field)', () => {
  assert.deepEqual(new JiraTicketProvider(cfg()).capabilities(), { subtasks: true, priority: true, links: false, transitions: true, assignable: true, boards: true, sprints: true, statuses: true });
});

test('suggestedRepo is null — a Jira ticket spans no natural repo', () => {
  assert.equal(new JiraTicketProvider(cfg()).suggestedRepo(), null);
});
