import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { TicketProvider, ScmProvider, Preflight } from '@asf/shared';
import { healthBody, lastPreflights, providerPreflights, resetPreflightCache } from './provider-preflights.js';
import { TicketSet } from './providers/tickets/set.js';
import { ScmSet } from './providers/scm/set.js';

afterEach(() => resetPreflightCache());

function sets(tickets: string[], scm: string[], pf: (kind: string) => Promise<Preflight>) {
  return {
    tickets: new TicketSet(async (k) => ({ kind: k, preflight: () => pf(k) }) as unknown as TicketProvider, () => tickets),
    scm: new ScmSet(async (k) => ({ kind: k, preflight: () => pf(k) }) as unknown as ScmProvider, () => scm),
  };
}

test('/health lists every connection with its last preflight', async () => {
  const d = sets(['jira', 'github'], ['gitlab', 'github'], async (k): Promise<Preflight> => (k === 'gitlab' ? { ok: false, reason: 'down' } : { ok: true, identity: k }));
  await providerPreflights(d);
  const body = healthBody(d);
  assert.equal(body.ok, true);
  assert.deepEqual(body.tickets, [{ connection: 'jira', ok: true }, { connection: 'github', ok: true }]);
  assert.deepEqual(body.scm, [{ connection: 'gitlab', ok: false }, { connection: 'github', ok: true }]);
});

test('/health never waits: a preflight that never resolves reads "Not checked yet", and only one check is started', async () => {
  let started = 0;
  const d = sets(['jira', 'github'], ['github'], () => { started += 1; return new Promise<Preflight>(() => {}); });
  const body = healthBody(d);
  assert.deepEqual(body.tickets, [{ connection: 'jira', ok: false }, { connection: 'github', ok: false }]);
  assert.deepEqual(body.scm, [{ connection: 'github', ok: false }]);
  assert.deepEqual(lastPreflights(d).tickets[0], { connection: 'jira', pf: { ok: false, reason: 'Not checked yet' } });
  await new Promise((r) => setImmediate(r));
  assert.equal(started, 3, 'one background check per connection, never overlapping');
});

test('a connection whose build throws is a failed check; the others still pass', async () => {
  const d = {
    tickets: new TicketSet(async () => { throw new Error('JIRA_BASE_URL is empty'); }, () => ['jira']),
    scm: new ScmSet(async (k) => ({ kind: k, preflight: async () => ({ ok: true, identity: 'bot' }) }) as unknown as ScmProvider, () => ['github']),
  };
  const r = await providerPreflights(d);
  assert.deepEqual(r.tickets, [{ connection: 'jira', pf: { ok: false, reason: 'JIRA_BASE_URL is empty' } }]);
  assert.deepEqual(r.scm, [{ connection: 'github', pf: { ok: true, identity: 'bot' } }]);
});
