import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveIdentity, assertIdentityConfig, isLoopback } from './identity.js';

// identity.ts reads AUTH_MODE / AUTH_HEADER / API_HOST from the environment at
// call time, so a test just sets them around each call — no module cache games.
function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  try { return fn(); } finally { for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

function req(headers: Record<string, string> = {}, body?: unknown) {
  return { headers, body } as unknown as import('fastify').FastifyRequest;
}

test('none mode: identity is the claimed X-Operator header, unverified', () => {
  withEnv({ AUTH_MODE: 'none' }, () => {
    assert.deepEqual(resolveIdentity(req({ 'x-operator': 'jon' })), { user: 'jon', verified: false, mode: 'none' });
  });
});

test('none mode: falls back to body.by, then to "operator"', () => {
  withEnv({ AUTH_MODE: 'none' }, () => {
    assert.equal(resolveIdentity(req({}, { by: 'alice' })).user, 'alice');
    assert.equal(resolveIdentity(req({})).user, 'operator');
  });
});

test('header mode: trusts the proxy header and strips the IAP prefix, verified', () => {
  withEnv({ AUTH_MODE: 'header', AUTH_HEADER: 'X-Goog-Authenticated-User-Email' }, () => {
    const id = resolveIdentity(req({ 'x-goog-authenticated-user-email': 'accounts.google.com:alice@example.com' }));
    assert.deepEqual(id, { user: 'alice@example.com', verified: true, mode: 'header' });
  });
});

test('header mode: a missing header is anonymous+unverified, never a spoofable fallback', () => {
  withEnv({ AUTH_MODE: 'header', AUTH_HEADER: 'X-Goog-Authenticated-User-Email' }, () => {
    assert.deepEqual(resolveIdentity(req({ 'x-operator': 'spoofed' })), { user: 'anonymous', verified: false, mode: 'header' });
  });
});

test('assertIdentityConfig: header mode on a public bind (PORT set → 0.0.0.0) is refused at boot', () => {
  withEnv({ AUTH_MODE: 'header', PORT: '8080', API_HOST: undefined, API_PUBLISH_HOST: undefined }, () => {
    assert.throws(() => assertIdentityConfig(), /requires the api to sit behind a proxy/);
  });
});

test('assertIdentityConfig: header mode on loopback is allowed', () => {
  withEnv({ AUTH_MODE: 'header', PORT: undefined, API_HOST: '127.0.0.1' }, () => {
    assert.doesNotThrow(() => assertIdentityConfig());
  });
});

test('assertIdentityConfig: none mode never refuses', () => {
  withEnv({ AUTH_MODE: 'none', PORT: '8080' }, () => {
    assert.doesNotThrow(() => assertIdentityConfig());
  });
});

// Self-host compose: the api binds 0.0.0.0 inside its container so the worker can reach it,
// and the host decides reachability through the published address (API_PUBLISH_HOST).
const COMPOSE_ENV = { AUTH_MODE: 'header', AUTH_HEADER: 'Tailscale-User-Login', PORT: '8787', API_HOST: '0.0.0.0' };

test('assertIdentityConfig: header mode in the self-host container published on loopback is allowed', () => {
  for (const pub of ['127.0.0.1', '127.0.0.53', 'localhost', '::1', '[::1]']) {
    withEnv({ ...COMPOSE_ENV, API_PUBLISH_HOST: pub }, () => {
      assert.doesNotThrow(() => assertIdentityConfig(), pub);
    });
  }
});

test('assertIdentityConfig: header mode published beyond loopback is refused, naming ASF_BIND and the header', () => {
  for (const pub of ['0.0.0.0', '100.82.18.46', '192.168.1.20', '127.0.0.1.evil', '::']) {
    withEnv({ ...COMPOSE_ENV, API_PUBLISH_HOST: pub }, () => {
      assert.throws(() => assertIdentityConfig(), (e: Error) =>
        e.message.includes(`published on ${pub} (ASF_BIND)`) && e.message.includes('Tailscale-User-Login'), pub);
    });
  }
});

test('assertIdentityConfig: a publish host decides even when the bind is loopback', () => {
  withEnv({ AUTH_MODE: 'header', PORT: undefined, API_HOST: '127.0.0.1', API_PUBLISH_HOST: '0.0.0.0' }, () => {
    assert.throws(() => assertIdentityConfig(), /published on 0\.0\.0\.0/);
  });
});

test('assertIdentityConfig: an explicit API_HOST wins over PORT, as in config.ts', () => {
  withEnv({ AUTH_MODE: 'header', PORT: '8080', API_HOST: '127.0.0.1', API_PUBLISH_HOST: undefined }, () => {
    assert.doesNotThrow(() => assertIdentityConfig());
  });
});

test('isLoopback', () => {
  assert.equal(isLoopback('127.0.0.1'), true);
  assert.equal(isLoopback('0.0.0.0'), false);
  assert.equal(isLoopback('127.0.0.1.nip.io'), false);
});

test('docker-compose.self-host.yml: API_PUBLISH_HOST is the same address the api port is published on', () => {
  const yml = readFileSync(new URL('../../../docker-compose.self-host.yml', import.meta.url), 'utf8');
  const api = yml.slice(yml.indexOf('\n  api:'), yml.indexOf('\n  ', yml.indexOf('\n    ports:', yml.indexOf('\n  api:')) + 12) + 400);
  const pub = /API_PUBLISH_HOST: (\S+)/.exec(api)?.[1];
  const port = /- '(\$\{ASF_BIND[^}]*\}):\$\{ASF_PORT[^}]*\}:8787'/.exec(api)?.[1];
  assert.ok(pub && port, 'both entries found in the api service');
  assert.equal(pub, port);
});
