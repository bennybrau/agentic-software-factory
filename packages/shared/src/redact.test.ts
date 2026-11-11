import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets, TOOL_SUMMARY_MAX } from './index.js';

test('redactSecrets: URL credentials keep scheme and host', () => {
  assert.equal(redactSecrets('git clone https://oauth2:glpat-SECRETSECRET@gitlab.example.com/a/b.git'),
    'git clone https://***@gitlab.example.com/a/b.git');
  assert.equal(redactSecrets('http://u:p@h/x'), 'http://***@h/x');
});

test('redactSecrets: a Bearer token in a curl command', () => {
  const out = redactSecrets('curl -H "Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789" https://api.github.com/user');
  assert.equal(out, 'curl -H "Authorization: Bearer ***" https://api.github.com/user');
  assert.doesNotMatch(out, /abcdefgh/);
});

test('redactSecrets: secret-looking NAME=value, quoted or not', () => {
  assert.equal(redactSecrets('GITHUB_TOKEN=xyz npm publish'), 'GITHUB_TOKEN=*** npm publish');
  assert.equal(redactSecrets('export DB_PASSWORD="a b c" && run'), 'export DB_PASSWORD=*** && run');
  assert.equal(redactSecrets("MY_SECRET='s3cr3t' x"), 'MY_SECRET=*** x');
  assert.equal(redactSecrets('OPENAI_API_KEY=abc ANTHROPIC_APIKEY=def PASSWD=ghi'), 'OPENAI_API_KEY=*** ANTHROPIC_APIKEY=*** PASSWD=***');
  assert.equal(redactSecrets('NODE_ENV=production pnpm build'), 'NODE_ENV=production pnpm build');
});

test('redactSecrets: known token shapes keep their prefix', () => {
  for (const [input, want] of [
    ['ghp_abcdefghij1234567890', 'ghp_***'],
    ['gho_abcdefghij1234567890', 'gho_***'],
    ['ghs_abcdefghij1234567890', 'ghs_***'],
    ['github_pat_11ABCDEFG_abcdefghij', 'github_pat_***'],
    ['glpat-abcdefghij123456', 'glpat-***'],
    ['sk-ant-api03-abcdefghij', 'sk-ant-***'],
    ['sk-proj-abcdefghij1234', 'sk-***'],
    ['xoxb-1234567890-abcdef', 'xoxb-***'],
    ['xoxp-1234567890-abcdef', 'xoxp-***'],
    ['AKIAIOSFODNN7EXAMPLE', 'AKIA***'],
  ]) assert.equal(redactSecrets(`use ${input} now`), `use ${want} now`, input);
});

test('redactSecrets: secret flags keep the flag name, space or =, quoted or bare', () => {
  for (const [input, want] of [
    ['--token abc', '--token ***'],
    ['--token=abc', '--token=***'],
    ['--token "a b"', '--token "***"'],
    ["--token='a b'", "--token='***'"],
    ['--password hunter2', '--password ***'],
    ['--password="a b"', '--password="***"'],
    ['--secret s3', '--secret ***'],
    ['--secret=s3', '--secret=***'],
    ['--api-key k1', '--api-key ***'],
    ['--api-key=k1', '--api-key=***'],
    ['--api_key k1', '--api_key ***'],
    ['--apikey "k 1"', '--apikey "***"'],
    ['--access-token t1', '--access-token ***'],
    ['--access-token=t1', '--access-token=***'],
    ['--auth u1', '--auth ***'],
    ["--auth 'a b'", "--auth '***'"],
    ['--auth=u1', '--auth=***'],
  ]) assert.equal(redactSecrets(`gh x ${input} --verbose`), `gh x ${want} --verbose`, input);
  assert.equal(redactSecrets('cli --token --verbose'), 'cli --token --verbose');
});

test('redactSecrets: curl -u / --user keep the user', () => {
  assert.equal(redactSecrets('curl -u alice:s3cret https://x'), 'curl -u alice:*** https://x');
  assert.equal(redactSecrets('curl --user alice:s3cret https://x'), 'curl --user alice:*** https://x');
  assert.equal(redactSecrets('curl --user=alice:s3cret https://x'), 'curl --user=alice:*** https://x');
  assert.equal(redactSecrets("curl -u 'alice:a b' https://x"), "curl -u 'alice:***' https://x");
  assert.equal(redactSecrets('curl -u "alice:a b" https://x'), 'curl -u "alice:***" https://x');
});

test('redactSecrets: secret headers, bare or in quotes', () => {
  for (const [input, want] of [
    ['x-api-key: k1', 'x-api-key: ***'],
    ['"x-api-key: k 1"', '"x-api-key: ***"'],
    ['X-Auth-Token: t1', 'X-Auth-Token: ***'],
    ["'X-Auth-Token: t 1'", "'X-Auth-Token: ***'"],
    ['Private-Token: p1', 'Private-Token: ***'],
    ['"Private-Token: p 1"', '"Private-Token: ***"'],
    ['Authorization: Basic dXNlcjpwYXNz', 'Authorization: Basic ***'],
    ['"Authorization: Basic dXNlcjpwYXNz"', '"Authorization: Basic ***"'],
    ['Authorization: token abc', 'Authorization: token ***'],
    ["'Authorization: token a b'", "'Authorization: token ***'"],
    ['Authorization: Bearer abc', 'Authorization: Bearer ***'],
  ]) assert.equal(redactSecrets(`curl -H ${input} https://x`), `curl -H ${want} https://x`, input);
});

test('redactSecrets: look-alike flags and -u without a colon are left alone', () => {
  for (const s of ['tool --tokenizer foo', 'llm --max-tokens 100', 'git push -u origin main']) {
    assert.equal(redactSecrets(s), s);
  }
});

test('redactSecrets: plain text is left unchanged', () => {
  for (const s of ['pnpm --filter @asf/shared test', 'git status', 'Read: /work/wt/src/task-runner.ts', 'grep -n "token" src/a.ts', '']) {
    assert.equal(redactSecrets(s), s);
  }
  assert.equal(TOOL_SUMMARY_MAX, 160);
});
