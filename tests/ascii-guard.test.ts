/**
 * scripts/check-ascii.mjs: its two lists, the file extensions and the banned characters, tested from outside.
 * Why: a list cannot audit itself; an extension never scanned, or a regex that matches nothing, both report a clean sweep.
 * Shows: every text file on disk has its extension listed and no binary one is; root files and top dirs are covered; each banned class fires, plain ASCII passes.
 */
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

import { execFileSync } from 'node:child_process';

import {
  EXTENSIONS,
  ROOT_EXEMPT,
  ROOTS,
  SKIP_DIRS,
  bannedFor,
  collectFiles,
  scan,
} from '../scripts/check-ascii.mjs';

const root = process.cwd();

/** Built from codepoints: a literal would fail the guard here, and U+FFFD would make this file read as binary. */
const CH = {
  emDash: String.fromCodePoint(0x2014),
  enDash: String.fromCodePoint(0x2013),
  ellipsis: String.fromCodePoint(0x2026),
  times: String.fromCodePoint(0x00d7),
  arrow: String.fromCodePoint(0x2192),
  nbsp: String.fromCodePoint(0x00a0),
  zwsp: String.fromCodePoint(0x200b),
  bullet: String.fromCodePoint(0x2022),
  emoji: String.fromCodePoint(0x2705),
  replacement: String.fromCodePoint(0xfffd),
};

/** An unfiltered walk: the guard's own filters by EXTENSIONS, so it would agree with itself. */
function walkAll(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkAll(full, out);
    else out.push(full);
  }
  return out;
}

/** Text = decodes as UTF-8 with no NUL and no replacement character. */
function isText(path: string): boolean {
  const buf = readFileSync(path);
  if (buf.includes(0)) return false;
  return !buf.toString('utf8').includes(CH.replacement);
}

/** '.tsx' for 'a/b.tsx'; '' for a dotfile with no extension, which cannot drift. */
function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf(sep) + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot);
}

describe('check-ascii: the FILE alphabet matches what is actually on disk', () => {
  const all = ROOTS.flatMap((r: string) => walkAll(join(root, r)));

  it('finds files to classify', () => {
    // Guards the walker: an empty sweep makes every assertion below vacuously true.
    expect(all.length).toBeGreaterThan(100);
  });

  it('every text file under the scanned roots has its extension in EXTENSIONS', () => {
    const missing = new Map<string, string>();
    for (const file of all) {
      const ext = extensionOf(file);
      if (ext === '' || EXTENSIONS.includes(ext)) continue;
      if (!isText(file)) continue; // binary: nothing to read, nothing to ban
      if (!missing.has(ext)) missing.set(ext, relative(root, file));
    }
    expect(
      [...missing].map(([ext, example]) => `${ext} (e.g. ${example})`),
      'a text extension exists that check-ascii does not scan - add it to EXTENSIONS',
    ).toEqual([]);
  });

  it('does not claim extensions that are binary', () => {
    // The inverse mistake: a listed binary extension is read as text and reports noise.
    const binaryListed = new Set<string>();
    for (const file of all) {
      const ext = extensionOf(file);
      if (EXTENSIONS.includes(ext) && !isText(file)) binaryListed.add(ext);
    }
    expect([...binaryListed]).toEqual([]);
  });
});

/** Tracked root-level files, or null when `root` is not a git checkout. */
function gitRootFiles(): string[] | null {
  let out: string;
  try {
    out = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
  return out.split('\n').filter((p) => p !== '' && !p.includes('/'));
}

describe('check-ascii: the ROOT is covered by the tree, not by a list', () => {
  // Outside a git checkout, every regular file in the root: a superset of what git tracks, never weaker.
  const tracked = gitRootFiles() ?? readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => d.name);

  it('finds tracked root files to classify', () => {
    expect(tracked.length).toBeGreaterThan(5);
  });

  it('every tracked root-level text file is scanned, or exempt with a reason', () => {
    const opened = new Set(collectFiles());
    const missed = tracked.filter(
      (p) => isText(join(root, p)) && !opened.has(p) && !ROOT_EXEMPT.has(p),
    );
    expect(
      missed,
      'a tracked text file sits in the repository root and check-ascii never opens it',
    ).toEqual([]);
  });

  it('every exemption names a file that is there, and says why', () => {
    for (const [name, why] of ROOT_EXEMPT) {
      expect(statSync(join(root, name)).isFile(), `${name} is exempt but not in the root`).toBe(true);
      expect(why.length, `${name} is exempt with no reason given`).toBeGreaterThan(10);
    }
  });
});

/** Top-level directories holding tracked files, or null when `root` is not a git checkout. */
function gitTopDirs(): string[] | null {
  let out: string;
  try {
    out = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
  return [...new Set(out.split('\n').filter((p) => p.includes('/')).map((p) => p.slice(0, p.indexOf('/'))))];
}

describe('check-ascii: ROOTS is checked against the tree', () => {
  // Outside a git checkout, every directory in the root that is not skipped:
  // a superset of what git tracks, as for the root files above.
  const dirs = gitTopDirs() ?? readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !SKIP_DIRS.has(d.name))
    .map((d) => d.name);

  it('finds tracked top-level directories to classify', () => {
    expect(dirs.length).toBeGreaterThan(5);
  });

  it('every tracked top-level directory is a scanned root', () => {
    expect(
      dirs.filter((d) => !ROOTS.includes(d)),
      'a tracked top-level directory that check-ascii never opens - add it to ROOTS',
    ).toEqual([]);
  });
});

describe('check-ascii: the CHARACTER alphabet actually fires', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'vc-ascii-'));

  const write = (name: string, body: string): string => {
    const p = join(tmp, name);
    writeFileSync(p, body);
    return p;
  };

  it('reports an em dash outside src/, on the right line', () => {
    const hits = scan([write('prose.md', `one\ntwo ${CH.emDash} three\nfour\n`)]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain('em-dash');
    expect(hits[0]).toContain(':2');
  });

  it.each([
    [CH.enDash, 'en-dash'],
    [CH.ellipsis, 'ellipsis'],
    [CH.times, 'times-sign'],
    [CH.arrow, 'arrow'],
    [CH.nbsp, 'non-breaking-space'],
    [CH.zwsp, 'zero-width-space'],
  ])('reports the %s class', (ch, name) => {
    const hits = scan([write(`c-${name}.md`, `x${ch}y\n`)]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain(name);
  });

  it('passes a file that is plain ASCII', () => {
    // A guard that fires on everything is as useless as one that fires on nothing.
    expect(scan([write('clean.md', 'plain - ascii ... x -> y\n')])).toEqual([]);
  });

  // The two alphabets are different, and only the src/ one is exhaustive.
  it('bans everything above U+007F under src/, and only the alphabet elsewhere', () => {
    expect(bannedFor(`src${sep}x.ts`).test(CH.bullet)).toBe(true);
    expect(bannedFor(`docs${sep}x.md`).test(CH.bullet)).toBe(false);
    // Astral, so it matches on its lead surrogate rather than as one unit.
    expect(bannedFor(`src${sep}x.ts`).test(CH.emoji)).toBe(true);
  });
});
