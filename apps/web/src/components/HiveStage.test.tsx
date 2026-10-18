import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CLASSIC_THEME, HIVE_THEME, type ActiveThemeWire, type ThemeSlot } from '@asf/shared/ui';
import { HiveStage, initialOf, stageCaption, type HiveStageProps } from './HiveStage';

const pics = (slots: ThemeSlot[]) => Object.fromEntries(slots.map((s) => [s, { url: `/api/themes/hive/images/${s}?v=1`, version: '1' }]));
const ALL: ThemeSlot[] = ['orchestrator', 'planner', 'implementer', 'tester', 'reviewer'];

/** Render the stage with a given active theme already in the react-query cache (no fetch). */
function render(active: ActiveThemeWire, props: HiveStageProps): string {
  const qc = new QueryClient();
  qc.setQueryData(['theme'], active);
  return renderToStaticMarkup(<QueryClientProvider client={qc}><HiveStage {...props} /></QueryClientProvider>);
}
const hive = (slots = ALL): ActiveThemeWire => ({ manifest: HIVE_THEME, builtIn: true, images: pics(slots), requested: null });
const classic: ActiveThemeWire = { manifest: CLASSIC_THEME, builtIn: true, images: {}, requested: null };
/** The Hive with 3D state loops: every member has idle, working and done (M13). */
const STATES = ['idle', 'working', 'done'] as const;
const loops: ActiveThemeWire = {
  manifest: HIVE_THEME, builtIn: true, requested: null,
  images: Object.fromEntries(ALL.map((s) => [s, { url: `/api/themes/hive/images/${s}/idle?v=1`, version: '1' }])),
  stateImages: Object.fromEntries(ALL.map((s) => [s, Object.fromEntries(STATES.map((st) => [st, { url: `/api/themes/hive/images/${s}/${st}?v=1`, version: '1' }]))])),
};
const picOf = (html: string, slot: string) => html.match(new RegExp(`data-slot="${slot}" data-picture="([a-z]+)"`))?.[1];
const working: HiveStageProps = {
  run: { state: 'running' },
  tasks: [
    { role: 'planner', state: 'done', seq: 0, startedAt: '2026-10-04T11:00:00Z' },
    { role: 'implementer', state: 'running', seq: 1, startedAt: '2026-10-04T11:01:00Z' },
    { role: 'tester', state: 'pending', seq: 2, startedAt: null },
    { role: 'reviewer', state: 'pending', seq: 3, startedAt: null },
  ],
};

const slots = (html: string) => [...html.matchAll(/data-slot="([a-z]+)"/g)].map((m) => m[1]);
/** The bubble's text, entities decoded (a quip like "the Scout's dance" renders its apostrophe as &#x27;). */
const bubble = (html: string) => html.match(/<div class="hive-bubble" aria-hidden="true">([^<]*)<\/div>/)?.[1]
  ?.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

test('the Hive while working: only the Builder on stage, large, its quip in the bubble', () => {
  const html = render(hive(), working);
  assert.deepEqual(slots(html), ['implementer']);
  assert.match(html, /class="hive-member on st-running" data-slot="implementer" data-picture="working"/);
  assert.match(html, /<span class="hive-name">Builder<\/span><span class="hive-step">Write code<\/span>/);
  assert.ok(HIVE_THEME.quips!.implementer!.map((q) => `${q}…`).includes(bubble(html)!), bubble(html));
  for (const n of ['The Queen', 'Scout', 'Guard', 'Inspector']) assert.ok(!html.includes(`>${n}<`), n);
  assert.match(html, /class="hive-stage mood-working"/);
  assert.deepEqual([...html.matchAll(/<img[^>]*src="([^"]+)"/g)].map((m) => m[1]), ['/api/themes/hive/images/implementer?v=1']);
  assert.doesNotMatch(html, /<canvas/);
});

test('a member with no picture shows its initial', () => {
  const html = render(hive(['orchestrator', 'planner']), working);
  assert.match(html, /<span class="hive-img hive-initial" aria-hidden="true">B<\/span>/);
  assert.equal(initialOf('The Queen'), 'Q');
  assert.equal(initialOf('inspector'), 'I');
});

test('classic with no uploads shows the stage with its built-in placeholder', () => {
  const html = render(classic, working);
  assert.match(html, /class="hive-stage mood-working"/);
  assert.deepEqual(slots(html), ['implementer']);
  assert.deepEqual([...html.matchAll(/<img[^>]*src="([^"]+)"/g)].map((m) => m[1]), ['/themes/classic/implementer.svg']);
  assert.ok(CLASSIC_THEME.quips!.implementer!.map((q) => `${q}…`).includes(bubble(html)!), bubble(html));
});

test('classic: an uploaded picture beats the placeholder', () => {
  const html = render({ ...classic, images: { implementer: { url: '/api/themes/classic/images/implementer?v=1', version: '1' } } }, working);
  assert.deepEqual([...html.matchAll(/<img[^>]*src="([^"]+)"/g)].map((m) => m[1]), ['/api/themes/classic/images/implementer?v=1']);
});

test('the Hive with no pictures is a quiet caption line', () => {
  const html = render(hive([]), working);
  assert.match(html, /^<div class="hive-quiet mood-working">/);
  assert.doesNotMatch(html, /hive-member|hive-bubble|<img|<canvas/);
  assert.match(html, new RegExp(HIVE_THEME.quips!.implementer![0]));
});

test('the gate puts the Queen alone on stage with her line in the bubble, announced politely', () => {
  const html = render(hive(), { ...working, run: { state: 'awaiting_checkpoint' }, gates: [{ state: 'open' }] });
  assert.deepEqual(slots(html), ['orchestrator']);
  assert.match(html, /class="hive-member on" data-slot="orchestrator"/);
  assert.doesNotMatch(html, /hive-step/);
  assert.equal(bubble(html), 'The Queen awaits your word');
  assert.match(html, /<span class="sr-only" aria-live="polite">The Queen awaits your word<\/span>/);
});

test('once delivered the Queen is on stage with the delivered line', () => {
  const html = render(hive(), { run: { state: 'succeeded' }, tasks: working.tasks.map((t) => ({ ...t, state: 'done' })) });
  assert.deepEqual(slots(html), ['orchestrator']);
  assert.equal(bubble(html), stageCaption(HIVE_THEME, 'delivered', null, 0));
});

test('a stopped job keeps the Queen still, her bubble muted', () => {
  const html = render(hive(), { ...working, run: { state: 'failed' } });
  assert.deepEqual(slots(html), ['orchestrator']);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /<canvas/);
  assert.match(html, /class="hive-stage mood-failed"/);
  assert.equal(bubble(html), 'The Queen has called the hive home');
});

test('captions: quips while working, mood lines otherwise, all text (no markup)', () => {
  assert.equal(stageCaption(HIVE_THEME, 'working', 'implementer', 0), `${HIVE_THEME.quips!.implementer![0]}…`);
  assert.equal(stageCaption(HIVE_THEME, 'question', 'planner', 0), 'Scout flew back with a question for you');
  assert.equal(stageCaption(CLASSIC_THEME, 'handoff', 'tester', 0), 'Handing over to the Tester');
  const sneaky = { ...HIVE_THEME, members: { ...HIVE_THEME.members, implementer: { name: '<img src=x onerror=alert(1)>' } } };
  const html = render({ ...hive(), manifest: sneaky }, working);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

// --- M13: state pictures ---

test('M13: with state loops the Builder plays its working loop, shown whole', () => {
  const html = render(loops, working);
  assert.deepEqual(slots(html), ['implementer']);
  assert.equal(picOf(html, 'implementer'), 'working');
  assert.deepEqual([...html.matchAll(/<img[^>]*src="([^"]+)"/g)].map((m) => m[1]), ['/api/themes/hive/images/implementer/working?v=1']);
  assert.match(html, /class="hive-member on st-running own-states" data-slot="implementer"/);
  assert.equal((html.match(/class="hive-img whole"/g) ?? []).length, 1);
});

test('M13: at a check-in the Queen works; delivered she is done; a stopped job is still', () => {
  const gate = render(loops, { ...working, run: { state: 'awaiting_checkpoint' }, gates: [{ state: 'open' }] });
  assert.equal(picOf(gate, 'orchestrator'), 'working');
  const delivered = render(loops, { run: { state: 'succeeded' }, tasks: working.tasks.map((t) => ({ ...t, state: 'done' })) });
  assert.equal(picOf(delivered, 'orchestrator'), 'done');
  const stopped = render(loops, { ...working, run: { state: 'failed' } });
  assert.equal(picOf(stopped, 'orchestrator'), 'idle');
  assert.doesNotMatch(stopped, /<img/, 'a stopped job keeps the picture still');
});
