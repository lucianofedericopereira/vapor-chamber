/** One pattern rule, one classifier: every reader of an action pattern agrees with it. The long note is at the end. */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { matchesPattern, _patternPrefix } from '../src/pattern';
import { createAsyncCommandBus, createCommandBus, _scoped, type Transport } from '../src/command-bus';
import { authGuard } from '../src/plugins-core';

const PATTERNS = ['*', 'cart*', 'cartAdd', 'cartAdd*', 'c*'];
const NAMES = ['cartAdd', 'cartAddMany', 'cart', 'cartRemove', 'userLogin', 'c', 'x'];

/** What the one rule says: a trailing `*` matches what starts with the text before it, any other pattern one name. */
const rule = (pattern: string, action: string): boolean =>
  pattern.endsWith('*') ? action.startsWith(pattern.slice(0, -1)) : pattern === action;

/** Whether `on(pattern)` hears a dispatch of `action`, and whether `offAll(pattern)` takes it out. */
function heard(pattern: string, action: string): { heard: boolean; afterOffAll: boolean } {
  const bus = createCommandBus();
  bus.register(action, () => 1);
  let n = 0;
  bus.on(pattern, () => { n++; });
  bus.dispatch(action, null);
  const first = n === 1;
  bus.offAll(pattern);
  bus.dispatch(action, null);
  return { heard: first, afterOffAll: n === (first ? 1 : 0) };
}

/** Whether a transport declared for `pattern` sends `action` (the most specific match, `mostSpecific`). */
async function sent(pattern: string, action: string): Promise<boolean> {
  let sends = 0;
  const transport: Transport = { send: () => { sends++; return { ok: true, value: 1, error: undefined }; } };
  const bus = createAsyncCommandBus({ retry: false, onMissing: 'ignore', transport: { [pattern]: transport } });
  await bus.dispatch(action, null);
  return sends === 1;
}

/** Whether authGuard({ protected: [pattern] }) refuses `action` for a signed-out caller. */
function guarded(pattern: string, action: string): boolean {
  const bus = createCommandBus();
  bus.register(action, () => 1);
  bus.use(authGuard({ isAuthenticated: () => false, protected: [pattern] }));
  return !bus.dispatch(action, null).ok;
}

describe('the one pattern classifier', () => {
  it('classifies: a trailing * is a prefix, * every action, any other a name', () => {
    expect(PATTERNS.map(_patternPrefix)).toEqual(['', 'cart', undefined, 'cartAdd', 'c']);
    expect(_patternPrefix('')).toBeUndefined();
  });

  it('every reader agrees with it, pattern by pattern and action by action', async () => {
    for (const p of PATTERNS) {
      for (const a of NAMES) {
        const want = rule(p, a);
        const got = {
          matchesPattern: matchesPattern(p, a),
          scoped: _scoped({ actions: [p] })!(a),
          on: heard(p, a),
          transport: await sent(p, a),
          authGuard: guarded(p, a),
        };
        expect([p, a, got]).toEqual([p, a, { matchesPattern: want, scoped: want, on: { heard: want, afterOffAll: true }, transport: want, authGuard: want }]);
      }
    }
  });

  it('the most specific pattern wins over the written order (control for the rank)', async () => {
    const hits: string[] = [];
    const t = (id: string): Transport => ({ id, send: () => { hits.push(id); return { ok: true, value: 1, error: undefined }; } });
    const bus = createAsyncCommandBus({ retry: false, transport: { '*': t('all'), 'c*': t('c'), 'cart*': t('cart'), cartAdd: t('exact') } });
    for (const a of ['cartAdd', 'cartRemove', 'cx', 'user']) await bus.dispatch(a, null);
    expect(hits).toEqual(['exact', 'cart', 'c', 'all']);
  });

  it('no other src file tests a pattern for its trailing *', () => {
    const root = resolve(__dirname, '../src');
    const sites: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith('.ts')) {
          const n = readFileSync(p, 'utf8').match(/charCodeAt\([^)]*\)\s*===\s*42|endsWith\('\*'\)|===\s*'\*'/g)?.length ?? 0;
          if (n > 0) sites.push(`${p.slice(root.length + 1)}:${n}`);
        }
      }
    };
    walk(root);
    // pattern.ts: `_patternPrefix` itself. router/table.ts reads a route
    // segment and vite-hmr.ts a file glob: neither is an action pattern.
    expect(sites.sort()).toEqual(['pattern.ts:1', 'router/table.ts:1', 'vite-hmr.ts:1']);
  });
});

/*
 * An action pattern means one thing across the library (memory
 * one-term-one-meaning): a trailing `*` matches every action that starts with
 * the text before it, so `*` matches every action, and any other pattern is
 * one action's name. Before plan 1.32 step 8a five places classified a
 * pattern on their own: `on()` and `offAll()` (isWildcardPattern),
 * `matchesPattern`, `_scoped`, `mostSpecific`'s rank and authGuard's
 * `protected`. `_patternPrefix` is the one classifier now, and each of them
 * reads it. The agreement table runs every reader through the bus it serves:
 * a listener, a plugin's scope, a transport map, a guard. authGuard read a
 * bare name as a prefix until log 36.104: one meaning now, there too. The
 * source guard is the total rule: no src file tests a pattern's trailing `*`
 * outside the classifier.
 */
