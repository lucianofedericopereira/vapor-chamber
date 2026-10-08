// /vue and /vapor carry the root's whole surface, as the same functions; rationale at the end.
import { describe, expect } from 'vitest';
import { it } from '../src/vitest';
import * as root from '../src/index';
import * as vue from '../src/vue';
import * as vapor from '../src/vapor';

/** /vapor's own wrapper, which calls Vue's directly instead of reading the registry (src/vapor.ts). */
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

/*
 * Why this file exists. A Vue app imports one entry: vapor-chamber/vue, or
 * vapor-chamber/vapor for Vapor. Both carry the root's surface (the bus,
 * plugins, transports, the HTTP client) as well as the composables, through
 * `export * from './index'` in src/vue.ts. Of four builds of an app that took
 * its composables from the root, three lost some wiring (log s35.231). The
 * values must be the root's own, never copies, so a codebase mixing the
 * root and an entry still has one shared bus and one registry. The last case
 * pins the other direction: the entry adds nothing but its wiring helper.
 */
