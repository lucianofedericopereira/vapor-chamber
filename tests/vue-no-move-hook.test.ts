/**
 * The shipped Vue runtime dists, current and the `vue35` copy, searched for an `onMove` hook.
 * Why: `createTransitionBridge` documents `onMove` as a hook the app calls, not one Vue calls; if a Vue added a hook of that name, the bridge would have to hand it to Vue again.
 * Shows: no runtime-core, runtime-dom, runtime-vapor or vue dist .js file contains the text `onMove`, and `moveClass` is found in them as a positive control; a hook name built at runtime would escape this text search.
 * See: log s36.6, src/transitions.ts
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
