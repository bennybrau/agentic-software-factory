import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SKILL_MAX_FILES, SKILL_MAX_TOTAL_BYTES } from '@asf/shared';
import { fetchSkill, parseFrontmatter, parseSkillUrl } from './fetch.js';

const SHA = 'a'.repeat(40);
const SKILL_MD = '---\nname: pdf-tools\ndescription: "Work with PDFs: split, merge."\n---\n# PDF tools\n';

type Routes = Record<string, () => Response>;
/** A fetch that answers exact URLs from `routes` and 404s anything else; records every URL asked for. */
function fakeFetch(routes: Routes) {
  const urls: string[] = [];
  const f = (async (input: string) => {
    urls.push(input);
    const r = routes[input];
    if (!r) return new Response('not found', { status: 404 });
    return r();
  }) as unknown as typeof fetch;
  return { fetch: f, urls };
}
const json = (v: unknown, headers: Record<string, string> = {}) => () => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json', ...headers } });
const text = (s: string | Uint8Array) => () => new Response(typeof s === 'string' ? s : Buffer.from(s));

const GH = 'https://api.github.com/repos/acme/skills';
const RAW = `https://raw.githubusercontent.com/acme/skills/${SHA}`;
/** A GitHub repo with the skill under skills/pdf at `main`, plus `extra` files. */
function github(files: Record<string, string | Uint8Array>, opts: { sizes?: Record<string, number>; truncated?: boolean } = {}) {
  const routes: Routes = {
    [`${GH}/commits/main`]: json({ sha: SHA }),
    [`${GH}/git/trees/${SHA}?recursive=1`]: json({
      truncated: opts.truncated ?? false,
      tree: [
        { path: 'README.md', type: 'blob', mode: '100644', size: 10 },
        { path: 'skills', type: 'tree' },
        { path: 'skills/pdf', type: 'tree' },
        ...Object.entries(files).map(([p, c]) => ({ path: `skills/pdf/${p}`, type: 'blob', mode: '100644', size: opts.sizes?.[p] ?? (typeof c === 'string' ? Buffer.byteLength(c) : c.length) })),
      ],
    }),
  };
  for (const [p, c] of Object.entries(files)) routes[`${RAW}/skills/pdf/${p}`] = text(c);
  return fakeFetch(routes);
}

test('parseSkillUrl reads GitHub tree and blob links', () => {
  const tree = parseSkillUrl('https://github.com/acme/skills/tree/main/skills/pdf');
  assert.deepEqual(tree, { ok: true, kind: 'github', host: 'github.com', project: 'acme/skills', ref: 'main', path: 'skills/pdf', segments: ['main', 'skills', 'pdf'] });
  const blob = parseSkillUrl('https://github.com/acme/skills/blob/main/skills/pdf/SKILL.md');
  assert.ok(blob.ok);
  assert.equal(blob.path, 'skills/pdf');
  const root = parseSkillUrl('https://github.com/acme/skills/tree/v1/');
  assert.ok(root.ok);
  assert.equal(root.path, '');
});

test('parseSkillUrl reads GitLab links with subgroups', () => {
  const p = parseSkillUrl('https://gitlab.example.com/team/sub/skills/-/tree/main/pdf');
  assert.deepEqual(p, { ok: true, kind: 'gitlab', host: 'gitlab.example.com', project: 'team/sub/skills', ref: 'main', path: 'pdf', segments: ['main', 'pdf'] });
  const blob = parseSkillUrl('https://gitlab.com/g/p/-/blob/main/pdf/SKILL.md');
  assert.ok(blob.ok);
  assert.equal(blob.path, 'pdf');
});

test('parseSkillUrl refuses bad shapes, other blobs, non-https and local hosts', () => {
  for (const url of [
    'not a url',
    'http://github.com/acme/skills/tree/main/pdf',
    'https://github.com/acme/skills',
    'https://github.com/acme/skills/pulls/1/x',
    'https://github.com/acme/skills/blob/main/pdf/README.md',
    'https://gitlab.com/g/p/tree/main/pdf',
    'https://localhost/g/p/-/tree/main/pdf',
    'https://127.0.0.1/g/p/-/tree/main/pdf',
    'https://[::1]/g/p/-/tree/main/pdf',
    'https://user:pw@github.com/acme/skills/tree/main/pdf',
    'https://github.com/acme/skills/tree/main/a%2F..%2Fb/pdf',
  ]) {
    const p = parseSkillUrl(url);
    assert.equal(p.ok, false, url);
  }
});

test('parseFrontmatter handles quotes, folded and literal blocks, and ignores nested keys', () => {
  const fm = parseFrontmatter("---\r\nname: 'it''s'\r\ndescription: >-\r\n  one\r\n  two\r\n\r\n  three\r\nmetadata:\r\n  owner: x\r\nnotes: |\r\n  a\r\n  b\r\n---\r\nbody");
  assert.deepEqual(fm, { name: "it's", description: 'one two\nthree', metadata: '', notes: 'a\nb' });
  assert.equal(parseFrontmatter('# no frontmatter'), null);
});

test('GitHub: fetches the folder pinned to the commit, relative paths, skipping scripts, images and binary text', async () => {
  const { fetch, urls } = github({
    'SKILL.md': SKILL_MD,
    'docs/guide.md': 'guide',
    'run.sh': 'echo hi',
    'tool.py': 'print(1)',
    'logo.png': new Uint8Array([0x89, 0x50]),
    'data.txt': 'a\0b',
    'latin.txt': new Uint8Array([0xff, 0xfe, 0x41]),
  });
  const r = await fetchSkill('https://github.com/acme/skills/tree/main/skills/pdf', { fetch });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.skill.name, 'pdf-tools');
  assert.equal(r.skill.description, 'Work with PDFs: split, merge.');
  assert.equal(r.skill.commitSha, SHA);
  assert.equal(r.skill.sourceRef, 'main');
  assert.deepEqual(r.skill.files.map((f) => f.path), ['docs/guide.md', 'SKILL.md']);
  assert.deepEqual(r.skipped.map((s) => s.path).sort(), ['data.txt', 'latin.txt', 'logo.png', 'run.sh', 'tool.py']);
  // Files are read at the pinned SHA, never at the ref; scripts are never downloaded.
  assert.ok(urls.includes(`${RAW}/skills/pdf/SKILL.md`));
  assert.ok(!urls.some((u) => u.endsWith('run.sh') || u.endsWith('logo.png')));
});

test('GitHub: a ref with slashes is found by trying longer prefixes', async () => {
  const { fetch, urls } = fakeFetch({
    [`${GH}/commits/release%2F1.2`]: json({ sha: SHA }),
    [`${GH}/git/trees/${SHA}?recursive=1`]: json({ tree: [{ path: 'pdf/SKILL.md', type: 'blob', mode: '100644', size: SKILL_MD.length }] }),
    [`${RAW}/pdf/SKILL.md`]: text(SKILL_MD),
  });
  const r = await fetchSkill('https://github.com/acme/skills/tree/release/1.2/pdf', { fetch });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.skill.sourceRef, 'release/1.2');
  assert.equal(urls[0], `${GH}/commits/release`);
});

test('GitHub: an unknown repo or ref, and a truncated tree, are refused', async () => {
  const missing = await fetchSkill('https://github.com/acme/nope/tree/main/pdf', { fetch: fakeFetch({}).fetch });
  assert.equal(missing.ok, false);
  const { fetch } = github({ 'SKILL.md': SKILL_MD }, { truncated: true });
  const truncated = await fetchSkill('https://github.com/acme/skills/tree/main/skills/pdf', { fetch });
  assert.ok(!truncated.ok);
  assert.match(truncated.reason, /too big/);
});

test('GitLab: lists every page, pins the SHA and downloads by encoded path', async () => {
  const api = 'https://gitlab.example.com/api/v4/projects/team%2Fskills/repository';
  const tree = (page: number) => `${api}/tree?recursive=true&ref=${SHA}&path=pdf&per_page=100&page=${page}`;
  const { fetch, urls } = fakeFetch({
    [`${api}/commits/main`]: json({ id: SHA }),
    [tree(1)]: json([{ path: 'pdf/SKILL.md', type: 'blob', mode: '100644' }, { path: 'pdf/refs', type: 'tree' }], { 'x-next-page': '2' }),
    [tree(2)]: json([{ path: 'pdf/refs/a.md', type: 'blob', mode: '100644' }, { path: 'pdf/x.sh', type: 'blob', mode: '100755' }], { 'x-next-page': '' }),
    [`${api}/files/pdf%2FSKILL.md/raw?ref=${SHA}`]: text(SKILL_MD),
    [`${api}/files/pdf%2Frefs%2Fa.md/raw?ref=${SHA}`]: text('ref a'),
  });
  const r = await fetchSkill('https://gitlab.example.com/team/skills/-/tree/main/pdf', { fetch });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.skill.commitSha, SHA);
  assert.deepEqual(r.skill.files.map((f) => f.path), ['refs/a.md', 'SKILL.md']);
  assert.deepEqual(r.skipped.map((s) => s.path), ['x.sh']);
  assert.ok(urls.includes(tree(2)));
});

test('a missing SKILL.md, or one without a name or description, is refused', async () => {
  const noEntry = await fetchSkill('https://github.com/acme/skills/tree/main/skills/pdf', { fetch: github({ 'README.md': 'hi' }).fetch });
  assert.ok(!noEntry.ok);
  assert.match(noEntry.reason, /no SKILL\.md/);

  const noName = await fetchSkill('https://github.com/acme/skills/tree/main/skills/pdf', { fetch: github({ 'SKILL.md': '---\ndescription: d\n---\n' }).fetch });
  assert.ok(!noName.ok);
  assert.match(noName.reason, /no name/);

  const noDescription = await fetchSkill('https://github.com/acme/skills/tree/main/skills/pdf', { fetch: github({ 'SKILL.md': '---\nname: pdf\n---\n' }).fetch });
  assert.ok(!noDescription.ok);
  assert.match(noDescription.reason, /no description/);

  const badName = await fetchSkill('https://github.com/acme/skills/tree/main/skills/pdf', { fetch: github({ 'SKILL.md': '---\nname: PDF Tools\ndescription: d\n---\n' }).fetch });
  assert.ok(!badName.ok);
  assert.match(badName.reason, /lower-case/);
});

test('a rule-based skill with 76 small files plus SKILL.md is accepted', async () => {
  const files: Record<string, string> = { 'SKILL.md': SKILL_MD };
  for (let i = 0; i < 76; i++) files[`rules/r${i}.md`] = `# Rule ${i}\n`;
  const r = await fetchSkill('https://github.com/acme/skills/tree/main/skills/pdf', { fetch: github(files).fetch });
  assert.ok(r.ok, r.ok ? '' : r.reason);
  assert.equal(r.skill.files.length, 77);
});

test('too many files, or too many bytes, are refused', async () => {
  const many: Record<string, string> = { 'SKILL.md': SKILL_MD };
  for (let i = 0; i < SKILL_MAX_FILES; i++) many[`f${i}.md`] = 'x';
  const tooMany = github(many);
  const r1 = await fetchSkill('https://github.com/acme/skills/tree/main/skills/pdf', { fetch: tooMany.fetch });
  assert.ok(!r1.ok);
  assert.match(r1.reason, new RegExp(`at most ${SKILL_MAX_FILES} `));
  assert.ok(!tooMany.urls.some((u) => u.startsWith(RAW)), 'nothing downloaded');

  const bySize = github({ 'SKILL.md': SKILL_MD, 'big.md': 'x' }, { sizes: { 'big.md': SKILL_MAX_TOTAL_BYTES } });
  const r2 = await fetchSkill('https://github.com/acme/skills/tree/main/skills/pdf', { fetch: bySize.fetch });
  assert.ok(!r2.ok);
  assert.match(r2.reason, /bigger than/);

  // The tree lied about the size: the actual bytes still count.
  const byBytes = github({ 'SKILL.md': SKILL_MD, 'big.md': 'x'.repeat(SKILL_MAX_TOTAL_BYTES) }, { sizes: { 'big.md': 1 } });
  const r3 = await fetchSkill('https://github.com/acme/skills/tree/main/skills/pdf', { fetch: byBytes.fetch });
  assert.ok(!r3.ok);
  assert.match(r3.reason, /bigger than/);
});
