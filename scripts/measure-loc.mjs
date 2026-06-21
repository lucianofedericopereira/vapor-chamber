/**
 * measure-loc — code-vs-comment line counter.
 *
 * Reports each .ts file as code / comment / blank lines, so source size is
 * measured as CODE, not raw lines. Counting raw lines (or stripping comments to
 * look "smaller") is an invitation to write cryptic, comment-free code — this
 * separates the two so good comments are never a size penalty.
 *
 * A line with any code counts as code even if it has a trailing comment, so the
 * "code" column is never inflated by comments and comments are never code.
 *
 * Run: node scripts/measure-loc.mjs [dir=src]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

function classify(src) {
  let blank = 0, comment = 0, code = 0, inBlock = false;
  for (const raw of src.split('\n')) {
    const line = raw.trim();
    if (inBlock) {
      comment++;
      const end = line.indexOf('*/');
      if (end !== -1) {
        inBlock = false;
        const after = line.slice(end + 2).trim();
        if (after && !after.startsWith('//')) { comment--; code++; }
      }
      continue;
    }
    if (line === '') { blank++; continue; }
    if (line.startsWith('//')) { comment++; continue; }
    if (line.startsWith('/*')) {
      comment++;
      if (line.indexOf('*/', 2) === -1) inBlock = true;
      else {
        const after = line.slice(line.indexOf('*/', 2) + 2).trim();
        if (after && !after.startsWith('//')) { comment--; code++; }
      }
      continue;
    }
    code++;
  }
  return { blank, comment, code };
}

const dir = process.argv[2] || 'src';
const files = walk(dir).sort();
let tc = 0, tcm = 0, tb = 0;
const rows = [];
for (const f of files) {
  const r = classify(readFileSync(f, 'utf8'));
  rows.push({ f: f.replace(dir + '/', ''), ...r });
  tc += r.code; tcm += r.comment; tb += r.blank;
}
rows.sort((a, b) => b.code - a.code);
const pad = (s, n) => String(s).padEnd(n);
const padl = (s, n) => String(s).padStart(n);
console.log(pad('file', 34) + padl('code', 7) + padl('cmt', 7) + padl('blank', 7) + padl('cmt%', 7));
console.log('-'.repeat(62));
for (const r of rows) {
  const cpct = r.code + r.comment ? Math.round((r.comment / (r.code + r.comment)) * 100) : 0;
  console.log(pad(r.f, 34) + padl(r.code, 7) + padl(r.comment, 7) + padl(r.blank, 7) + padl(cpct + '%', 7));
}
console.log('-'.repeat(62));
console.log(pad(`TOTAL (${rows.length} files)`, 34) + padl(tc, 7) + padl(tcm, 7) + padl(tb, 7) +
  padl(Math.round((tcm / (tc + tcm)) * 100) + '%', 7));
