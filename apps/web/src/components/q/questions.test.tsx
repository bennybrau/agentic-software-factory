import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SettingsStore } from './ui';
import { aiQ, hiveQ, hiveEntries, ESSENTIALS, LATER } from './questions';
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
