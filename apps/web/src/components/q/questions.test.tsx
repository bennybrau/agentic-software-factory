import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SettingsStore } from './ui';
import {
  aiQ, hiveQ, hiveEntries, ESSENTIALS, LATER, ticketsQ, codeQ, toggleConnection, makeDefault, ticketEntries, codeEntries,
  ticketCheck, codeCheck, type TicketDraft, type CodeDraft,
} from './questions';
import { api } from '../../api';
import { QUESTIONS, THEME_SLOTS, type ThemeSummaryWire } from '@asf/shared/ui';
import { ThemeCard } from '../ThemeSettings';

const store: SettingsStore = { byKey: {}, loaded: true, err: null, saveMany: async () => null, reload: () => {} };

// #136: the AI question offers only the three real choices; the disabled
// "Something else … coming soon" placeholder (Copilot/OpenAI-compat/DeepSeek) is gone.
test('#136 + M9: the AI question has exactly four, none-disabled choices, and mentions no unshipped provider', () => {
  const html = renderToStaticMarkup(<aiQ.Body store={store} actions={() => null} />);
  const titles = [...html.matchAll(/class="choice[^"]*"[^>]*><b>([^<]+)/g)].map((m) => m[1]);
  assert.deepEqual(titles, ['Claude API key', 'Claude subscription', 'Claude on Google Cloud', 'ChatGPT / OpenAI']);
  assert.ok(!/\bdisabled(=|>)/.test(html), 'no choice should render disabled when nothing is env-pinned');
  for (const bad of ['Something else', 'Copilot', 'DeepSeek', 'coming soon']) {
    assert.ok(!html.includes(bad), `unexpected "${bad}" in the AI question`);
  }
});

test('M9: the tip note says Vertex uses the host\'s Google login and Bedrock stays env-only', () => {
  assert.match(aiQ.tipNote!, /gcloud auth application-default login/);
  assert.match(aiQ.tipNote!, /Bedrock is set up in \.env only/);
});

const withSettings = (v: Record<string, string>): SettingsStore =>
  ({ ...store, byKey: Object.fromEntries(Object.entries(v).map(([k, value]) => [k, { key: k, value }])) as never });

test('the API key is the recommended Claude choice; a subscription is labelled personal use', () => {
  const html = renderToStaticMarkup(<aiQ.Body store={store} actions={() => null} />);
  assert.match(html, /Claude API key<\/b>[^]*?Recommended/);
  assert.match(html, /Claude subscription<\/b>[^]*?personal use only/);
});

test('picking a subscription explains the personal-use terms; several operators add a warning', () => {
  const solo = renderToStaticMarkup(<aiQ.Body store={withSettings({ AGENT_AUTH_MODE: 'oauth-token', AUTH_MODE: 'none' })} actions={() => null} />);
  assert.match(solo, /shared[^]*?by several people/);
  assert.match(solo, /code\.claude\.com\/docs\/en\/legal-and-compliance/);
  assert.ok(!solo.includes('⚠'), 'one operator: no warning');
  const shared = withSettings({ AGENT_AUTH_MODE: 'oauth-token', AUTH_MODE: 'header' });
  assert.match(renderToStaticMarkup(<aiQ.Body store={shared} actions={() => null} />), /⚠ A Claude subscription is for its owner/);
  assert.equal(aiQ.attention!(shared.byKey), true, 'the Settings list flags the question');
  const keyed = renderToStaticMarkup(<aiQ.Body store={withSettings({ AGENT_AUTH_MODE: 'api-key', AUTH_MODE: 'header' })} actions={() => null} />);
  assert.ok(!keyed.includes('⚠') && !keyed.includes('several people'), 'an API key needs no note');
});

test('M12: every shared question (including "look") has a web question, and vice versa', () => {
  assert.deepEqual([...ESSENTIALS, ...LATER].map((q) => q.id).sort(), QUESTIONS.map((q) => q.id).sort());
  assert.equal(LATER.find((q) => q.id === 'look')?.title, 'How should the factory look?');
});

test('M12: a theme card shows the coordinator first, pictures where uploaded and placeholders elsewhere; text is escaped', () => {
  const t: ThemeSummaryWire = {
    id: 'hive', name: 'The <b>Hive</b>', description: null, crewName: 'The Hive', builtIn: false, active: true,
    images: { orchestrator: { url: '/api/themes/hive/images/orchestrator?v=1', version: '1' } },
  };
  const html = renderToStaticMarkup(<ThemeCard t={t} on onPick={() => {}} />);
  assert.match(html, /aria-checked="true"/);
  assert.match(html, /<img class="avatar lead" src="\/api\/themes\/hive\/images\/orchestrator\?v=1"/);
  assert.equal((html.match(/avatar-empty/g) ?? []).length, THEME_SLOTS.length - 1);
  assert.match(html, /The &lt;b&gt;Hive&lt;\/b&gt;/);
  assert.match(html, /Uploaded/);
  assert.match(html, /The crew is called The Hive\./);
});

test('the Models question never silently swaps a saved model that is not in the catalogue', () => {
  const modelsQ = LATER.find((q) => q.id === 'models')!;
  const html = renderToStaticMarkup(<modelsQ.Body store={withSettings({ MODEL_DEFAULT_PLANNER: 'claude-haiku-4-5@20251001', MODEL_DEFAULT_TESTER: 'claude-sonnet-5' })} actions={() => null} />);
  assert.match(html, /<option value="claude-haiku-4-5@20251001" selected="">claude-haiku-4-5@20251001 \(not available\)<\/option>/);
  assert.equal((html.match(/not available/g) ?? []).length, 1, 'a model in the catalogue gets no marker');
  // the collapsed summary names an unknown id instead of "?"
  assert.match(renderToStaticMarkup(<>{modelsQ.summary(withSettings({ MODEL_DEFAULT_PLANNER: 'x@1', MODEL_DEFAULT_IMPLEMENTER: 'x@1', MODEL_DEFAULT_TESTER: 'claude-sonnet-5', MODEL_DEFAULT_REVIEWER: 'claude-sonnet-5' }).byKey)}</>), /x@1/);
});

const hiveView = (v: Record<string, { value?: unknown; orgValue?: unknown; envPinned?: boolean }>): SettingsStore =>
  ({ ...store, byKey: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, { key: k, ...x }])) as never });

test('Hive: the URL is saved trimmed, a blank token sends nothing, and clearing the URL writes null (off)', () => {
  assert.deepEqual(hiveEntries({}, '  https://hive.example.com/  ', ''), [['HIVE_URL', 'https://hive.example.com']]);
  assert.deepEqual(hiveEntries({}, 'https://hive.example.com', '  '), [['HIVE_URL', 'https://hive.example.com']]);
  assert.deepEqual(hiveEntries({}, 'https://h', ' tok '), [['HIVE_URL', 'https://h'], ['HIVE_TOKEN', 'tok']]);
  const on = hiveView({ HIVE_URL: { value: 'https://h', orgValue: 'https://h' } }).byKey;
  assert.deepEqual(hiveEntries(on, 'https://h', ''), [], 'an unchanged URL is not re-written');
  assert.deepEqual(hiveEntries(on, '  ', ''), [['HIVE_URL', null]]);
});

test('Hive: a saved token shows as saved and never appears in the page', () => {
  const s = hiveView({ HIVE_URL: { value: 'https://h', orgValue: 'https://h' }, HIVE_TOKEN: { value: 'sekrit-123', orgValue: 'sekrit-123' } });
  const html = renderToStaticMarkup(<hiveQ.Body store={s} actions={() => null} />);
  assert.match(html, /saved/);
  assert.ok(!html.includes('sekrit-123'));
  const summary = renderToStaticMarkup(<>{hiveQ.summary(s.byKey)}</>);
  assert.match(summary, /On.*https:\/\/h.*token saved/);
  assert.ok(!summary.includes('sekrit-123'));
  assert.match(renderToStaticMarkup(<>{hiveQ.summary({})}</>), /Off/);
});

test('Hive: env-pinned values lock the fields', () => {
  const s = hiveView({ HIVE_URL: { value: 'https://env', envPinned: true }, HIVE_TOKEN: { value: null, envPinned: true } });
  const html = renderToStaticMarkup(<hiveQ.Body store={s} actions={() => null} />);
  assert.match(html, /disabled/);
  assert.match(html, /set by your admin/);
  assert.match(html, /class="locked"/);
});

// ── M12 WP4b: several connections in Tickets / Code ──

const draft: TicketDraft = {
  GITHUB_REPOS: ' acme/web ', GITHUB_TOKEN: '', JIRA_BASE_URL: 'https://x.atlassian.net/', JIRA_EMAIL: 'me@x.com', JIRA_API_TOKEN: ' tok ', JIRA_PROJECTS: 'kan',
  TRELLO_KEY: '', TRELLO_TOKEN: '', TRELLO_BOARDS: '',
};
const codeDraft: CodeDraft = { GITHUB_REPOS: 'acme/web', GITHUB_TOKEN: '', GITLAB_BASE_URL: '', GITLAB_TOKEN: 'glpat', GITLAB_REPOS: 'grp/web' };

test('a pre-M12 install (TICKET_PROVIDER=jira) shows one ticked chip and the Jira form', () => {
  const html = renderToStaticMarkup(<ticketsQ.Body store={withSettings({ TICKET_PROVIDER: 'jira' })} actions={() => null} />);
  assert.equal((html.match(/role="checkbox" aria-checked="true"/g) ?? []).length, 1);
  assert.match(html, /aria-checked="true" class="choice on"><b>Jira/);
  assert.match(html, /Your Jira address/);
  assert.ok(!html.includes('Which repository?') && !html.includes('Trello token'));
  assert.ok(!html.includes('Make default'), 'one connection: no default picker');
});

test('several trackers: every chosen one has its form, the first is the default, the chip row wraps', () => {
  const html = renderToStaticMarkup(<ticketsQ.Body store={withSettings({ TICKET_PROVIDER: 'jira', TICKET_PROVIDERS: 'jira,github' })} actions={() => null} />);
  assert.equal((html.match(/aria-checked="true"/g) ?? []).length, 2);
  assert.match(html, /Your Jira address/);
  assert.match(html, /Which repository\?/);
  assert.equal((html.match(/Save and check it works/g) ?? []).length, 2, 'a check per connection');
  assert.match(html, /<em class="badge">Default<\/em>/);
  assert.equal((html.match(/Make default/g) ?? []).length, 1);
  assert.match(html, /class="conn-chips"/);
});

test('a saved tracker without a chip (linear) stays listed instead of being dropped', () => {
  const html = renderToStaticMarkup(<ticketsQ.Body store={withSettings({ TICKET_PROVIDER: 'jira', TICKET_PROVIDERS: 'jira,linear' })} actions={() => null} />);
  assert.match(html, /aria-checked="true" class="choice on"><b>Linear/);
});

test('toggleConnection keeps order; sample tickets are exclusive both ways; makeDefault moves to the front', () => {
  assert.deepEqual(toggleConnection(['jira'], 'github'), ['jira', 'github']);
  assert.deepEqual(toggleConnection(['jira', 'github'], 'jira'), ['github']);
  assert.deepEqual(toggleConnection(['jira', 'github'], 'mock'), ['mock'], 'picking sample tickets clears the others');
  assert.deepEqual(toggleConnection(['mock'], 'trello'), ['trello'], 'picking a real tracker drops sample tickets');
  assert.deepEqual(toggleConnection([], 'mock'), ['mock']);
  assert.deepEqual(makeDefault(['jira', 'github', 'trello'], 'trello'), ['trello', 'jira', 'github']);
});

test('ticketEntries: jira+github writes the list and its default; code follows GitHub only while it is unset', () => {
  const e = Object.fromEntries(ticketEntries(withSettings({ SCM_PROVIDER: 'gitlab' }).byKey, ['jira', 'github'], draft));
  assert.equal(e.TICKET_PROVIDERS, 'jira,github');
  assert.equal(e.TICKET_PROVIDER, 'jira');
  assert.equal(e.GITHUB_REPOS, 'acme/web');
  assert.equal(e.JIRA_BASE_URL, 'https://x.atlassian.net');
  assert.equal(e.JIRA_PROJECTS, 'KAN');
  assert.equal(e.JIRA_API_TOKEN, 'tok');
  assert.ok(!('GITHUB_TOKEN' in e), 'a blank secret is not sent');
  assert.ok(!('SCM_PROVIDER' in e) && !('SCM_PROVIDERS' in e), 'a chosen code host is left alone');
  const fresh = Object.fromEntries(ticketEntries(withSettings({ SCM_PROVIDER: 'mock' }).byKey, ['jira', 'github'], draft));
  assert.equal(fresh.SCM_PROVIDERS, 'github');
  assert.equal(fresh.SCM_PROVIDER, 'github');
});

test('unchoosing a connection never blanks its saved credentials', () => {
  for (const e of [ticketEntries({}, ['github'], draft), ticketEntries({}, ['mock'], draft), codeEntries({}, ['gitlab'], codeDraft)]) {
    assert.ok(e.every(([, v]) => v !== null), JSON.stringify(e));
  }
  const keys = ticketEntries({}, ['github'], draft).map(([k]) => k);
  assert.ok(!keys.some((k) => k.startsWith('JIRA_') || k.startsWith('TRELLO_')));
});

test('codeEntries: gitlab+github writes both; GitHub shared with the tickets reuses that connection', () => {
  const e = Object.fromEntries(codeEntries({}, ['gitlab', 'github'], codeDraft));
  assert.equal(e.SCM_PROVIDERS, 'gitlab,github');
  assert.equal(e.SCM_PROVIDER, 'gitlab');
  assert.equal(e.GITLAB_BASE_URL, 'https://gitlab.com');
  assert.equal(e.GITHUB_REPOS, 'acme/web');
  const shared = codeEntries(withSettings({ TICKET_PROVIDER: 'jira', TICKET_PROVIDERS: 'jira,github' }).byKey, ['github'], codeDraft);
  assert.deepEqual(shared, [['SCM_PROVIDERS', 'github'], ['SCM_PROVIDER', 'github']]);
  const html = renderToStaticMarkup(<codeQ.Body store={withSettings({ TICKET_PROVIDERS: 'jira,github', SCM_PROVIDERS: 'github' })} actions={() => null} />);
  assert.match(html, /Uses your GitHub connection above/);
  assert.ok(!html.includes('GitHub access token'));
});

test('a save reloads the settings, so token health on the page updates without a reload', async () => {
  let reloads = 0;
  const saved: [string, unknown][][] = [];
  const s: SettingsStore = {
    ...withSettings({ TICKET_PROVIDER: 'mock', SCM_PROVIDER: 'gitlab' }), saveMany: async (e) => { saved.push(e); return null; }, reload: () => { reloads++; },
  };
  let save: (() => Promise<boolean>) | undefined;
  renderToStaticMarkup(<ticketsQ.Body store={s} actions={(a) => { save = a.save; return null; }} />);
  assert.equal(await save!(), true);
  assert.equal(reloads, 1);
  assert.deepEqual(saved[0], [['TICKET_PROVIDERS', 'mock'], ['TICKET_PROVIDER', 'mock']]);
});

test('either key pinned in .env locks the question', () => {
  const pinned = (k: string): SettingsStore => ({ ...store, byKey: { TICKET_PROVIDER: { key: 'TICKET_PROVIDER', value: 'jira' }, [k]: { key: k, value: 'jira,github', envPinned: true } } as never });
  for (const k of ['TICKET_PROVIDERS', 'TICKET_PROVIDER']) {
    const html = renderToStaticMarkup(<ticketsQ.Body store={pinned(k)} actions={() => null} />);
    assert.match(html, /class="locked"/);
    assert.ok(!html.includes('role="checkbox"'));
  }
});

const health = (ok: boolean) => ({ ok, reason: ok ? null : 'rejected', since: '2026-11-01T00:00:00Z' });

test('the summary names every connection with its health; attention when any one needs a fix', () => {
  const b = { ...withSettings({ TICKET_PROVIDER: 'jira', TICKET_PROVIDERS: 'jira,github', JIRA_PROJECTS: 'KAN', GITHUB_REPOS: 'a/b,c/d' }).byKey };
  assert.equal(ticketsQ.attention!(b), false);
  const sum = renderToStaticMarkup(<>{ticketsQ.summary(b)}</>);
  assert.match(sum, /<b>Jira<\/b> · 1 project/);
  assert.match(sum, /<b>GitHub<\/b> · 2 repositories/);
  const sick = { ...b, GITHUB_TOKEN: { key: 'GITHUB_TOKEN', value: null, health: health(false) } } as never;
  assert.equal(ticketsQ.attention!(sick), true);
  assert.match(renderToStaticMarkup(<>{ticketsQ.summary(sick)}</>), /Your GitHub token stopped working/);
  const code = withSettings({ SCM_PROVIDERS: 'gitlab,github' }).byKey;
  assert.match(renderToStaticMarkup(<>{codeQ.summary(code)}</>), /<b>GitLab<\/b>.*\+ .*<b>GitHub<\/b>/);
  assert.equal(codeQ.attention!(code), false);
  assert.equal(codeQ.attention!({ ...code, GITLAB_TOKEN: { key: 'GITLAB_TOKEN', value: null, health: health(false) } } as never), true);
  assert.equal(codeQ.attention!(withSettings({ SCM_PROVIDER: 'mock' }).byKey), true, 'no repository yet');
});

test('each form\'s check asks about its own connection', async () => {
  const asked: (string | undefined)[] = [];
  const orig = { t: api.ticketPreflight, s: api.scmPreflight };
  api.ticketPreflight = async (c) => { asked.push(`t:${c}`); return { ok: true }; };
  api.scmPreflight = async (c) => { asked.push(`s:${c}`); return { ok: true }; };
  try {
    await ticketCheck('jira')();
    await ticketCheck('github')();
    await codeCheck('gitlab')();
  } finally { api.ticketPreflight = orig.t; api.scmPreflight = orig.s; }
  assert.deepEqual(asked, ['t:jira', 't:github', 's:gitlab']);
});
