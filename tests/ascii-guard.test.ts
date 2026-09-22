/**
 * scripts/check-ascii.mjs - the guard's two alphabets, tested from outside.
 * See the note at the end of this file.
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

/**
 * Every character this file needs to talk about, BUILT FROM ITS CODEPOINT.
 *
 * Same rule check-ascii.mjs applies to itself, for the same reason: this is a
 * file about forbidden characters, and typing one would put it in the tree the
 * guard scans. `tests/` is held to the alphabet, so a literal em dash here
 * would fail the very check this suite exists to keep honest - and U+FFFD
 * would make the file read as binary to its own `isText` below.
 */
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

/**
 * An UNFILTERED walk. The guard's own `walk` selects by EXTENSIONS, so reusing
 * it here would ask the list to confirm itself and agree every time.
 */
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
    // Guards the walker itself: an empty sweep would make every assertion below
    // vacuously true, which is the exact shape this suite exists to reject.
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
    // The inverse mistake: listing .png would make the guard "scan" 6 files of
    // compressed bytes and report codepoints found inside them.
    const binaryListed = new Set<string>();
    for (const file of all) {
      const ext = extensionOf(file);
      if (EXTENSIONS.includes(ext) && !isText(file)) binaryListed.add(ext);
    }
    expect([...binaryListed]).toEqual([]);
  });
});

describe('check-ascii: the ROOT is covered by the tree, not by a list', () => {
  // Asks git what is in the root, the way the suite above asks the filesystem
  // what is under the roots. See the note at the end of this file.
  const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter((p) => p !== '' && !p.includes('/'));

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
    // A guard that fires on everything is as useless as one that fires on
    // nothing, and this line is the half that is easy to forget.
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

// ---------------------------------------------------------------------------
// Why this file exists
// ---------------------------------------------------------------------------
//
// scripts/check-ascii.mjs had no test at all, and it is a guard whose entire
// behaviour is two lists. Its own header records three times a list was wrong:
// the arrows (48 of them, in 15 files, after a sweep reported "complete"), four
// console glyphs sitting in shipped strings, and a census that turned up 9,300
// characters it had no opinion about. Each time the fix was to widen the
// CHARACTER alphabet, and each time the method was for a person to notice.
//
// The fourth failure was the other list. `.astro`, `.sh` and `.tsx` were not in
// EXTENSIONS, so 28 lines across three files carried em dashes, an ellipsis and
// a times sign while the guard printed `ascii: OK (425 files, no typographic
// non-ASCII)`. Nobody had questioned the file list because the character list
// was where the bugs had always been.
//
// A list cannot audit itself. Both suites here get their answer from somewhere
// the guard does not control:
//
//   - the FILE alphabet is checked against the TREE. Walk everything, decode
//     it, and any file that is text but whose extension is unlisted is a gap.
//     This is what would have caught `.astro` the day it was added, and what
//     will catch `.svelte` or `.mdx` on the day someone adds one. The walker
//     here is deliberately NOT the guard's own, which filters by EXTENSIONS and
//     would therefore agree with it unconditionally.
//
//   - the CHARACTER alphabet is checked by FEEDING IT OFFENDERS. A regex that
//     matches nothing reports a clean sweep, which is indistinguishable from
//     success by every other means. So each banned class is handed a file
//     containing exactly it, and a clean file is handed over too.
//
// The binary assertion is the inverse mistake and is cheap to hold: listing
// `.png` would have the guard read 6 files of compressed bytes and report
// codepoints found inside them. That is not hypothetical - it is what the first
// draft of the sweep that found this bug did, and the noise buried the three
// real files.
//
// Every character above is built with String.fromCodePoint. Writing them as
// literals would have put an em dash into `tests/`, which the guard scans, and
// a U+FFFD into a file whose own `isText` treats that character as proof of
// binary - the file would have excluded itself from the sweep it defines. Both
// happened in the first draft.
