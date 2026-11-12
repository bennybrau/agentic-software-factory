import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);

// #120: the worker image sets ASF_AGENT_USER, and a tester's test run inherits it. test-setup.mjs clears it
// so spawnAgent/killTree take the host path. The fixture spawns a fake claude through runSegment.
const WORKER = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE = 'src/segment.refs.test.ts';

function agentEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ASF_AGENT_USER: 'agent', ASF_AS_AGENT: '/nonexistent/as-agent' };
  delete env.NODE_TEST_CONTEXT; // a nested `node --test` would otherwise report to this one's parent
  return env;
}

async function exitCode(bin: string, args: string[]): Promise<number> {
  try {
    await exec(bin, args, { cwd: WORKER, env: agentEnv(), timeout: 60_000 });
    return 0;
  } catch (e) {
    return typeof (e as { code?: unknown }).code === 'number' ? (e as { code: number }).code : -1;
  }
}

test('the test script\'s argv clears the agent user, so the fixture passes with ASF_AGENT_USER set', async () => {
  assert.equal(await exitCode(process.execPath, ['--test', '--import', 'tsx', '--import', './test-setup.mjs', FIXTURE]), 0);
});

test('the test:file script clears the agent user too', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> };
  assert.match(pkg.scripts['test']!, /--import \.\/test-setup\.mjs/);
  assert.equal(await exitCode('sh', ['-c', `${pkg.scripts['test:file']} ${FIXTURE}`]), 0);
});

test('control: without the setup import the fixture goes through the missing helper and fails', async () => {
  assert.notEqual(await exitCode(process.execPath, ['--test', '--import', 'tsx', FIXTURE]), 0);
});
