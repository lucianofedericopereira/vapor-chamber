/**
 * GUARD - no installed Vue runtime has an `onMove` hook. The bridge's
 * `onMove` docblock rests on it. The long note is at the end of this file.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

/** Every .js file in the dist of each runtime package, resolved from `from`. */
function runtimeDists(from: string): string[] {
  const req = createRequire(from);
  const files: string[] = [];
  for (const pkg of ['@vue/runtime-core', '@vue/runtime-dom', '@vue/runtime-vapor', 'vue']) {
    let dir: string;
    try {
      dir = join(dirname(req.resolve(`${pkg}/package.json`)), 'dist');
    } catch {
      continue; // Vue 3.5 has no runtime-vapor
    }
    for (const f of readdirSync(dir)) if (f.endsWith('.js')) files.push(join(dir, f));
  }
  return files;
}

const copies = {
  current: require.resolve('vue/package.json'),
  'vue 3.5': require.resolve('vue35/package.json'),
};

describe('Vue calls no onMove hook', () => {
  for (const [name, from] of Object.entries(copies)) {
    it(`${name}: no runtime file names onMove, and moveClass is found (control)`, () => {
      const files = runtimeDists(from);
      const named = (word: string) => files.filter((f) => readFileSync(f, 'utf8').includes(word));
      expect(named('moveClass').length).toBeGreaterThan(0);
      expect(named('onMove')).toEqual([]);
    });
  }
});

/*
 * WHY THIS FILE EXISTS. `createTransitionBridge` returns an `onMove` that
 * dispatches `<namespace>Move`, and until the rc.11 cycle its docblock said
 * Vue calls it on a TransitionGroup move. Vue has no such hook: not in
 * BaseTransition, Transition or TransitionGroup, on either renderer, at any
 * 3.6 tag checked (beta.13, beta.17, rc.1, rc.5, rc.11) nor in 3.5. A real
 * Chromium reorder with a CSS move transform called no bridge function
 * (docs/rc-alignment-log.md, 36.6 R2). Every earlier test called the hook by
 * hand.
 *
 * So the bridge keeps `onMove` out of a spread and documents it as a hook the
 * app calls. If a later Vue adds a hook by that name, this fails, and the
 * bridge should hand it to Vue again.
 *
 * It reads the shipped runtime dists, current and the `vue35` copy, rather
 * than a source checkout: what an app installs is what calls the hooks. A
 * hook name built at runtime would escape a text search, so the cycle record
 * also lists runtime-dom's `callHook` sites. `moveClass` is the positive
 * control: TransitionGroup's own move option, in every Vue that has one.
 */
