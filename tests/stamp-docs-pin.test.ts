// Pinned stamps: `vc:NAME@<npm range>` is stamped only while package.json's version satisfies the range.
import { describe, expect, it } from 'vitest';
import { stampMarkers } from '../scripts/stamp-docs.mjs';

const VALUES = { sizeCore: '4.9' };
const marker = (pin: string, body: string) => `<!-- vc:sizeCore${pin} -->${body}<!-- /vc:sizeCore${pin} -->`;

describe('stamp-docs: pinned markers', () => {
  it('control: an unpinned marker is stamped and reported stale, as before', () => {
    const out = stampMarkers(`a ${marker('', '4.8')} b`, VALUES, '1.30.0', 'f.md');
    expect(out.text).toBe(`a ${marker('', '4.9')} b`);
    expect(out.stale).toEqual(['f.md: vc:sizeCore is "4.8", source says "4.9"']);
    expect(out.errors).toEqual([]);
  });

  it('a pin the version satisfies is stamped like an unpinned marker', () => {
    const out = stampMarkers(marker('@1.30', '4.8'), VALUES, '1.30.2', 'f.md');
    expect(out.text).toBe(marker('@1.30', '4.9'));
    expect(out.stale).toEqual(['f.md: vc:sizeCore is "4.8", source says "4.9"']);
    expect(out.errors).toEqual([]);
  });

  it('a pin the version has left is frozen: untouched and never stale', () => {
    const text = marker('@1.30', '4.8');
    const out = stampMarkers(text, VALUES, '1.31.0', 'f.md');
    expect(out).toEqual({ text, stale: [], errors: [] });
  });

  it('a prerelease version satisfies its X.Y pin', () => {
    const out = stampMarkers(marker('@1.31', '4.8'), VALUES, '1.31.0-rc.1', 'f.md');
    expect(out.text).toBe(marker('@1.31', '4.9'));
  });

  it('any npm range works, spaces and > included', () => {
    const out = stampMarkers(marker('@>=1.29 <1.31', '4.8'), VALUES, '1.30.0', 'f.md');
    expect(out.text).toBe(marker('@>=1.29 <1.31', '4.9'));
  });

  it('two pins of one name keep their own bodies, the closing tag repeats the range', () => {
    const text = `${marker('@1.0', '3.1')} then ${marker('@1.30', '4.8')}`;
    const out = stampMarkers(text, VALUES, '1.30.0', 'f.md');
    expect(out.text).toBe(`${marker('@1.0', '3.1')} then ${marker('@1.30', '4.9')}`);
  });

  it('a range npm rejects is an error naming the file and the marker', () => {
    for (const range of ['not-a-range', '>2 <1']) {
      const text = marker(`@${range}`, '4.8');
      const out = stampMarkers(text, VALUES, '1.30.0', 'f.md');
      expect(out.text).toBe(text);
      expect(out.errors).toEqual([`f.md: vc:sizeCore@${range} is not an npm range any version satisfies`]);
    }
  });

  it('a range that starts above the current version is an error, not a silent wait', () => {
    const text = marker('@1.40', '4.8');
    const out = stampMarkers(text, VALUES, '1.30.0', 'f.md');
    expect(out.text).toBe(text);
    expect(out.errors).toEqual(['f.md: vc:sizeCore@1.40 starts above package.json version 1.30.0']);
  });

  it('a bad range is an error even when its value has no source in this run', () => {
    const out = stampMarkers('<!-- vc:testFiles@1.40 -->179<!-- /vc:testFiles@1.40 -->', {}, '1.30.0', 'f.md');
    expect(out.errors).toEqual(['f.md: vc:testFiles@1.40 starts above package.json version 1.30.0']);
  });
});

// Why pins exist. The whitepaper quotes earlier versions of itself "as they
// stood" (appendix A, part C), and those quotes carried live markers, so every
// release rewrote the quote with today's number (audit row WPA-1). A pin
// freezes a marker at the value it held when the range was last satisfied.
//
// The two error cases exist because a frozen marker is never stale: a typo such
// as `@1.40` for `@1.30` would otherwise wait silently until 1.40 and then start
// rewriting history, and a range no version satisfies would never be stamped at
// all. The last case runs with no values on purpose: on a fresh checkout the
// test counts have no source, and the range is still checked there.
