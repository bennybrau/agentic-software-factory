import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { preflightOllama } from './ollama-preflight.js';

let server: Server;
let base: string;
let version = '0.40.4';
before(async () => {
  server = createServer((req, res) => {
    if (req.url === '/api/version') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ version })); return; }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); });

test('local server reachable and new enough: ok', async () => {
  version = '0.40.4';
  const r = await preflightOllama({ mode: 'none', baseUrl: `${base}/v1/` }, { credentialPresent: true });
  assert.equal(r.ok, true);
  assert.match(r.ok ? r.detail ?? '' : '', /local Ollama 0\.40\.4/);
});

test('local server too old: not offered, says why', async () => {
  version = '0.13.0';
  const r = await preflightOllama({ mode: 'none', baseUrl: base }, { credentialPresent: true });
  assert.equal(r.ok, false);
  assert.match(r.ok ? '' : r.reason, /0\.13\.0.*0\.14\.0/);
  version = '0.40.4';
});

test('unreachable local server: not offered, with the container hint', async () => {
  const r = await preflightOllama({ mode: 'none', baseUrl: 'http://127.0.0.1:1' }, { credentialPresent: true });
  assert.equal(r.ok, false);
  assert.match(r.ok ? '' : r.reason, /OLLAMA_HOST=0\.0\.0\.0.*host\.docker\.internal/);
});

test('Cloud key present: ok even with no (or an unreachable) local server', async () => {
  assert.equal((await preflightOllama({ mode: 'api-key' }, { credentialPresent: true })).ok, true);
  assert.equal((await preflightOllama({ mode: 'api-key', baseUrl: 'http://127.0.0.1:1' }, { credentialPresent: true })).ok, true);
});

test('nothing set: not offered', async () => {
  const r = await preflightOllama({ mode: 'none' }, { credentialPresent: true });
  assert.equal(r.ok, false);
  assert.match(r.ok ? '' : r.reason, /OLLAMA_BASE_URL or OLLAMA_API_KEY/);
});
