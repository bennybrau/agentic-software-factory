import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { AUTH_MODES, PROVIDER_KINDS, SETTINGS } from '@asf/shared';
import { computeRunAuth, computeRunAuths, describeAgentAuth, PROVIDER_AUTH } from './agent-auth.js';

// computeRunAuth resolves the effective agent auth the api hands the worker per
// run, per model provider (M8 WP C). Mode comes from the resolver (env > org >
// default; org cache is empty in a unit test, so env drives it). Exactly one
// credential goes on the wire, matching the mode.
const KEYS = ['AGENT_AUTH_MODE', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'SECRETS_SOURCE',
  'AGENT_AUTH_OPENAI_MODE', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'AGENT_AUTH_OPENAI_COMPAT_MODE',
  'OPENAI_COMPAT_API_KEY', 'OPENAI_COMPAT_BASE_URL', 'AGENT_AUTH_GITHUB_MODE', 'GITHUB_COPILOT_TOKEN',
  'ANTHROPIC_VERTEX_PROJECT_ID', 'CLOUD_ML_REGION', 'MODEL_ALLOWLIST', 'OLLAMA_BASE_URL', 'OLLAMA_API_KEY'];
const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
  for (const k of KEYS) delete process.env[k];
});

function stubOrgSecret(value: string) {
  global.fetch = (async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse((init?.body as string) ?? '{}') as { op: string };
    const result = body.op === 'getOrgSecret' ? { value } : {};
    return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}
const env = (o: Record<string, string>) => { process.env.SECRETS_SOURCE = 'env'; Object.assign(process.env, o); };

test('anthropic oauth-token: the token and NO api key on the wire (billing safety); v1 shim field set', async () => {
  env({ AGENT_AUTH_MODE: 'oauth-token', CLAUDE_CODE_OAUTH_TOKEN: 'oat-A', ANTHROPIC_API_KEY: 'key-B' });
  const auth = await computeRunAuth('anthropic');
  assert.deepEqual(auth, { providerKind: 'anthropic', mode: 'oauth-token', credential: 'oat-A', oauthToken: 'oat-A' });
  assert.equal(auth.apiKey, undefined, 'oauth-token never sends the metered key');
});

test('anthropic api-key: the key and NO oauth token', async () => {
  env({ AGENT_AUTH_MODE: 'api-key', ANTHROPIC_API_KEY: 'key-B', CLAUDE_CODE_OAUTH_TOKEN: 'oat-A' });
  assert.deepEqual(await computeRunAuth(), { providerKind: 'anthropic', mode: 'api-key', credential: 'key-B', apiKey: 'key-B' });
});

test('a blank credential returns the bare mode (no silent fallback to another mode)', async () => {
  env({ AGENT_AUTH_MODE: 'oauth-token', CLAUDE_CODE_OAUTH_TOKEN: '  ', ANTHROPIC_API_KEY: 'key-B' });
  assert.deepEqual(await computeRunAuth(), { providerKind: 'anthropic', mode: 'oauth-token' });
  env({ AGENT_AUTH_MODE: 'api-key', ANTHROPIC_API_KEY: '   ' });
  assert.deepEqual(await computeRunAuth(), { providerKind: 'anthropic', mode: 'api-key' });
});

test('vertex/bedrock carry no credential on the wire; vertex carries its project + region', async () => {
  env({ AGENT_AUTH_MODE: 'bedrock', ANTHROPIC_API_KEY: 'key-B' });
  assert.deepEqual(await computeRunAuth(), { providerKind: 'anthropic', mode: 'bedrock' });
  env({ AGENT_AUTH_MODE: 'vertex', ANTHROPIC_API_KEY: 'key-B', ANTHROPIC_VERTEX_PROJECT_ID: 'acme-ai', CLOUD_ML_REGION: 'us-east5' });
  assert.deepEqual(await computeRunAuth(), { providerKind: 'anthropic', mode: 'vertex', vertex: { projectId: 'acme-ai', region: 'us-east5' } });
});

test('vertex under MODEL_ALLOWLIST pins Claude Code\'s own model picks to allowed ids; status says whether a project is set', async () => {
  env({ AGENT_AUTH_MODE: 'vertex', ANTHROPIC_VERTEX_PROJECT_ID: '', MODEL_ALLOWLIST: 'claude-opus-5-5, claude-sonnet-5, claude-haiku-4-5' });
  const a = await computeRunAuth();
  assert.deepEqual(a.vertex, { region: 'global', defaultModel: 'claude-sonnet-5', fastModel: 'claude-haiku-4-5', maxModel: 'claude-opus-5-5' });
  const s = await describeAgentAuth();
  assert.equal(s.mode, 'vertex');
  assert.equal(s.credentialPresent, false, 'no project yet = not ready');
  env({ AGENT_AUTH_MODE: 'vertex', ANTHROPIC_VERTEX_PROJECT_ID: 'acme-ai', MODEL_ALLOWLIST: '' });
  const s2 = await describeAgentAuth();
  assert.equal(s2.credentialPresent, true);
  assert.deepEqual(s2.vertex, { projectId: 'acme-ai', region: 'global' }, 'no allowlist: Claude Code keeps its own defaults');
});

test('every credential resolves a secret://org pointer via the registry', async () => {
  stubOrgSecret('from-org-sink');
  env({ AGENT_AUTH_MODE: 'api-key', ANTHROPIC_API_KEY: 'secret://org/ANTHROPIC_API_KEY',
    OPENAI_API_KEY: 'secret://org/OPENAI_API_KEY', GITHUB_COPILOT_TOKEN: 'secret://org/GITHUB_COPILOT_TOKEN' });
  assert.equal((await computeRunAuth('anthropic')).credential, 'from-org-sink');
  assert.equal((await computeRunAuth('openai')).credential, 'from-org-sink');
  assert.equal((await computeRunAuth('github')).credential, 'from-org-sink');
});

test('openai / openai-compatible / github: own mode key, own credential, baseUrl when set', async () => {
  env({ OPENAI_API_KEY: 'oai-C', OPENAI_BASE_URL: 'https://proxy/v1', OPENAI_COMPAT_API_KEY: 'cmp-D',
    OPENAI_COMPAT_BASE_URL: 'https://api.deepseek.com/v1', GITHUB_COPILOT_TOKEN: 'gh-E', ANTHROPIC_API_KEY: 'key-B' });
  assert.deepEqual(await computeRunAuth('openai'), { providerKind: 'openai', mode: 'api-key', credential: 'oai-C', baseUrl: 'https://proxy/v1' });
  assert.deepEqual(await computeRunAuth('openai-compatible'), { providerKind: 'openai-compatible', mode: 'api-key', credential: 'cmp-D', baseUrl: 'https://api.deepseek.com/v1' });
  assert.deepEqual(await computeRunAuth('github'), { providerKind: 'github', mode: 'gh-token', credential: 'gh-E' });
  env({ AGENT_AUTH_OPENAI_MODE: 'chatgpt', AGENT_AUTH_OPENAI_COMPAT_MODE: 'none' });
  assert.deepEqual(await computeRunAuth('openai'), { providerKind: 'openai', mode: 'chatgpt', baseUrl: 'https://proxy/v1' });
  assert.deepEqual(await computeRunAuth('openai-compatible'), { providerKind: 'openai-compatible', mode: 'none', baseUrl: 'https://api.deepseek.com/v1' });
});

test('ollama (M11): keyless local server by default; api-key whenever a Cloud key is set', async () => {
  env({ OLLAMA_BASE_URL: 'http://host.docker.internal:11434', ANTHROPIC_API_KEY: 'key-B' });
  assert.deepEqual(await computeRunAuth('ollama'), { providerKind: 'ollama', mode: 'none', baseUrl: 'http://host.docker.internal:11434' });
  assert.deepEqual((await describeAgentAuth()).providers.ollama, { mode: 'none', credentialPresent: true, baseUrl: 'http://host.docker.internal:11434' }, 'the server URL (not a secret) so the worker can check it');
  env({ OLLAMA_API_KEY: 'oll-F' });
  assert.deepEqual(await computeRunAuth('ollama'), { providerKind: 'ollama', mode: 'api-key', credential: 'oll-F', baseUrl: 'http://host.docker.internal:11434' });
  assert.deepEqual((await describeAgentAuth()).providers.ollama, { mode: 'api-key', credentialPresent: true, baseUrl: 'http://host.docker.internal:11434' });
  delete process.env.OLLAMA_BASE_URL;
  assert.deepEqual(await computeRunAuth('ollama'), { providerKind: 'ollama', mode: 'api-key', credential: 'oll-F' }, 'Cloud only: no local URL');
});

test('computeRunAuths: one entry per provider, and no provider carries another\'s credential', async () => {
  env({ AGENT_AUTH_MODE: 'api-key', ANTHROPIC_API_KEY: 'key-B', OPENAI_API_KEY: 'oai-C' });
  const all = await computeRunAuths();
  assert.deepEqual(Object.keys(all).sort(), [...PROVIDER_KINDS].sort());
  assert.equal(all.anthropic?.credential, 'key-B');
  assert.equal(all.openai?.credential, 'oai-C');
  assert.equal(all['openai-compatible']?.credential, undefined);
  assert.equal(all.github?.credential, undefined);
  assert.equal(all.ollama?.credential, undefined);
});

test('describeAgentAuth: anthropic at the top level (pre-M8 shape) + a per-provider map, never a credential', async () => {
  env({ AGENT_AUTH_MODE: 'oauth-token', CLAUDE_CODE_OAUTH_TOKEN: 'oat-A', OPENAI_API_KEY: '' });
  const d = await describeAgentAuth();
  assert.equal(d.mode, 'oauth-token'); assert.equal(d.credentialPresent, true);
  assert.deepEqual(d.providers.openai, { mode: 'api-key', credentialPresent: false });
  assert.deepEqual(d.providers.github, { mode: 'gh-token', credentialPresent: false });
  assert.ok(!JSON.stringify(d).includes('oat-A'), 'never exposes a credential');
  env({ AGENT_AUTH_MODE: 'bedrock' });
  assert.deepEqual((await describeAgentAuth()).providers.anthropic, { mode: 'bedrock', credentialPresent: true });
});

test('the api\'s provider table matches the shared mode list and the settings catalogue', () => {
  for (const k of PROVIDER_KINDS) {
    const def = PROVIDER_AUTH[k];
    if (def.modeKey) assert.deepEqual([...(SETTINGS[def.modeKey].values ?? [])].sort(), [...AUTH_MODES[k]].sort(), `${def.modeKey} values == AUTH_MODES.${k}`);
    else assert.deepEqual([...AUTH_MODES[k]].sort(), ['api-key', 'none'], `${k}: a derived mode is none or api-key`);
    for (const key of Object.values(def.credentialKey)) assert.equal(SETTINGS[key!].secret, true, `${key} is write-only`);
  }
});

// #9: a token that IS saved but can't be decrypted (ASF_SECRET_KEY missing/wrong)
// is reported as such — never as "not set" — and fails only its own provider.
function stubUnreadable(reason: string) {
  global.fetch = (async () => new Response(JSON.stringify({ error: 'secret_key_error', reason }),
    { status: 409, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
}

test('an undecryptable saved token is an error with its reason, not "not set"', async () => {
  stubUnreadable('saved secret ANTHROPIC_API_KEY was encrypted with key aaaa1111, but ASF_SECRET_KEY is key bbbb2222');
  env({ AGENT_AUTH_MODE: 'api-key', ANTHROPIC_API_KEY: 'secret://org/ANTHROPIC_API_KEY' });
  await assert.rejects(computeRunAuth('anthropic'), /encrypted with key aaaa1111/);
  const d = await describeAgentAuth();
  assert.equal(d.credentialPresent, false);
  assert.match(d.error ?? '', /encrypted with key aaaa1111/);
  // a provider with no saved token is unaffected, and the bad one is just left out
  const auths = await computeRunAuths();
  assert.equal(auths.anthropic, undefined);
  assert.equal(d.providers.openai.error, undefined);
});
