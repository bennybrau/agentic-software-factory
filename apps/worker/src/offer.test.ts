import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentRuntime, ProviderKind } from '@asf/shared';
import { RuntimeOffer, type ProviderAuthView } from './offer.js';

const rt = (kind: string) => ({ kind }) as unknown as AgentRuntime;

function harness(initial: Record<string, ProviderAuthView | null>) {
  const views = { ...initial };
  const passes = new Set<string>();
  const calls: string[] = [];
  let t = 0;
  const offer = new RuntimeOffer(
    [{ runtime: rt('claude-code'), provider: 'anthropic' }, { runtime: rt('codex'), provider: 'openai' }],
    async (r, auth, o) => { calls.push(`${r.kind}:${auth.mode}:${o.credentialPresent}`); return passes.has(r.kind) ? { ok: true } : { ok: false, reason: 'no key' }; },
    () => {}, 600_000, () => t,
  );
  const refresh = () => offer.refresh((p: ProviderKind) => views[p] ?? null, () => 'unset');
  return { offer, views, passes, calls, refresh, tick: (ms: number) => { t += ms; } };
}

test('boot: offers what passes, keeps the rest pending', async () => {
  const h = harness({ anthropic: { mode: 'api-key', credentialPresent: true }, openai: null });
  h.passes.add('claude-code');
  assert.equal(await h.refresh(), true);
  assert.deepEqual(h.offer.kinds, ['claude-code']);
  assert.deepEqual(h.offer.pending, ['codex']);
});

test('a key entered in Settings brings the pending runtime online on the next refresh, no restart', async () => {
  const h = harness({ anthropic: { mode: 'api-key', credentialPresent: true }, openai: null });
  h.passes.add('claude-code');
  await h.refresh();
  // Nothing changed: the pending runtime is not re-preflighted on every heartbeat (each is a model call).
  h.calls.length = 0;
  assert.equal(await h.refresh(), false);
  assert.deepEqual(h.calls, []);
  // Operator saves an OpenAI key: the api's view changes -> re-checked immediately.
  h.views.openai = { mode: 'api-key', credentialPresent: true };
  h.passes.add('codex');
  assert.equal(await h.refresh(), true);
  assert.deepEqual(h.calls, ['codex:api-key:true']);
  assert.deepEqual(h.offer.kinds, ['claude-code', 'codex']);
  assert.deepEqual(h.offer.pending, []);
});

test('an unchanged failure is re-tried after recheckMs (e.g. billing fixed on the provider side)', async () => {
  const h = harness({ openai: { mode: 'api-key', credentialPresent: true } });
  await h.refresh();
  h.calls.length = 0;
  h.passes.add('codex');
  h.tick(599_999);
  assert.equal(await h.refresh(), false);
  assert.ok(!h.calls.some((c) => c.startsWith('codex')), 'not yet due');
  h.tick(1);
  assert.equal(await h.refresh(), true);
  assert.deepEqual(h.offer.kinds, ['codex']);
});

test('an offered runtime is not re-preflighted while its provider view is unchanged (a later credential failure surfaces on the run)', async () => {
  const h = harness({ anthropic: { mode: 'api-key', credentialPresent: true } });
  h.passes.add('claude-code');
  await h.refresh();
  h.calls.length = 0;
  h.tick(10 * 600_000);
  await h.refresh();
  assert.ok(!h.calls.some((c) => c.startsWith('claude-code')));
  assert.deepEqual(h.offer.kinds, ['claude-code']);
});

test('M9: a provider switch (e.g. to Vertex, or a new project) re-checks an offered runtime; failing it stops offering', async () => {
  const h = harness({ anthropic: { mode: 'api-key', credentialPresent: true } });
  h.passes.add('claude-code');
  await h.refresh();
  h.calls.length = 0;
  h.views.anthropic = { mode: 'vertex', credentialPresent: true, vertex: { projectId: 'acme-ai', region: 'global' } };
  assert.equal(await h.refresh(), false, 'passed again: offered set unchanged');
  assert.equal(h.calls.filter((c) => c.startsWith('claude-code')).length, 1);
  assert.deepEqual(h.offer.kinds, ['claude-code']);
  h.passes.delete('claude-code');
  h.views.anthropic = { mode: 'vertex', credentialPresent: true, vertex: { projectId: 'other-proj', region: 'global' } };
  assert.equal(await h.refresh(), true);
  assert.deepEqual(h.offer.kinds, []);
  assert.deepEqual(h.offer.pending.includes('claude-code'), true);
  // fixed: comes back on the next view change
  h.passes.add('claude-code');
  h.views.anthropic = { mode: 'vertex', credentialPresent: true, vertex: { projectId: 'acme-ai', region: 'global' } };
  assert.equal(await h.refresh(), true);
  assert.deepEqual(h.offer.kinds, ['claude-code']);
});

test('status reports every configured runtime and flips to ok once the key view changes (#69)', async () => {
  const h = harness({ anthropic: { mode: 'api-key', credentialPresent: true }, openai: null });
  h.passes.add('claude-code');
  h.offer.notInstalled('hermes', 'not installed on this worker');
  await h.refresh();
  const before = Object.fromEntries(h.offer.status.map((s) => [s.kind, s]));
  assert.equal(before['claude-code'].ok, true);
  assert.equal(before['claude-code'].reason, undefined);
  assert.equal(before.codex.ok, false);
  assert.equal(before.codex.installed, true);
  assert.equal(before.codex.reason, 'no key');
  assert.deepEqual([before.hermes.installed, before.hermes.ok, before.hermes.reason], [false, false, 'not installed on this worker']);

  h.views.openai = { mode: 'api-key', credentialPresent: true };
  h.passes.add('codex');
  await h.refresh();
  const codex = h.offer.status.find((s) => s.kind === 'codex')!;
  assert.equal(codex.ok, true);
  assert.equal(codex.reason, undefined);
});

test('container rule (#70): a runtime that cannot confine its own writes is refused on a host, offered in a container', async () => {
  const { containerRefusal } = await import('./offer.js');
  const { OpencodeRuntime } = await import('./runtimes/opencode.js');
  const { CopilotRuntime } = await import('./runtimes/copilot.js');
  const { CodexRuntime } = await import('./runtimes/codex.js');
  const { ClaudeCodeRuntime } = await import('./runtimes/claude-code.js');
  for (const r of [new OpencodeRuntime(), new CopilotRuntime(), new CodexRuntime({ sandbox: 'off' })]) {
    assert.equal(containerRefusal(r.capabilities, false), 'needs the containerised worker', `${r.kind} on a host`);
    assert.equal(containerRefusal(r.capabilities, true), null, `${r.kind} in a container`);
  }
  // Claude's hooks and Codex's own sandbox confine writes, so they run on a host too.
  for (const r of [new ClaudeCodeRuntime(), new CodexRuntime({ sandbox: 'workspace-write' })]) {
    assert.equal(containerRefusal(r.capabilities, false), null, `${r.kind} on a host`);
  }
});

test('M9 suspend: drops an offered runtime, a timed re-check does NOT re-preflight it, status shows the reason', async () => {
  const h = harness({ anthropic: { mode: 'vertex', credentialPresent: true, vertex: { projectId: 'acme-ai', region: 'global' } }, openai: null });
  h.passes.add('claude-code');
  await h.refresh();
  assert.deepEqual(h.offer.kinds, ['claude-code']);
  h.calls.length = 0;

  assert.equal(h.offer.suspend('anthropic', 'Google login expired'), true, 'the offered set changed');
  assert.deepEqual(h.offer.kinds, []);
  assert.ok(h.offer.pending.includes('claude-code'));
  const held = h.offer.status.find((s) => s.kind === 'claude-code')!;
  assert.equal(held.ok, false);
  assert.equal(held.reason, 'Google login expired');

  // Well past recheckMs, and the login "would pass" now: still no preflight while held.
  h.tick(10 * 600_000);
  assert.equal(await h.refresh(), false);
  assert.deepEqual(h.calls.filter((c) => c.startsWith('claude-code')), []);
  assert.deepEqual(h.offer.kinds, []);
  assert.equal(h.offer.status.find((s) => s.kind === 'claude-code')!.reason, 'Google login expired');

  // A provider view change does not bypass the hold either.
  h.views.anthropic = { mode: 'vertex', credentialPresent: true, vertex: { projectId: 'other-proj', region: 'global' } };
  await h.refresh();
  assert.deepEqual(h.calls.filter((c) => c.startsWith('claude-code')), []);
});

test('M9 suspend: suspending an already-held runtime again reports no change and refreshes the reason', async () => {
  const h = harness({ anthropic: { mode: 'vertex', credentialPresent: true, vertex: { projectId: 'acme-ai', region: 'global' } } });
  h.passes.add('claude-code');
  await h.refresh();
  assert.equal(h.offer.suspend('anthropic', 'first'), true);
  assert.equal(h.offer.suspend('anthropic', 'second'), false);
  assert.equal(h.offer.status.find((s) => s.kind === 'claude-code')!.reason, 'second');
});

test('M9 resume: the next refresh preflights the held runtime and offers it again on a pass', async () => {
  const h = harness({ anthropic: { mode: 'vertex', credentialPresent: true, vertex: { projectId: 'acme-ai', region: 'global' } } });
  h.passes.add('claude-code');
  await h.refresh();
  h.offer.suspend('anthropic', 'Google login expired');
  h.calls.length = 0;

  h.offer.resume('anthropic');
  assert.deepEqual(h.offer.kinds, [], 'resume alone does not offer it; a real preflight decides');
  assert.equal(await h.refresh(), true);
  assert.equal(h.calls.filter((c) => c.startsWith('claude-code')).length, 1, 'preflighted exactly once, immediately (not after recheckMs)');
  assert.deepEqual(h.offer.kinds, ['claude-code']);
  const st = h.offer.status.find((s) => s.kind === 'claude-code')!;
  assert.equal(st.ok, true);
  assert.equal(st.reason, undefined);
});

test('M9 resume: a failing preflight after resume keeps it out, with the preflight\'s own reason', async () => {
  const h = harness({ anthropic: { mode: 'vertex', credentialPresent: true, vertex: { projectId: 'acme-ai', region: 'global' } } });
  h.passes.add('claude-code');
  await h.refresh();
  h.offer.suspend('anthropic', 'Google login expired');
  h.passes.delete('claude-code');
  h.offer.resume('anthropic');
  await h.refresh();
  assert.deepEqual(h.offer.kinds, []);
  assert.equal(h.offer.status.find((s) => s.kind === 'claude-code')!.reason, 'no key');
});

test('M9 resume: resuming a provider that was never suspended is a no-op (no extra preflight)', async () => {
  const h = harness({ anthropic: { mode: 'api-key', credentialPresent: true } });
  h.passes.add('claude-code');
  await h.refresh();
  h.calls.length = 0;
  h.offer.resume('anthropic');
  assert.equal(await h.refresh(), false);
  assert.deepEqual(h.calls, []);
});

test('M9 suspend of a different provider leaves a runtime alone', async () => {
  const h = harness({ anthropic: { mode: 'api-key', credentialPresent: true }, openai: { mode: 'api-key', credentialPresent: true } });
  h.passes.add('claude-code'); h.passes.add('codex');
  await h.refresh();
  assert.deepEqual(h.offer.kinds, ['claude-code', 'codex']);
  h.calls.length = 0;
  assert.equal(h.offer.suspend('openai', 'held'), true);
  assert.deepEqual(h.offer.kinds, ['claude-code']);
  assert.equal(h.offer.status.find((s) => s.kind === 'claude-code')!.ok, true);
  assert.equal(h.offer.status.find((s) => s.kind === 'claude-code')!.reason, undefined);
  h.tick(10 * 600_000);
  await h.refresh();
  assert.ok(!h.calls.some((c) => c.startsWith('codex')), 'codex is held');
  assert.deepEqual(h.offer.kinds, ['claude-code']);
  // Resuming the other provider does not touch it.
  h.offer.resume('anthropic');
  await h.refresh();
  assert.ok(!h.calls.some((c) => c.startsWith('codex')));
});

/** A harness whose preflight for claude-code can be held open until released, to land a suspend() mid-await. */
function gatedHarness(view: ProviderAuthView) {
  const views: Record<string, ProviderAuthView | null> = { anthropic: view, openai: null };
  let t = 0;
  let gate: Promise<void> | null = null;
  let result: { ok: boolean; reason?: string } = { ok: true };
  let entered!: () => void;
  let enteredP: Promise<void> = new Promise((r) => { entered = r; });
  const offer = new RuntimeOffer(
    [{ runtime: rt('claude-code'), provider: 'anthropic' }],
    async () => { entered(); if (gate) await gate; return result; },
    () => {}, 600_000, () => t,
  );
  const refresh = () => offer.refresh((p: ProviderKind) => views[p] ?? null, () => 'unset');
  return {
    offer, views, refresh, tick: (ms: number) => { t += ms; },
    /** Hold the next preflight; returns release(). `inPreflight()` resolves once a preflight is awaiting. */
    hold: () => { let release!: () => void; gate = new Promise<void>((r) => { release = r; }); enteredP = new Promise((r) => { entered = r; }); return release; },
    inPreflight: () => enteredP,
    setResult: (r: { ok: boolean; reason?: string }) => { result = r; },
  };
}
const vertexView = (projectId: string): ProviderAuthView => ({ mode: 'vertex', credentialPresent: true, vertex: { projectId, region: 'global' } });

test('M9 race: a suspend() landing while the first preflight is awaited leaves the runtime NOT offered after it resolves ok', async () => {
  const h = gatedHarness(vertexView('acme-ai'));
  const release = h.hold();
  const refreshing = h.refresh();
  await h.inPreflight();
  assert.equal(h.offer.suspend('anthropic', 'Google login expired'), false, 'nothing was offered yet');
  release();
  await refreshing;
  assert.deepEqual(h.offer.kinds, [], 'the login watch wins over the late ok');
  assert.ok(h.offer.pending.includes('claude-code'));
  const st = h.offer.status.find((s) => s.kind === 'claude-code')!;
  assert.equal(st.ok, false);
  assert.equal(st.reason, 'Google login expired');
});

test('M9 race: a suspend() landing while a view-change re-preflight of an OFFERED runtime is awaited leaves it NOT offered', async () => {
  const h = gatedHarness(vertexView('acme-ai'));
  await h.refresh();
  assert.deepEqual(h.offer.kinds, ['claude-code']);

  h.views.anthropic = vertexView('other-proj'); // the view changes -> the offered branch re-preflights
  const release = h.hold();
  const refreshing = h.refresh();
  await h.inPreflight();
  assert.equal(h.offer.suspend('anthropic', 'Google login expired'), true, 'it was offered, so the set changed');
  release();
  await refreshing;
  assert.deepEqual(h.offer.kinds, [], 'a late ok must not re-offer it');
  assert.equal(h.offer.status.find((s) => s.kind === 'claude-code')!.reason, 'Google login expired');
  h.tick(10 * 600_000);
  await h.refresh();
  assert.deepEqual(h.offer.kinds, [], 'and it stays held');
});

test('M9 race: a suspend() during a view-change re-preflight that then FAILS keeps the login reason', async () => {
  const h = gatedHarness(vertexView('acme-ai'));
  await h.refresh();
  h.views.anthropic = vertexView('other-proj');
  h.setResult({ ok: false, reason: 'preflight failed' });
  const release = h.hold();
  const refreshing = h.refresh();
  await h.inPreflight();
  h.offer.suspend('anthropic', 'Google login expired');
  release();
  await refreshing;
  assert.deepEqual(h.offer.kinds, []);
  assert.equal(h.offer.status.find((s) => s.kind === 'claude-code')!.reason, 'Google login expired');
});

// M11 WP4: a runtime is a candidate once per provider it can serve.
function ollamaHarness(views: Record<string, ProviderAuthView | null>, passing: string[]) {
  const seen: Array<{ provider: string; baseUrl?: string }> = [];
  const offer = new RuntimeOffer(
    [{ runtime: rt('claude-code'), provider: 'anthropic' }, { runtime: rt('claude-code'), provider: 'ollama' }],
    async (_r, auth) => { seen.push({ provider: auth.providerKind, baseUrl: auth.baseUrl }); return passing.includes(auth.providerKind) ? { ok: true } : { ok: false, reason: `${auth.providerKind} down` }; },
    () => {},
  );
  return { offer, seen, refresh: () => offer.refresh((p: ProviderKind) => views[p] ?? null, () => 'unset') };
}

test('an Ollama-only worker offers claude-code@ollama though its Claude check fails', async () => {
  const h = ollamaHarness({ anthropic: { mode: 'oauth-token', credentialPresent: false }, ollama: { mode: 'none', credentialPresent: true, baseUrl: 'http://ollama.lan:11434' } }, ['ollama']);
  assert.equal(await h.refresh(), true);
  assert.deepEqual(h.offer.kinds, ['claude-code']);
  assert.deepEqual(h.offer.capabilities, ['claude-code@ollama']);
  assert.deepEqual(h.offer.pending, [], 'offered under one provider = not pending');
  assert.deepEqual(h.seen.find((s) => s.provider === 'ollama'), { provider: 'ollama', baseUrl: 'http://ollama.lan:11434' }, 'the preflight gets the server URL');
  assert.deepEqual(h.offer.status.map((s) => [s.kind, s.provider, s.ok]), [['claude-code', 'anthropic', false], ['claude-code', 'ollama', true]]);
});

test('a Claude-only worker offers claude-code@anthropic and not @ollama', async () => {
  const h = ollamaHarness({ anthropic: { mode: 'api-key', credentialPresent: true }, ollama: { mode: 'none', credentialPresent: true } }, ['anthropic']);
  await h.refresh();
  assert.deepEqual(h.offer.capabilities, ['claude-code@anthropic']);
});

test('both pass: both capabilities, one runtime kind', async () => {
  const h = ollamaHarness({ anthropic: { mode: 'api-key', credentialPresent: true }, ollama: { mode: 'none', credentialPresent: true, baseUrl: 'http://x:11434' } }, ['anthropic', 'ollama']);
  await h.refresh();
  assert.deepEqual(h.offer.kinds, ['claude-code']);
  assert.deepEqual(h.offer.capabilities, ['claude-code@anthropic', 'claude-code@ollama']);
});
