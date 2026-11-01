import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { AGENT_GROUP, agentUser } from './runtimes/proc.js';

const exec = promisify(execFile);

/**
 * #68: with agents running as their own user, the worker and the agent must each be able to write
 * what the other made in the worktrees and run dirs. The worker runs with umask 002, and these roots
 * belong to the shared group with setgid on every directory, so new files inherit the group.
 *
 * An install upgraded from an image without the agent user has volumes full of `node:node 0755/0644`
 * files. The first start fixes them: chgrp -R, chmod -R g+rwX, setgid on dirs, and
 * core.sharedRepository=group on the bare clones. Idempotent: a root already in the group with
 * setgid set is left alone (the check is one stat).
 */
export interface SharedDirsDeps {
  gid: (group: string) => Promise<number | null>;
  stat: (path: string) => Promise<{ gid: number; mode: number } | null>;
  run: (cmd: string, args: string[]) => Promise<void>;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

const defaultDeps = (log: SharedDirsDeps['log']): SharedDirsDeps => ({
  gid: groupId,
  stat: async (p) => stat(p).then((s) => ({ gid: s.gid, mode: s.mode }), () => null),
  run: async (cmd, args) => { await exec(cmd, args, { maxBuffer: 16 * 1024 * 1024 }); },
  log,
});

/** A group's gid from /etc/group, or null if it doesn't exist. */
export async function groupId(group: string, etcGroup = '/etc/group'): Promise<number | null> {
  const text = await readFile(etcGroup, 'utf8').catch(() => '');
  for (const line of text.split('\n')) {
    const [name, , gid] = line.split(':');
    if (name === group && gid && /^\d+$/.test(gid)) return Number(gid);
  }
  return null;
}

const SETGID = 0o2000;

/** Returns the roots it migrated (empty when there was nothing to do, or no agent user). */
export async function prepareSharedDirs(roots: string[], env: NodeJS.ProcessEnv = process.env, deps: Partial<SharedDirsDeps> & Pick<SharedDirsDeps, 'log'>): Promise<string[]> {
  if (!agentUser(env)) return [];
  const d = { ...defaultDeps(deps.log), ...deps };
  const gid = await d.gid(AGENT_GROUP);
  if (gid === null) { d.log(`agent user set but group ${AGENT_GROUP} doesn't exist; not changing ${roots.join(', ')}`); return []; }
  const done: string[] = [];
  for (const root of roots) {
    const st = await d.stat(root);
    if (!st) continue; // created later, by the worker, under its umask and the parent's setgid
    if (st.gid === gid && (st.mode & SETGID) !== 0) continue;
    d.log('sharing worker dirs with the agent user (one-time)', { root, group: AGENT_GROUP });
    await d.run('chgrp', ['-R', AGENT_GROUP, root]);
    await d.run('chmod', ['-R', 'g+rwX', root]);
    await d.run('find', [root, '-type', 'd', '-exec', 'chmod', 'g+s', '{}', '+']);
    // Bare clones (and the worktrees' admin dirs inside them): objects git writes from now on are group-writable whatever the umask.
    await d.run('find', [root, '-maxdepth', '2', '-type', 'd', '-name', '*.git', '-exec', 'git', '--git-dir={}', 'config', 'core.sharedRepository', 'group', ';']);
    done.push(root);
  }
  return done;
}
