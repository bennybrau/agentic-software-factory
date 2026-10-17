import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { brotliDecompressSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Icons render via font ligatures: <span class="material-symbols-outlined">add_task</span>.
// The vendored font is a SUBSET, so an icon name missing from it never forms a
// ligature and the browser prints the raw word. That has shipped three times
// (checklist, history, add_task). This test reads every icon name the web source
// uses and checks the woff2's GSUB ligatures actually cover each one.

const SRC = path.dirname(fileURLToPath(import.meta.url));
const FONT = path.join(SRC, 'assets', 'material-symbols-subset.woff2');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}

/** Icon names in use: `icon: '<name>'` fields and the text of material-symbols spans. */
function iconsInSource(files: string[]): Set<string> {
  const names = new Set<string>();
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/\bicon:\s*'([a-z0-9_]+)'/g)) names.add(m[1]);
    for (const m of src.matchAll(/material-symbols-outlined[^>]*>([^<]*)</g)) {
      const body = m[1].trim();
      if (/^[a-z0-9_]+$/.test(body)) names.add(body);
      // `{cond ? 'a' : 'b'}` — every string literal is a candidate icon.
      else for (const lit of body.matchAll(/'([a-z0-9_]+)'/g)) names.add(lit[1]);
    }
  }
  return names;
}

// ── minimal WOFF2 -> cmap + GSUB ligature reader ──────────────────────────────
const KNOWN_TAGS = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB'];

function woff2Tables(buf: Buffer): Map<string, Buffer> {
  assert.equal(buf.toString('latin1', 0, 4), 'wOF2', 'not a woff2 file');
  const numTables = buf.readUInt16BE(12);
  let p = 48;
  const base128 = () => {
    let v = 0;
    for (let i = 0; i < 5; i++) { const b = buf[p++]; v = v * 128 + (b & 0x7f); if (!(b & 0x80)) return v; }
    throw new Error('bad UIntBase128');
  };
  const dir: { tag: string; len: number }[] = [];
  for (let i = 0; i < numTables; i++) {
    const flags = buf[p++];
    let tag = KNOWN_TAGS[flags & 0x3f] ?? `#${flags & 0x3f}`;
    if ((flags & 0x3f) === 63) { tag = buf.toString('latin1', p, p + 4); p += 4; }
    const orig = base128();
    const version = flags >> 6;
    const transformed = tag === 'glyf' || tag === 'loca' ? version !== 3 : version !== 0;
    dir.push({ tag, len: transformed ? base128() : orig });
  }
  const data = brotliDecompressSync(buf.subarray(p, p + buf.readUInt32BE(20)));
  const out = new Map<string, Buffer>();
  let off = 0;
  for (const t of dir) { out.set(t.tag, data.subarray(off, off + t.len)); off += t.len; }
  return out;
}

function charToGlyph(cmap: Buffer): Map<number, number> {
  const map = new Map<number, number>();
  const n = cmap.readUInt16BE(2);
  for (let i = 0; i < n; i++) {
    const o = cmap.readUInt32BE(4 + i * 8 + 4);
    const fmt = cmap.readUInt16BE(o);
    if (fmt === 12) {
      const groups = cmap.readUInt32BE(o + 12);
      for (let g = 0; g < groups; g++) {
        const r = o + 16 + g * 12;
        const [s, e, gid] = [cmap.readUInt32BE(r), cmap.readUInt32BE(r + 4), cmap.readUInt32BE(r + 8)];
        for (let c = s; c <= Math.min(e, 0x7f); c++) map.set(c, gid + c - s);
      }
    } else if (fmt === 4) {
      const segX2 = cmap.readUInt16BE(o + 6);
      const ends = o + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
      for (let s = 0; s < segX2 / 2; s++) {
        const end = cmap.readUInt16BE(ends + s * 2), start = cmap.readUInt16BE(starts + s * 2);
        const delta = cmap.readInt16BE(deltas + s * 2), ro = cmap.readUInt16BE(ranges + s * 2);
        for (let c = start; c <= Math.min(end, 0x7f); c++) {
          let gid: number;
          if (ro === 0) gid = (c + delta) & 0xffff;
          else { gid = cmap.readUInt16BE(ranges + s * 2 + ro + (c - start) * 2); if (gid) gid = (gid + delta) & 0xffff; }
          if (gid) map.set(c, gid);
        }
      }
    }
  }
  return map;
}

function coverage(t: Buffer, o: number): number[] {
  const fmt = t.readUInt16BE(o), n = t.readUInt16BE(o + 2), out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (fmt === 1) out.push(t.readUInt16BE(o + 4 + i * 2));
    else { const r = o + 4 + i * 6; for (let g = t.readUInt16BE(r); g <= t.readUInt16BE(r + 2); g++) out.push(g); }
  }
  return out;
}

/** Every ligature component sequence in the font, as "g1,g2,…". */
function ligatures(gsub: Buffer): Set<string> {
  const seqs = new Set<string>();
  const lookupList = gsub.readUInt16BE(8);
  const count = gsub.readUInt16BE(lookupList);
  for (let l = 0; l < count; l++) {
    const lo = lookupList + gsub.readUInt16BE(lookupList + 2 + l * 2);
    const type = gsub.readUInt16BE(lo), subCount = gsub.readUInt16BE(lo + 4);
    for (let s = 0; s < subCount; s++) {
      let so = lo + gsub.readUInt16BE(lo + 6 + s * 2);
      let st = type;
      if (type === 7) { st = gsub.readUInt16BE(so + 2); so += gsub.readUInt32BE(so + 4); }
      if (st !== 4) continue;
      const firsts = coverage(gsub, so + gsub.readUInt16BE(so + 2));
      const setCount = gsub.readUInt16BE(so + 4);
      for (let i = 0; i < setCount; i++) {
        const set = so + gsub.readUInt16BE(so + 6 + i * 2);
        const ligCount = gsub.readUInt16BE(set);
        for (let j = 0; j < ligCount; j++) {
          const lig = set + gsub.readUInt16BE(set + 2 + j * 2);
          const comps = gsub.readUInt16BE(lig + 2);
          const seq = [firsts[i]];
          for (let k = 1; k < comps; k++) seq.push(gsub.readUInt16BE(lig + 4 + (k - 1) * 2));
          seqs.add(seq.join(','));
        }
      }
    }
  }
  return seqs;
}

test('the source uses the icons we expect to find (scanner sanity check)', () => {
  const used = iconsInSource(sourceFiles(SRC));
  for (const name of ['checklist', 'chat', 'notifications', 'picture_as_pdf', 'description']) {
    assert.ok(used.has(name), `scanner missed ${name}`);
  }
});

test('Recurring tasks has its own nav icon, distinct from work history', () => {
  const src = readFileSync(path.join(SRC, 'components', 'Sidebar.tsx'), 'utf8');
  const iconFor = (route: string) => {
    const m = src.match(new RegExp(`to:\\s*'${route}'[^}]*icon:\\s*'([a-z0-9_]+)'`));
    assert.ok(m, `no LINKS entry found for ${route}`);
    return m![1];
  };
  assert.equal(iconFor('/recurring'), 'event_repeat');
  assert.notEqual(iconFor('/recurring'), iconFor('/runs'));
});

test('the vendored Material Symbols subset has a ligature for every icon the app uses', () => {
  const tables = woff2Tables(readFileSync(FONT));
  const cmap = charToGlyph(tables.get('cmap')!);
  const ligs = ligatures(tables.get('GSUB')!);
  assert.ok(ligs.size > 0, 'font has no ligatures at all');
  const missing = [...iconsInSource(sourceFiles(SRC))].filter((name) => {
    const gids = [...name].map((c) => cmap.get(c.charCodeAt(0)));
    return gids.some((g) => g === undefined) || !ligs.has(gids.join(','));
  });
  assert.deepEqual(missing, [], `icons missing from ${path.relative(SRC, FONT)} (they will render as raw text) — regenerate the subset per assets/README.md`);
});
