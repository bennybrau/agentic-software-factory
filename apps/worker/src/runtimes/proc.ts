import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process';

/**
 * #68: in the worker image, agents run as their own user (ASF_AGENT_USER, `agent`), not as the worker's.
 * Linux lets a process signal only processes of its own uid, so an agent command that kills by name or
 * pattern (`pkill -f dist/index.js`, a /proc loop) can no longer reach the worker. The switch is a copy of
 * setpriv with cap_setuid/cap_setgid that only the worker's group can execute (see apps/worker/Dockerfile);
 * `--inh-caps=-all` leaves the agent with no capabilities, so it can't switch back.
 *
 * Unset (host-worker mode, other installs) means today's behaviour: the agent runs as the worker's user.
 */
export const AS_AGENT = '/usr/local/libexec/asf/as-agent';
/** The group the worker and the agent share, so each can write the worktrees and run dirs the other made. */
export const AGENT_GROUP = 'asfwork';

export interface AgentUser { user: string; home: string; helper: string }

export function agentUser(env: NodeJS.ProcessEnv = process.env): AgentUser | null {
  const user = (env.ASF_AGENT_USER ?? '').trim();
  if (!user) return null;
  return { user, home: (env.ASF_AGENT_HOME ?? '').trim() || `/home/${user}`, helper: (env.ASF_AS_AGENT ?? '').trim() || AS_AGENT };
}

/** The argv that runs `bin args` as the agent user: setpriv drops to its uid/gid, keeps the shared group, drops every capability. */
export function asAgentArgv(u: AgentUser, bin: string, args: readonly string[]): [string, string[]] {
  return [u.helper, [`--reuid=${u.user}`, `--regid=${u.user}`, `--groups=${AGENT_GROUP}`, '--inh-caps=-all', '--', bin, ...args]];
}

/**
 * Spawn a task's agent. Always detached, so the agent leads its own process group and a cancel/timeout
 * reaches every descendant. As the agent user when ASF_AGENT_USER is set, with HOME pointing at its home
 * (setpriv execs in place, so `child.pid` is the agent itself, and its pgid). Typed with streams, as
 * every adapter pipes stdout/stderr; a stream passed as 'ignore' is null, as with spawn.
 */
export function spawnAgent(bin: string, args: readonly string[], opts: SpawnOptions & { env: NodeJS.ProcessEnv }, env: NodeJS.ProcessEnv = process.env): ChildProcessWithoutNullStreams {
  const u = agentUser(env);
  if (!u) return spawn(bin, [...args], { ...opts, detached: true }) as ChildProcessWithoutNullStreams;
  const [helper, argv] = asAgentArgv(u, bin, args);
  return spawn(helper, argv, { ...opts, env: { ...opts.env, HOME: u.home, USER: u.user, LOGNAME: u.user }, detached: true }) as ChildProcessWithoutNullStreams;
}

/** The argv that signals the agent's process group from inside the agent's uid (the slim image has no `kill` binary: bash's builtin). */
export function killGroupArgv(u: AgentUser, pgid: number, sig: NodeJS.Signals): [string, string[]] {
  if (!Number.isInteger(pgid) || pgid <= 1) throw new Error(`refusing to signal process group ${pgid}`);
  return asAgentArgv(u, 'bash', ['-c', `kill -${sig.replace(/^SIG/, '')} -- -${pgid}`]);
}

export type GroupSignal = (pgid: number, sig: NodeJS.Signals) => void;

/** Signal a process group directly: the worker owns it (no agent user). */
const directSignal: GroupSignal = (pgid, sig) => { process.kill(-pgid, sig); };

/** Signal a process group through the helper, as the agent; the worker itself would get EPERM. */
function helperSignal(u: AgentUser): GroupSignal {
  return (pgid, sig) => {
    const [helper, argv] = killGroupArgv(u, pgid, sig);
    spawn(helper, argv, { stdio: 'ignore' }).on('error', () => { /* helper missing: the SIGKILL follow-up tries again */ });
  };
}

/**
 * Kill an agent's whole process tree. Adapters spawn the agent `detached: true`
 * so it leads its own process group; signalling `-pid` reaches every descendant
 * (Bash-tool children, test runners, dev servers) — killing only the parent leaves
 * them orphaned and still writing to the worktree. SIGTERM first, SIGKILL after
 * `graceMs` if the group is still alive. Falls back to the single child when the
 * group signal fails (not detached, or already gone). An agent that runs as its own
 * user is signalled through the helper (#68).
 */
export function killTree(child: ChildProcess, graceMs = 10_000, env: NodeJS.ProcessEnv = process.env, signal?: GroupSignal): void {
  const u = agentUser(env);
  const sigGroup = signal ?? (u ? helperSignal(u) : directSignal);
  const send = (sig: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    try { sigGroup(child.pid, sig); } catch { try { child.kill(sig); } catch { /* already gone */ } }
  };
  send('SIGTERM');
  const t = setTimeout(() => send('SIGKILL'), graceMs);
  t.unref?.();
}
