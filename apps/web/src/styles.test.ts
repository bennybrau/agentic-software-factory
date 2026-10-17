import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const css = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'styles.css'),
  'utf8',
);

test('.btn.good and .btn.bad set their own dark label colour', () => {
  assert.match(css, /\.btn\.good\s*\{[^}]*color:\s*#0b1020[^}]*\}/);
  assert.match(css, /\.btn\.bad\s*\{[^}]*color:\s*#0b1020[^}]*\}/);
});

test('.btn.good/.btn.bad rule is more specific than the later .ok/.bad/.warn text helpers', () => {
  const btnRuleIndex = css.search(/\.btn\.good\s*\{/);
  const helperRuleIndex = css.search(/\.ok\s*\{\s*color:\s*var\(--good\)/);
  assert.ok(btnRuleIndex >= 0 && helperRuleIndex >= 0);
  // The helper rule (lower specificity, single class) comes later in source order,
  // so it must not also target `.btn` for the override to hold.
  assert.ok(helperRuleIndex > btnRuleIndex);
  const helperLine = css.slice(helperRuleIndex).split('\n')[0];
  assert.doesNotMatch(helperLine, /\.btn/);
});

test('any .clickable element (not only table rows) gets a pointer cursor', () => {
  assert.match(css, /(^|\n)\.clickable\s*\{[^}]*cursor:\s*pointer[^}]*\}/);
});

test('links, summaries and enabled buttons get a pointer cursor', () => {
  const rule = css.match(/(^|\n)([^{}\n]+)\{[^}]*cursor:\s*pointer[^}]*\}/g)
    ?.find((r) => /\bsummary\b/.test(r) && /button:not\(:disabled\)/.test(r));
  assert.ok(rule, 'expected a base rule covering a, summary, button:not(:disabled)');
  const selectors = rule.slice(0, rule.indexOf('{')).split(',').map((s) => s.trim());
  for (const sel of ['a', 'summary', 'button:not(:disabled)']) assert.ok(selectors.includes(sel), sel);
});

test('button labels never wrap', () => {
  assert.match(css, /(^|\n)\.btn\s*\{[^}]*white-space:\s*nowrap[^}]*\}/);
});

test('the Dispatch header squeezes the title, not the button group', () => {
  assert.match(css, /(^|\n)\.dispatch-actions\s*\{[^}]*flex:\s*none[^}]*\}/);
  assert.match(css, /(^|\n)\.dispatch-head h2\s*\{[^}]*min-width:\s*0[^}]*\}/);
});

test('the Run page title centres the state badge on the ticket key with a gap', () => {
  const rule = css.match(/(^|\n)\.run-title\s*\{([^}]*)\}/);
  assert.ok(rule, 'expected a .run-title rule');
  assert.match(rule[2], /display:\s*flex/);
  assert.match(rule[2], /align-items:\s*center/);
  assert.match(rule[2], /gap:\s*\d+px/);
  assert.match(css, /(^|\n)\.run-title \.pill\s*\{[^}]*white-space:\s*nowrap[^}]*\}/);
});

test('completed run lanes (.lane.done) fade back with opacity < 1', () => {
  const rule = css.match(/(^|\n)\.lane\.done\s*\{([^}]*)\}/);
  assert.ok(rule, 'expected a .lane.done rule');
  const opacity = rule[2].match(/opacity:\s*([\d.]+)/);
  assert.ok(opacity && Number(opacity[1]) < 1);
});

test('the theme corner decor is clearly visible but stays a background (.14 < opacity <= .35)', () => {
  const rule = css.match(/(^|\n)\.theme-decor\s*\{([^}]*)\}/);
  assert.ok(rule, 'expected a .theme-decor rule');
  const opacity = rule[2].match(/opacity:\s*([\d.]+)/);
  assert.ok(opacity, 'expected .theme-decor to set an opacity');
  const value = Number(opacity[1]);
  assert.ok(value > 0.14 && value <= 0.35, `opacity ${value}`);
});

test('the working animation is switched off under prefers-reduced-motion', () => {
  assert.match(css, /\.working-dots i\s*\{[^}]*animation:\s*wbounce/);
  const reduced = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\)\s*\{([^\n]*)\}/g)].map((m) => m[1]);
  assert.ok(reduced.some((body) => /\.working-dots i\s*\{\s*animation:\s*none/.test(body)));
});

test('the sidebar stacks above .content so its footer popovers are not hidden', () => {
  const zIndexOf = (selector: string) => {
    const rule = css.match(new RegExp(`(^|\\n)${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`));
    assert.ok(rule, `expected a base ${selector} rule`);
    const z = rule[2].match(/z-index:\s*(-?\d+)/);
    assert.ok(z, `expected ${selector} to set a z-index`);
    return Number(z[1]);
  };
  assert.ok(zIndexOf('.sidebar') > zIndexOf('.content'));
});

test('the update banner keeps its button and dismiss × on one row', () => {
  assert.match(css, /(^|\n)\.update-banner \.update-actions\s*\{[^}]*flex-direction:\s*row[^}]*\}/);
  assert.match(css, /(^|\n)\.update-banner \.update-actions\s*\{[^}]*flex-wrap:\s*nowrap[^}]*\}/);
});

test('long words wrap inside chat bubbles and the plan artifact', () => {
  assert.match(css, /(^|\n)\.chat-msg\s*\{[^}]*overflow-wrap:\s*anywhere[^}]*\}/);
  assert.match(css, /(^|\n)\.chat-msg\s*\{[^}]*min-width:\s*0[^}]*\}/);
  assert.match(css, /(^|\n)pre\.artifact\s*\{[^}]*overflow-wrap:\s*anywhere[^}]*\}/);
});

test('on phones the update banner text wraps instead of running past the border', () => {
  assert.match(css, /@media \(max-width: 639px\)\s*\{[^@]*\.update-banner > span:first-child > b\s*\{[^}]*white-space:\s*normal[^}]*overflow-wrap:\s*anywhere[^}]*\}/);
});

test('on phones the Dispatch role dropdowns move to their own line', () => {
  assert.match(css, /@media \(max-width: 639px\)\s*\{[^@]*\.role-row\s*\{[^}]*flex-wrap:\s*wrap[^}]*\}/);
  assert.match(css, /@media \(max-width: 639px\)\s*\{[^@]*\.role-picks\s*\{[^}]*flex-basis:\s*100%[^}]*\}/);
  assert.match(css, /@media \(max-width: 639px\)\s*\{[^@]*\.role-picks select\s*\{[^}]*min-width:\s*0[^}]*\}/);
});

test('done crew avatars (Hive stage and mini-Hive) are dimmed, not merely greyed', () => {
  for (const selector of ['.hive-member.st-done:not(.on)', '.mini-member.st-done:not(.on)']) {
    const rule = css.match(new RegExp(`(^|\\n)${selector.replace(/[.():]/g, '\\$&')}\\s*\\{([^}]*)\\}`));
    assert.ok(rule, `expected a ${selector} rule`);
    assert.match(rule[2], /filter:\s*grayscale\(\.?8\)/, selector);
    const opacity = rule[2].match(/opacity:\s*([\d.]+)/);
    assert.ok(opacity && Number(opacity[1]) < 0.65, `${selector} should dim below the old .65/.6`);
  }
});

test('a done member with its own state pictures (M13) is muted too, not forced back to full strength', () => {
  for (const selector of ['.hive-member.own-states', '.mini-member.own-states']) {
    const plain = css.match(new RegExp(`(^|\\n)${selector.replace(/\./g, '\\.')}\\s*\\{`));
    assert.ok(!plain, `the own-states override for ${selector} must not apply unconditionally to done members`);
    const narrowed = css.match(new RegExp(`(^|\\n)${selector.replace(/\./g, '\\.')}:not\\(\\.st-done\\)\\s*\\{([^}]*)\\}`));
    assert.ok(narrowed, `expected ${selector}:not(.st-done) to carry the "none/1" override instead`);
    assert.match(narrowed[2], /filter:\s*none\s*!important/);
    assert.match(narrowed[2], /opacity:\s*1\s*!important/);
  }
});

/** The body of the main phone media query (the one with the tab bar), up to its closing brace. */
function phoneBlock(): string {
  const start = css.indexOf('@media (max-width: 639px) {\n');
  assert.ok(start >= 0, 'expected the multi-line phone media query block');
  const end = css.indexOf('\n}', start);
  return css.slice(start, end);
}

test('on phones the header and tab bar stay put and only .content scrolls between them', () => {
  const phone = phoneBlock();
  const ruleOf = (selector: string) => {
    const rule = phone.match(new RegExp(`(^|\\n)\\s*${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`));
    assert.ok(rule, `expected a ${selector} override inside the phone media query`);
    return rule[2];
  };
  const shell = ruleOf('.shell');
  assert.match(shell, /display:\s*flex/);
  assert.match(shell, /flex-direction:\s*column/);
  assert.match(shell, /height:\s*100dvh/);
  assert.match(shell, /overflow:\s*hidden/);
  const content = ruleOf('.content');
  assert.match(content, /overflow-y:\s*auto/);
  assert.match(content, /min-height:\s*0/);
  // No longer reserves room for a bar that covered it; the bar now takes its own space in the flex flow.
  assert.doesNotMatch(content, /padding-bottom/);
  const topbar = ruleOf('.topbar');
  assert.doesNotMatch(topbar, /position:\s*sticky/);
  assert.match(topbar, /flex:\s*none/);
  const sidebar = ruleOf('.sidebar');
  assert.doesNotMatch(sidebar, /position:\s*fixed/);
  assert.match(sidebar, /flex:\s*none/);
  assert.match(sidebar, /order:\s*1/);
  assert.match(sidebar, /env\(safe-area-inset-bottom\)/);
});

test('the old hamburger drawer is gone', () => {
  assert.doesNotMatch(css, /\.hamburger|\.drawer-/);
});

test('index.html sets a device-width viewport, so phones get the phone layout', () => {
  const html = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8');
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/);
});

test('the Orchestrator chat classes exist, each with a phone rule', () => {
  const phone = [...css.matchAll(/@media \(max-width: 639px\)\s*\{([\s\S]*?)\n\}/g)].map((m) => m[1]).join('\n');
  for (const cls of ['.chat-page', '.chat-composer', '.chat-proposed', '.chat-empty']) {
    assert.match(css, new RegExp(`(^|\\n)\\${cls}\\s*\\{`), `${cls} rule`);
    assert.ok(phone.includes(cls), `${cls} needs a max-width: 639px rule`);
  }
});
