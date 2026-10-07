// @vitest-environment happy-dom
/** Router guards and bus hooks, the same cases side by side. The long note is at the end. */
import { describe, expect, it, vi } from 'vitest';
import { createAsyncCommandBus, createCommandBus } from '../src/command-bus';
import { createTestBus } from '../src/testing';
import { isRouterError } from '@router/errors';
import { makeRouter } from './router/fixture';

const tick = () => new Promise((r) => setTimeout(r, 0));

async function router() {
  const r = makeRouter({ links: false, announce: false });
  await r.isReady();
  return r;
}

type Subject = {
  add: (fn: () => unknown) => () => void;
  run: () => Promise<{ ok: boolean; code?: string }>;
  clear?: () => void;
  dispose: () => void;
};
type Make = () => Subject;

const code = (r: { error?: unknown }) => (r.error as { code?: string } | undefined)?.code;

/** Each bus subject: add a hook, run one action through it, read the outcome. */
const subjects: Array<[string, Make]> = [
  ['sync bus onBefore', () => {
    const bus = createCommandBus();
    bus.register('go', () => 1);
    return {
      add: (fn) => bus.onBefore(fn as never),
      run: async () => { const r = bus.dispatch('go', {}); return { ok: r.ok, code: code(r) }; },
      clear: () => { bus.clear(); bus.register('go', () => 1); },
      dispose: () => bus.dispose(),
    };
  }],
  ['async bus onBefore', () => {
    const bus = createAsyncCommandBus();
    bus.register('go', async () => 1);
    return {
      add: (fn) => bus.onBefore(fn as never),
      run: async () => { const r = await bus.dispatch('go', {}); return { ok: r.ok, code: code(r) }; },
      clear: () => { bus.clear(); bus.register('go', async () => 1); },
      dispose: () => bus.dispose(),
    };
  }],
  ['sync bus onAfter', () => {
    const bus = createCommandBus();
    bus.register('go', () => 1);
    return {
      add: (fn) => bus.onAfter(fn as never),
      run: async () => { const r = bus.dispatch('go', {}); return { ok: r.ok, code: code(r) }; },
      clear: () => { bus.clear(); bus.register('go', () => 1); },
      dispose: () => bus.dispose(),
    };
  }],
  ['async bus onAfter', () => {
    const bus = createAsyncCommandBus();
    bus.register('go', async () => 1);
    return {
      add: (fn) => bus.onAfter(fn as never),
      run: async () => { const r = await bus.dispatch('go', {}); return { ok: r.ok, code: code(r) }; },
      clear: () => { bus.clear(); bus.register('go', async () => 1); },
      dispose: () => bus.dispose(),
    };
  }],
  ['test bus onBefore', () => {
    const bus = createTestBus({ passthroughHandlers: true });
    bus.register('go', () => 1);
    return {
      add: (fn) => bus.onBefore(fn as never),
      run: async () => { const r = bus.dispatch('go', {}); return { ok: r.ok, code: code(r) }; },
      dispose: () => bus.dispose(),
    };
  }],
  ['test bus onAfter', () => {
    const bus = createTestBus({ passthroughHandlers: true });
    bus.register('go', () => 1);
    return {
      add: (fn) => bus.onAfter(fn as never),
      run: async () => { const r = bus.dispatch('go', {}); return { ok: r.ok, code: code(r) }; },
      dispose: () => bus.dispose(),
    };
  }],
];
const busNames = subjects.map(([n]) => n);

/** The router as a subject: each run navigates to the other page. */
async function routerSubject(after = false): Promise<Subject> {
  const r = await router();
  let at = '/';
  return {
    add: (fn: () => unknown) => (after ? r.afterEach(fn as never) : r.beforeEach(() => { fn(); return true; })),
    run: async () => {
      at = at === '/' ? '/list' : '/';
      const e = await r.push(at);
      return { ok: e === null, code: e?.code };
    },
    dispose: () => r.dispose(),
  };
}

const all = async (): Promise<Array<[string, Subject]>> => [
  ...subjects.map(([n, m]) => [n, m()] as [string, Subject]),
  ['router beforeEach', await routerSubject()],
  ['router afterEach', await routerSubject(true)],
];
/** The same expected value for every subject named. */
const each = <T>(names: string[], v: T) => Object.fromEntries(names.map((n) => [n, v]));
const allNames = [...busNames, 'router beforeEach', 'router afterEach'];

/** Run `body` on every subject, collect what each saw, and say whether anything was logged. */
async function onEvery(body: (s: Subject, calls: string[]) => Promise<unknown>) {
  const seen: Record<string, unknown> = {};
  for (const [name, s] of await all()) {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const calls: string[] = [];
    const out = await body(s, calls);
    seen[name] = { out, calls, logged: errors.mock.calls.length };
    errors.mockRestore();
    s.dispose();
  }
  return seen;
}

describe('removal during a run', () => {
  it('control: no removal, both hooks run on every subject', async () => {
    const seen = await onEvery(async (s, calls) => {
      s.add(() => calls.push('A'));
      s.add(() => calls.push('B'));
      return (await s.run()).ok;
    });
    expect(seen).toEqual(each(allNames, { out: true, calls: ['A', 'B'], logged: 0 }));
  });

  it('a hook that removes itself: the next one still runs, the action succeeds, nothing is logged', async () => {
    const seen = await onEvery(async (s, calls) => {
      const off = s.add(() => { calls.push('A'); off(); });
      s.add(() => calls.push('B'));
      const first = (await s.run()).ok;
      await s.run();
      return first;
    });
    expect(seen).toEqual(each(allNames, { out: true, calls: ['A', 'B', 'B'], logged: 0 }));
  });

  it('a hook that removes a later one: the one between runs, the removed one never', async () => {
    const seen = await onEvery(async (s, calls) => {
      let offC = () => {};
      s.add(() => { calls.push('A'); offC(); });
      s.add(() => calls.push('B'));
      offC = s.add(() => calls.push('C'));
      return (await s.run()).ok;
    });
    expect(seen).toEqual(each(allNames, { out: true, calls: ['A', 'B'], logged: 0 }));
  });

  const twoRemovals = async (s: Subject, calls: string[]) => {
    let offC = () => {};
    const offA = s.add(() => { calls.push('A'); offA(); offC(); });
    s.add(() => calls.push('B'));
    offC = s.add(() => calls.push('C'));
    s.add(() => calls.push('D'));
    const first = (await s.run()).ok;
    await s.run();
    return first;
  };
  const removedTwice = async (s: Subject, calls: string[]) => {
    const h = () => calls.push('H');
    const off = s.add(h);
    s.add(h);
    off();
    off();
    return (await s.run()).ok;
  };
  const pick = (seen: Record<string, unknown>, names: string[]) => Object.fromEntries(names.map((n) => [n, seen[n]]));

  it('two removals in one run, itself then a later one: every subject runs neither again', async () => {
    expect(await onEvery(twoRemovals)).toEqual(each(allNames, { out: true, calls: ['A', 'B', 'D', 'B', 'D'], logged: 0 }));
  });

  it('one subscription removed twice removes only itself: every subject keeps the other', async () => {
    expect(await onEvery(removedTwice)).toEqual(each(allNames, { out: true, calls: ['H'], logged: 0 }));
  });
});

describe('router: a removal around a navigation started inside the run', () => {
  it('an after-hook that removes itself and navigates: the hooks after it run once, nothing is logged', async () => {
    const r = await router();
    const calls: string[] = [];
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const off = r.afterEach((to) => { calls.push(`A${to.path}`); off(); void r.push('/'); });
    r.afterEach((to) => { calls.push(`B${to.path}`); });
    r.afterEach((to) => { calls.push(`C${to.path}`); });
    await r.push('/list');
    for (let i = 0; i < 3; i++) await tick();
    expect({ calls, logged: errors.mock.calls.length, at: r.currentRoute.value.location.path }).toEqual({
      calls: ['A/list', 'B/list', 'C/list', 'B/', 'C/'],
      logged: 0,
      at: '/',
    });
    errors.mockRestore();
    r.dispose();
  });

  it('a guard removed while an older navigation awaits: the older one is superseded, the newer one skips the removed guard', async () => {
    const r = await router();
    const calls: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((res) => (release = res));
    let first = true;
    r.beforeEach(async (to) => { calls.push(`A${to.path}`); if (first) { first = false; await held; } });
    const offB = r.beforeEach((to) => { calls.push(`B${to.path}`); });
    r.beforeEach((to) => { calls.push(`C${to.path}`); });
    const older = r.push('/list');
    await tick();
    offB();
    const newer = r.push('/list?x=1');
    release();
    const [a, b] = await Promise.all([older, newer]);
    expect({ older: a?.code, newer: b, calls }).toEqual({ older: 'router:aborted:navigation', newer: null, calls: ['A/list', 'A/list', 'C/list'] });
    r.dispose();
  });
});

describe('clear() from a hook', () => {
  it('every bus: the rest of the run calls no cleared hook, and nothing is logged', async () => {
    const seen: Record<string, unknown> = {};
    for (const [name, make] of subjects.filter(([n]) => !n.startsWith('test bus'))) {
      const s = make();
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      const calls: string[] = [];
      s.add(() => { calls.push('A'); s.clear!(); });
      s.add(() => calls.push('B'));
      await s.run();
      seen[name] = { calls, logged: errors.mock.calls.length };
      errors.mockRestore();
      s.dispose();
    }
    expect(seen).toEqual(each(busNames.filter((n) => !n.startsWith('test bus')), { calls: ['A'], logged: 0 }));
  });
});

describe('removal while an async before-hook awaits', () => {
  it('a later hook removed during the await does not run', async () => {
    const bus = createAsyncCommandBus();
    const calls: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((res) => (release = res));
    bus.onBefore(async () => { calls.push('A'); await held; });
    const offB = bus.onBefore(() => { calls.push('B'); });
    bus.register('go', async () => { calls.push('handler'); return 1; });
    const going = bus.dispatch('go', {});
    await tick();
    offB();
    release();
    expect({ ok: (await going).ok, calls }).toEqual({ ok: true, calls: ['A', 'handler'] });
    bus.dispose();
  });
});

describe('a hook that adds one', () => {
  it('both router loops run the added hook in the same navigation; the bus runs it from the next dispatch', async () => {
    const seen = await onEvery(async (s, calls) => {
      let added = false;
      s.add(() => { calls.push('A'); if (!added) { added = true; s.add(() => calls.push('D')); } });
      await s.run();
      calls.push('|');
      await s.run();
    });
    expect(seen).toEqual({
      ...each(busNames, { out: undefined, calls: ['A', '|', 'A', 'D'], logged: 0 }),
      'router beforeEach': { out: undefined, calls: ['A', 'D', '|', 'A', 'D'], logged: 0 },
      'router afterEach': { out: undefined, calls: ['A', 'D', '|', 'A', 'D'], logged: 0 },
    });
  });
});

describe('a hook that throws', () => {
  it('before-hooks stop the action with a coded failure, later ones do not run; after-hooks are contained', async () => {
    const seen = await onEvery(async (s, calls) => {
      s.add(() => { calls.push('A'); throw new Error('no'); });
      s.add(() => calls.push('B'));
      return s.run();
    });
    const refused = { out: { ok: false, code: 'core:refused:hook' }, calls: ['A'], logged: 0 };
    const contained = { out: { ok: true, code: undefined }, calls: ['A', 'B'], logged: 1 };
    expect(seen).toEqual({
      'sync bus onBefore': refused,
      'async bus onBefore': refused,
      'sync bus onAfter': contained,
      'async bus onAfter': contained,
      'test bus onBefore': refused,
      'test bus onAfter': contained,
      // Reported to the router's onError, whose default logs it.
      'router beforeEach': { out: { ok: false, code: 'router:failed:guard' }, calls: ['A'], logged: 1 },
      'router afterEach': contained,
    });
  });
});

describe('an async hook outlived by a newer request', () => {
  it('router: the older navigation answers aborted:navigation and runs no later guard', async () => {
    const r = await router();
    const calls: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((res) => (release = res));
    let first = true;
    r.beforeEach(async (to) => { calls.push(`A${to.path}`); if (first) { first = false; await held; } });
    r.beforeEach((to) => { calls.push(`B${to.path}`); });
    const older = r.push('/list');
    await tick();
    const newer = r.push('/list?x=1');
    release();
    const [a, b] = await Promise.all([older, newer]);
    expect(isRouterError(a, 'router:aborted:navigation')).toBe(true);
    expect(b).toBeNull();
    expect(calls).toEqual(['A/list', 'A/list', 'B/list']);
    r.dispose();
  });

  it('async bus: a caller abort during an async before-hook does not stop the handler', async () => {
    const bus = createAsyncCommandBus();
    const calls: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((res) => (release = res));
    bus.onBefore(async () => { calls.push('A'); await held; });
    bus.register('go', async () => { calls.push('handler'); return 1; });
    const ac = new AbortController();
    const going = bus.dispatch('go', {}, undefined, { signal: ac.signal });
    await tick();
    ac.abort();
    release();
    const r = await going;
    expect({ ok: r.ok, calls }).toEqual({ ok: true, calls: ['A', 'handler'] });
    bus.dispose();
  });

  it('control: an abort before the dispatch starts skips the handler', async () => {
    const bus = createAsyncCommandBus();
    const calls: string[] = [];
    bus.register('go', async () => { calls.push('handler'); return 1; });
    const r = await bus.dispatch('go', {}, undefined, { signal: AbortSignal.abort() });
    expect({ ok: r.ok, code: code(r), calls }).toEqual({ ok: false, code: 'core:aborted:dispatch', calls: [] });
    bus.dispose();
  });
});

/*
 * Plan 1.28 item 4 (log s35.207, fixed in s35.209). The router keeps its own
 * guard chain, whose comment (src/router/engine.ts, the guard loop) records
 * the bus's remove-during-iteration lesson. This file runs the same cases on
 * router guards, router after-hooks, both buses' before- and after-hooks and
 * the TestBus.
 *
 * Removal: the router moves its cursor by identity. The bus's hook loops
 * walked to the length they started with while `addHook`'s unsubscribe
 * spliced, so a hook that removed itself or a later hook skipped its
 * neighbour, and the last slot read past the end: calling `undefined` threw a
 * TypeError. In a before-hook that throw was caught as a refusal, so the
 * dispatch failed with `core:refused:hook` and the handler never ran. In an
 * after-hook it was logged as "Hook error". The probe pinned it with
 * `it.fails` rows (970d9cd). The hooks now follow the listeners' rule
 * (fanOutListeners): an entry marked `off` and a replaced array, so a
 * dispatch runs the hooks that existed when it started and skips one removed
 * during it. The rows for two removals in one run, `clear()` from a hook and
 * a removal while an async hook awaits pin the cases a copy-only fix misses.
 *
 * Adding during a run: the bus runs a hook added during a dispatch from the
 * next one (its listeners' rule, the DOM's). Both router loops re-read the
 * length, so an added guard or after-hook runs in the same navigation.
 *
 * A newer request during an async hook: the router supersedes. The bus has no
 * newer-request rule at the hook level (`supersede` is a plugin, below the
 * hooks), and a caller abort while a before-hook awaits is not checked before
 * the handler. Cancellation inside a started dispatch is the handler's own
 * (it reads `cmd.signal`), the same as inside the plugin chain.
 */
