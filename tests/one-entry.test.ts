/**
 * `vapor-chamber/vue` and `vapor-chamber/vapor` carry the root's whole surface, as the same functions.
 * Why: a Vue app imports one entry; if an entry lacks a root name or holds a copy, the app loses wiring or a codebase mixing root and entry gets two buses and two registries.
 * Shows: the root has a surface to compare; `/vue` exports every root name with the identical value; `/vapor` does too except `defineVaporAsyncComponent`; `/vue` adds only `enableVueReactivity`.
 * See: log s35.231.
 */
import { describe, expect } from 'vitest';
import { it } from '../src/vitest';
import * as root from '../src/index';
import * as vue from '../src/vue';
import * as vapor from '../src/vapor';

/** /vapor's own wrapper, which calls Vue's directly instead of reading the registry. */
const VAPOR_OWN = ['defineVaporAsyncComponent'];

describe('one entry per kind of app', () => {
  it('the root exports a surface to check', () => {
    expect(Object.keys(root).length).toBeGreaterThan(100);
  });

  it('/vue exports every name the root does, the same value', () => {
    const differ = Object.keys(root).filter((k) => (vue as Record<string, unknown>)[k] !== (root as Record<string, unknown>)[k]);
    expect(differ).toEqual([]);
  });

  it('/vapor exports every name the root does, the same value, but its own async wrapper', () => {
    const differ = Object.keys(root).filter((k) => (vapor as Record<string, unknown>)[k] !== (root as Record<string, unknown>)[k]);
    expect(differ).toEqual(VAPOR_OWN);
  });

  it('/vue adds only its own wiring helper to the root', () => {
    expect(Object.keys(vue).filter((k) => !(k in root))).toEqual(['enableVueReactivity']);
  });
});
