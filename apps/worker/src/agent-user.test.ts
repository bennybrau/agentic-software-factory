import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { groupId, prepareSharedDirs } from './agent-user.js';

const AGENT = { ASF_AGENT_USER: 'agent' };

function fakeDeps(start: Record<string, { gid: number; mode: number }>) {
  const fs = { ...start };
  const runs: Array<[string, string[]]> = [];
  const logs: string[] = [];
  return {
    fs, runs, logs,
    deps: {
      gid: async (g: string) => (g === 'asfwork' ? 1500 : null),
      stat: async (p: string) => fs[p] ?? null,
      // chgrp + find -exec chmod g+s is what fixes the root; model just that.
      run: async (cmd: string, args: string[]) => {
        runs.push([cmd, args]);
        const root = cmd === 'find' ? args[0]! : args[args.length - 1]!;
        if (fs[root] && cmd === 'chgrp') fs[root] = { ...fs[root]!, gid: 1500 };
        if (fs[root] && cmd === 'find' && args.includes('g+s')) fs[root] = { ...fs[root]!, mode: fs[root]!.mode | 0o2000 };
      },
      log: (m: string) => { logs.push(m); },
    },
  };
}

test('prepareSharedDirs: no agent user → touches nothing', async () => {
  const f = fakeDeps({ '/data/worktrees': { gid: 1000, mode: 0o40755 } });
  assert.deepEqual(await prepareSharedDirs(['/data/worktrees'], {}, f.deps), []);
  assert.equal(f.runs.length, 0);
});

test('prepareSharedDirs: an upgraded node:node volume is regrouped, made group-writable, setgid on dirs, clones shared', async () => {
  const f = fakeDeps({ '/data/worktrees': { gid: 1000, mode: 0o40755 }, '/data/runs': { gid: 1000, mode: 0o40755 } });
  assert.deepEqual(await prepareSharedDirs(['/data/worktrees', '/data/runs'], AGENT, f.deps), ['/data/worktrees', '/data/runs']);
  const forWt = f.runs.filter(([, a]) => a.includes('/data/worktrees')).map(([c, a]) => `${c} ${a.join(' ')}`);
  assert.deepEqual(forWt, [
    'chgrp -R asfwork /data/worktrees',
    'chmod -R g+rwX /data/worktrees',
    'find /data/worktrees -type d -exec chmod g+s {} +',
    'find /data/worktrees -maxdepth 2 -type d -name *.git -exec git --git-dir={} config core.sharedRepository group ;',
  ]);
});

test('prepareSharedDirs is idempotent: the second start does nothing', async () => {
  const f = fakeDeps({ '/data/worktrees': { gid: 1000, mode: 0o40755 } });
  await prepareSharedDirs(['/data/worktrees'], AGENT, f.deps);
  const n = f.runs.length;
  assert.deepEqual(await prepareSharedDirs(['/data/worktrees'], AGENT, f.deps), []);
  assert.equal(f.runs.length, n);
});

test('prepareSharedDirs: in the group but no setgid (a half-done migration) is redone; a missing root is skipped', async () => {
  const f = fakeDeps({ '/data/runs': { gid: 1500, mode: 0o40775 } });
  assert.deepEqual(await prepareSharedDirs(['/data/worktrees', '/data/runs'], AGENT, f.deps), ['/data/runs']);
});

test('prepareSharedDirs: an image without the group logs and changes nothing', async () => {
  const f = fakeDeps({ '/data/runs': { gid: 1000, mode: 0o40755 } });
  assert.deepEqual(await prepareSharedDirs(['/data/runs'], AGENT, { ...f.deps, gid: async () => null }), []);
  assert.equal(f.runs.length, 0);
  assert.match(f.logs[0]!, /group asfwork doesn't exist/);
});

test('groupId reads /etc/group', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'grp-'));
  const p = join(dir, 'group');
  writeFileSync(p, 'root:x:0:\nnode:x:1000:\nasfwork:x:1500:node,agent\nbad:x:nan:\n');
  assert.equal(await groupId('asfwork', p), 1500);
  assert.equal(await groupId('node', p), 1000);
  assert.equal(await groupId('bad', p), null);
  assert.equal(await groupId('nope', p), null);
  assert.equal(await groupId('x', join(dir, 'missing')), null);
});
