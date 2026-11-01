import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentUser, asAgentArgv, killGroupArgv, killTree, spawnAgent, AS_AGENT } from './proc.js';

const AGENT = { ASF_AGENT_USER: 'agent' };

/** Stand-in for setpriv: drop its flags and exec the rest as the current user (switching uid needs the image). */
function fakeHelper(): string {
  const dir = mkdtempSync(join(tmpdir(), 'as-agent-'));
  const p = join(dir, 'as-agent');
  // Each call is logged next to it, so a test can tell the helper (not a direct signal) did the work.
  writeFileSync(p, `#!/bin/sh\necho "$*" >> ${dir}/calls\nwhile [ "$1" != "--" ]; do shift; done; shift; exec "$@"\n`);
  chmodSync(p, 0o755);
  return p;
}

test('agentUser: unset or blank means no agent user (host-worker mode keeps today\'s spawn)', () => {
  assert.equal(agentUser({}), null);
  assert.equal(agentUser({ ASF_AGENT_USER: '  ' }), null);
  assert.deepEqual(agentUser(AGENT), { user: 'agent', home: '/home/agent', helper: AS_AGENT });
});

test('asAgentArgv: setpriv drops to the agent uid/gid, keeps only the shared group, drops every capability, then execs the bin', () => {
  const [bin, argv] = asAgentArgv(agentUser(AGENT)!, 'claude', ['-p', 'hi there']);
  assert.equal(bin, AS_AGENT);
  assert.deepEqual(argv, ['--reuid=agent', '--regid=agent', '--groups=asfwork', '--inh-caps=-all', '--', 'claude', '-p', 'hi there']);
});

test('killGroupArgv: kills the whole group with bash\'s builtin, and refuses pgid 0, 1 or a negative', () => {
  const u = agentUser(AGENT)!;
  assert.deepEqual(killGroupArgv(u, 4242, 'SIGTERM')[1].slice(-3), ['bash', '-c', 'kill -TERM -- -4242']);
  assert.deepEqual(killGroupArgv(u, 4242, 'SIGKILL')[1].slice(-1), ['kill -KILL -- -4242']);
  for (const bad of [0, 1, -5, 1.5, Number.NaN]) assert.throws(() => killGroupArgv(u, bad, 'SIGTERM'), /refusing/);
});

test('spawnAgent without an agent user runs the bin itself, detached, as the worker', async () => {
  const child = spawnAgent(process.execPath, ['-e', 'console.log(process.env.HOME === "keep" ? "ok" : "bad")'], { env: { ...process.env, HOME: 'keep' }, stdio: ['ignore', 'pipe', 'pipe'] }, {});
  let out = ''; child.stdout!.on('data', (d) => (out += d));
  await new Promise((r) => child.on('close', r));
  assert.equal(out.trim(), 'ok');
  assert.equal(child.spawnfile, process.execPath);
});

test('spawnAgent with an agent user goes through the helper, with the agent\'s HOME/USER, detached', async () => {
  const helper = fakeHelper();
  const env = { ...AGENT, ASF_AS_AGENT: helper };
  const child = spawnAgent('sh', ['-c', 'echo "$HOME $USER $LOGNAME $KEEP"'], { env: { HOME: '/home/node', USER: 'node', KEEP: 'kept', PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] }, env);
  assert.equal(child.spawnfile, helper);
  assert.deepEqual(child.spawnargs.slice(1), ['--reuid=agent', '--regid=agent', '--groups=asfwork', '--inh-caps=-all', '--', 'sh', '-c', 'echo "$HOME $USER $LOGNAME $KEEP"']);
  let out = ''; child.stdout.on('data', (d) => (out += d));
  await new Promise((r) => child.on('close', r));
  assert.equal(out.trim(), '/home/agent agent agent kept');
});

test('killTree signals the process group: directly with no agent user, through the helper with one', () => {
  const calls: Array<[number, string]> = [];
  const fake = { pid: 777, kill: () => true } as unknown as import('node:child_process').ChildProcess;
  killTree(fake, 5, {}, (pgid, sig) => calls.push([pgid, sig]));
  assert.deepEqual(calls, [[777, 'SIGTERM']]);
});

test('killTree with an agent user kills a real detached group via the helper (here: a helper that runs the kill as us)', async () => {
  // Stand-in helper: drop the setpriv flags and exec the rest, as the current user.
  const helper = fakeHelper();
  {
    const env = { ...AGENT, ASF_AS_AGENT: helper };
    // A group of two: the leader and a grandchild that would outlive a parent-only kill.
    const child = spawnAgent('sh', ['-c', 'sleep 30 & wait'], { env: { PATH: process.env.PATH }, stdio: 'ignore' }, env);
    await new Promise((r) => setTimeout(r, 300));
    const pgid = child.pid!;
    const closed = new Promise<number | null>((r) => child.on('exit', (_c, s) => r(s as never)));
    killTree(child, 60_000, env);
    assert.equal(await closed, 'SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    assert.throws(() => process.kill(-pgid, 0), /ESRCH/, 'the whole group is gone, grandchild included');
    const calls = readFileSync(join(helper, '..', 'calls'), 'utf8');
    assert.match(calls, new RegExp(`-- bash -c kill -TERM -- -${pgid}`), 'the group was signalled through the helper');
  }
});

test('killTree falls back to the child itself when the group signal throws', () => {
  const sent: string[] = [];
  const fake = { pid: 778, kill: (s: string) => { sent.push(s); return true; } } as unknown as import('node:child_process').ChildProcess;
  killTree(fake, 5, {}, () => { throw new Error('ESRCH'); });
  assert.deepEqual(sent, ['SIGTERM']);
});
