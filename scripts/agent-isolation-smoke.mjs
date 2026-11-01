#!/usr/bin/env node
/**
 * #68 smoke: an agent can't kill the worker. Run INSIDE a running worker container, as the worker's user:
 *
 *   docker compose -f docker-compose.self-host.yml exec -T worker node - < scripts/agent-isolation-smoke.mjs
 *
 * It spawns an "agent" exactly as a task would (the worker's own spawnAgent), and the agent tries every way
 * an implementer has killed a worker: `pkill -f dist/index.js`, the /proc loop from bennybrau/hive#10, and
 * `kill -TERM -1`. Then it checks the worker process is still alive, that the agent really ran as the agent
 * user with no capabilities, that worker and agent can each write the other's files, and that the worker's
 * killTree still ends a running agent's whole process group. Exits non-zero on any failure.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const proc = await import('/app/apps/worker/dist/runtimes/proc.js');
let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!proc.agentUser()) { console.log('FAIL ASF_AGENT_USER is not set in this container'); process.exit(1); }
process.umask(0o002);

const cmdline = (pid) => { try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim(); } catch { return ''; } };
const workerPid = readdirSync('/proc').filter((p) => /^\d+$/.test(p)).find((p) => cmdline(p) === 'node apps/worker/dist/index.js');
ok(Boolean(workerPid), `found the worker process (pid ${workerPid})`);

function runAgent(script, timeoutMs = 20_000) {
  const child = proc.spawnAgent('bash', ['-c', script], { cwd: '/tmp', env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (out += d));
  return new Promise((resolve) => {
    const t = setTimeout(() => { proc.killTree(child, 1000); }, timeoutMs);
    child.on('close', (code) => { clearTimeout(t); resolve({ code, out }); });
  });
}

// 1. Who the agent is.
const who = await runAgent('id -u; id -nG; grep CapEff /proc/self/status | cut -f2; echo HOME=$HOME');
const [uid, groups, capEff, home] = who.out.trim().split('\n');
ok(uid !== String(process.getuid()), `agent uid ${uid} differs from the worker's ${process.getuid()}`);
ok(/\basfwork\b/.test(groups ?? '') && !/\bnode\b/.test(groups ?? ''), `agent groups "${groups}": asfwork, not node`);
ok(/^0+$/.test(capEff ?? ''), `agent has no effective capabilities (CapEff ${capEff})`);
ok(home === 'HOME=/home/agent', `agent ${home}`);

// 2. The kills that took a worker down, and more.
const attack = await runAgent(`
  pkill -f "dist/index.js"; echo "pkill exit $?"   # not in the slim image (no procps), hence agents' /proc loops
  for p in /proc/[0-9]*; do
    n=\${p#/proc/}; [ "$n" = "$$" ] && continue      # this script's own cmdline holds the pattern too
    c=$(tr '\\0' ' ' < $p/cmdline 2>/dev/null)
    case "$c" in *dist/index.js*) echo "kill $n ($c): $(kill -TERM $n 2>&1 || true)";; esac
  done
  kill -TERM -1 2>&1; echo "kill -1 exit $?"
  kill -TERM 1 2>&1 || echo "pid 1 refused"
  ${proc.AS_AGENT} --reuid=node --regid=node -- id 2>&1 || echo "helper refused"
  cat /proc/${workerPid}/environ >/dev/null 2>&1 || echo "environ refused"
`);
console.log(attack.out.split('\n').map((l) => `      agent: ${l}`).join('\n'));
await sleep(1500);
let alive = false; try { process.kill(Number(workerPid), 0); alive = true; } catch { /* gone */ }
ok(alive && cmdline(workerPid) === 'node apps/worker/dist/index.js', 'the worker survived pkill -f, the /proc loop, kill -1 and kill 1');
ok(/helper refused/.test(attack.out), 'the agent cannot run the user-switch helper');
ok(/environ refused/.test(attack.out), "the agent cannot read the worker's environment (its secrets)");

// 3. Shared files: each side writes what the other made.
const dir = join(process.env.RUN_DATA_ROOT || '/data/runs', `isolation-smoke-${process.pid}`);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'by-worker'), 'w\n');
const files = await runAgent(`cd ${dir} && echo a >> by-worker && echo a > by-agent && mkdir sub && echo a > sub/f && stat -c '%U:%G %a %n' by-agent sub`);
ok(files.code === 0, `the agent appended to the worker's file and made its own (${files.out.trim().replace(/\n/g, '; ')})`);
let workerWrote = false; try { writeFileSync(join(dir, 'by-agent'), 'w\n', { flag: 'a' }); writeFileSync(join(dir, 'sub', 'g'), 'w\n'); workerWrote = true; } catch (e) { console.log(`      ${e.message}`); }
ok(workerWrote, "the worker writes into the agent's file and directory");
ok((statSync(join(dir, 'sub')).mode & 0o2000) !== 0, 'directories the agent makes keep setgid (the shared group is inherited)');
try { rmSync(dir, { recursive: true, force: true }); ok(true, 'the worker can delete a tree the agent wrote'); } catch (e) { ok(false, `the worker can delete a tree the agent wrote: ${e.message}`); }

// 4. Cancel still works: killTree ends a running agent's whole group (leader + a background grandchild).
const child = proc.spawnAgent('bash', ['-c', 'sleep 300 & sleep 300 & wait'], { cwd: '/tmp', env: { PATH: process.env.PATH }, stdio: 'ignore' });
await sleep(800);
const pgid = child.pid;
let direct = 'signalled';
try { process.kill(-pgid, 0); } catch (e) { direct = e.code; }
ok(direct === 'EPERM', `the worker can't signal the agent group directly (${direct})`);
const exited = new Promise((r) => child.on('exit', (_c, s) => r(s)));
proc.killTree(child, 2000);
ok((await exited) === 'SIGTERM', 'killTree (through the helper) ended the agent leader with SIGTERM');
await sleep(500);
const left = readdirSync('/proc').filter((p) => /^\d+$/.test(p)).filter((p) => { try { return readFileSync(`/proc/${p}/stat`, 'utf8').split(') ')[1].split(' ')[2] === String(pgid); } catch { return false; } });
ok(left.length === 0, `no process left in the agent's group (${left.length})`);

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
