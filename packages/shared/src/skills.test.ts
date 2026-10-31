import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skillFileSchema, skillInputSchema, skillRolesSchema, thirdPartySkillSchema, skillBodyLimitBytes, SKILL_MAX_FILES, SKILL_MAX_TOTAL_BYTES, SKILL_NAME_RE, type SkillInput } from './skills.js';

const skill: SkillInput = {
  id: 'pdf-tools', name: 'pdf-tools', description: 'Work with PDFs',
  sourceUrl: 'https://github.com/acme/skills/tree/main/pdf-tools', sourceRef: 'main', commitSha: 'a1b2c3d4e5f6',
  files: [{ path: 'SKILL.md', content: '---\nname: pdf-tools\n---\nHello' }, { path: 'ref/forms.md', content: 'forms' }],
  addedBy: 'ana',
};
const firstIssue = (r: { success: boolean; error?: { issues: { message: string }[] } }) => r.error?.issues[0]?.message ?? '';

test('a well-formed skill parses, as input and as a stored record', () => {
  assert.ok(skillInputSchema.safeParse(skill).success);
  assert.ok(thirdPartySkillSchema.safeParse({ ...skill, enabled: true, roles: ['planner', 'tester'], updatedAt: new Date().toISOString() }).success);
});

test('file paths must be relative, never climb out, and end in an allowed extension', () => {
  for (const path of ['notes.md', 'a/b.TXT', 'data.json', 'c.yaml', 'd.yml', 'e.csv']) assert.ok(skillFileSchema.safeParse({ path, content: '' }).success, path);
  for (const path of ['/etc/x.md', '../x.md', 'a/../../x.md', 'run.sh', 'image.png', 'README', '.md', '']) {
    assert.equal(skillFileSchema.safeParse({ path, content: '' }).success, false, path);
  }
});

test('files must include SKILL.md, be unique, and stay within the count and size limits', () => {
  assert.match(firstIssue(skillInputSchema.safeParse({ ...skill, files: [{ path: 'other.md', content: '' }] })), /SKILL\.md/);
  assert.match(firstIssue(skillInputSchema.safeParse({ ...skill, files: [...skill.files, skill.files[0]] })), /unique/);
  assert.equal(skillInputSchema.safeParse({ ...skill, files: [] }).success, false);
  const many = Array.from({ length: SKILL_MAX_FILES }, (_, i) => ({ path: i === 0 ? 'SKILL.md' : `f${i}.md`, content: '' }));
  assert.ok(skillInputSchema.safeParse({ ...skill, files: many }).success);
  assert.equal(skillInputSchema.safeParse({ ...skill, files: [...many, { path: 'extra.md', content: '' }] }).success, false);
  // A rule-based skill (SKILL.md plus ~76 rules, like Vercel's react-best-practices) fits.
  const ruleBased = [{ path: 'SKILL.md', content: 'x' }, ...Array.from({ length: 76 }, (_, i) => ({ path: `rules/r${i}.md`, content: 'rule' }))];
  assert.ok(skillInputSchema.safeParse({ ...skill, files: ruleBased }).success);
  const exact = [{ path: 'SKILL.md', content: 'x'.repeat(SKILL_MAX_TOTAL_BYTES) }];
  assert.ok(skillInputSchema.safeParse({ ...skill, files: exact }).success);
  // Counted in UTF-8 bytes, not characters: two-byte characters halve what fits.
  assert.match(firstIssue(skillInputSchema.safeParse({ ...skill, files: [{ path: 'SKILL.md', content: 'é'.repeat(SKILL_MAX_TOTAL_BYTES / 2 + 1) }] })), /KB/);
});

test('roles are the four roles, non-empty and unique', () => {
  assert.ok(skillRolesSchema.safeParse(['planner', 'implementer', 'tester', 'reviewer']).success);
  assert.equal(skillRolesSchema.safeParse([]).success, false);
  assert.equal(skillRolesSchema.safeParse(['planner', 'planner']).success, false);
  assert.equal(skillRolesSchema.safeParse(['orchestrator']).success, false);
});

test('the frontmatter name and id patterns', () => {
  assert.ok(SKILL_NAME_RE.test('pdf-tools2'));
  assert.ok(SKILL_NAME_RE.test('a'.repeat(64)));
  assert.equal(SKILL_NAME_RE.test('a'.repeat(65)), false);
  assert.equal(SKILL_NAME_RE.test('PDF_tools'), false);
  assert.equal(skillInputSchema.safeParse({ ...skill, id: 'Bad Id' }).success, false);
});

test('the body limit holds a full skill once JSON-escaped', () => {
  const worst = JSON.stringify({ op: 'putSkill', skill: { ...skill, files: [{ path: 'SKILL.md', content: '\u0000'.repeat(SKILL_MAX_TOTAL_BYTES) }] } });
  assert.ok(Buffer.byteLength(worst) <= skillBodyLimitBytes());
});
