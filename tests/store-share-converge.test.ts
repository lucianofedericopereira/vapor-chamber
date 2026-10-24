/** Tabs that write a shared store at once end on one state, one their writes can make. Rationale at the end. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCommandBus } from '../src/command-bus';
import { defineChamberStore } from '../src/store/core';
import { shareTabs } from '../src/store-share';
import { history } from '../src/plugins-core';
import { listen, quiet } from './tabs-quiet';

type S = { v: string; items: string[]; qty: Record<string, number> };
type Op = (s: S) => S;
const reducers = {
  set: (s: S, v: string) => ({ ...s, v }),
  push: (s: S, x: string) => ({ ...s, items: [...s.items, x] }),
  add: (s: S, k: string) => ({ ...s, qty: { ...s.qty, [k]: (s.qty[k] ?? 0) + 1 } }),
};
const START = (): S => ({ v: '', items: [], qty: { tea: 1 } });
const set = (v: string): Op => (s) => reducers.set(s, v);
const push = (x: string): Op => (s) => reducers.push(s, x);
const add = (k: string): Op => (s) => reducers.add(s, k);
const reset: Op = () => START();

const closers: Array<() => void> = [];
let pageHandlers: Array<{ type: string; fn: (e: { persisted?: boolean }) => void }> = [];
beforeEach(() => {
  pageHandlers = [];
  vi.stubGlobal('window', {});
  vi.stubGlobal('addEventListener', (type: string, fn: (e: { persisted?: boolean }) => void) => { pageHandlers.push({ type, fn }); });
  vi.stubGlobal('removeEventListener', () => {});
});
afterEach(() => { while (closers.length) closers.pop()!(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

let n = 0;
/** A channel of its own, and every message on it as a listener that is not a tab reads it. */
function channel(): { name: string; heard: Array<Record<string, unknown>> } {
  const name = `conv-${n++}`;
  const { heard, close } = listen(name);
  closers.push(close);
  return { name, heard };
}

/** One tab: its own bus, store and history, on the channel `name`. */
function tab(name: string, opts: { undo?: boolean; coalesce?: boolean } = {}) {
  const bus = createCommandBus();
  const h = history({ bus });
  const before = pageHandlers.length;
  const store = defineChamberStore('conv', { state: START, reducers, undo: opts.undo, coalesce: opts.coalesce, share: shareTabs(name) })(bus);
  const page = pageHandlers.slice(before);
  closers.push(() => { store.$dispose(); h.dispose(); });
  const fire = (type: string, persisted: boolean): void => { for (const p of page) if (p.type === type) p.fn({ persisted }); };
  return { bus, store, h, hide: () => fire('pagehide', false), show: (persisted: boolean) => fire('pageshow', persisted) };
}
type Tab = ReturnType<typeof tab>;

/** Every state the writes can make: each tab's writes kept as that tab made them, the tabs' writes interleaved every way. */
function outcomes(start: S, tabs: Op[][]): S[] {
  const found: S[] = [];
  const walk = (s: S, at: number[]): void => {
    let any = false;
    for (let t = 0; t < tabs.length; t++) {
      if (at[t]! < tabs[t]!.length) {
        any = true;
        const next = at.slice();
        next[t]!++;
        walk(tabs[t]![at[t]!]!(s), next);
      }
    }
    if (!any) found.push(s);
  };
  walk(start, tabs.map(() => 0));
  return found;
}

/** Every tab holds one state, and it is one the writes can make: nothing lost, nothing run twice. */
function expectOne(tabs: Tab[], start: S, writes: Op[][]): S {
  const [first, ...rest] = tabs.map((t) => t.store.state.value);
  for (const s of rest) expect(s).toEqual(first);
  expect(outcomes(start, writes)).toContainEqual(first);
  return first!;
}

describe('two settled tabs that write at once end on one state', () => {
  for (const undo of [false, true]) {
    it(`one field set to two values (undo ${undo})`, async () => {
      const { name, heard } = channel();
      const a = tab(name, { undo });
      const b = tab(name, { undo });
      await quiet(heard);
      a.store.set('a');
      b.store.set('b');
      await quiet(heard);
      expectOne([a, b], START(), [[set('a')], [set('b')]]);
    });

    it(`two appends (undo ${undo})`, async () => {
      const { name, heard } = channel();
      const a = tab(name, { undo });
      const b = tab(name, { undo });
      await quiet(heard);
      a.store.push('x');
      b.store.push('y');
      await quiet(heard);
      expectOne([a, b], START(), [[push('x')], [push('y')]]);
    });

    it(`a $reset against an add (undo ${undo})`, async () => {
      const { name, heard } = channel();
      const a = tab(name, { undo });
      const b = tab(name, { undo });
      await quiet(heard);
      a.store.add('sugar');
      await quiet(heard);
      a.store.$reset();
      b.store.add('coffee');
      await quiet(heard);
      expectOne([a, b], add('sugar')(START()), [[reset], [add('coffee')]]);
    });

    it(`a burst in each tab (undo ${undo})`, async () => {
      const { name, heard } = channel();
      const a = tab(name, { undo });
      const b = tab(name, { undo });
      await quiet(heard);
      const wa: Op[] = [];
      const wb: Op[] = [];
      for (let i = 0; i < 3; i++) {
        a.store.push(`a${i}`); wa.push(push(`a${i}`));
        b.store.set(`b${i}`); wb.push(set(`b${i}`));
        b.store.push(`b${i}`); wb.push(push(`b${i}`));
      }
      await quiet(heard);
      expectOne([a, b], START(), [wa, wb]);
    });
  }

  it('a coalesce store: a burst under a pending write', async () => {
    const { name, heard } = channel();
    const a = tab(name, { coalesce: true });
    const b = tab(name, { coalesce: true });
    await quiet(heard);
    a.store.set('a');
    a.store.push('x');
    b.store.set('b');
    b.store.push('y');
    await quiet(heard);
    expectOne([a, b], START(), [[set('a'), push('x')], [set('b'), push('y')]]);
  });

  it('three tabs', async () => {
    const { name, heard } = channel();
    const a = tab(name);
    const b = tab(name);
    const c = tab(name);
    await quiet(heard);
    a.store.set('a');
    b.store.set('b');
    c.store.set('c');
    c.store.push('z');
    a.store.push('x');
    await quiet(heard);
    expectOne([a, b, c], START(), [[set('a'), push('x')], [set('b')], [set('c'), push('z')]]);
  });
});

describe('undo after the tabs met', () => {
  it('Undo in either tab takes back the same step in every tab', async () => {
    const { name, heard } = channel();
    const a = tab(name, { undo: true });
    const b = tab(name, { undo: true });
    await quiet(heard);
    a.store.push('x');
    b.store.push('y');
    await quiet(heard);
    // The step on top of the one shared state: x or y, whichever the lead ran over the other.
    b.h.undo();
    await quiet(heard);
    const one = [a, b].map((t) => t.store.state.value);
    expect(one[1]).toEqual(one[0]);
    expect([push('x')(START()), push('y')(START())]).toContainEqual(one[0]);
    a.h.undo();
    await quiet(heard);
    expect(expectOne([a, b], START(), [[]]).items).toEqual([]);
  });
});

describe('undo stops at a state another tab sent', () => {
  it('a tab back from the cache holds the command under its answer: an undo elsewhere still reaches it', async () => {
    const { name, heard } = channel();
    const a = tab(name, { undo: true });
    await quiet(heard);
    const b = tab(name, { undo: true });
    await quiet(heard);
    a.store.add('coffee');
    await quiet(heard);
    b.hide();
    b.show(true);
    await quiet(heard);
    a.h.undo();
    await quiet(heard);
    expectOne([a, b], START(), [[]]);
  });

  it('the lead holds the command under its answer: an undo in another tab leaves every tab on the lead\'s state', async () => {
    const { name, heard } = channel();
    const a = tab(name, { undo: true });
    await quiet(heard);
    const b = tab(name, { undo: true });
    const c = tab(name, { undo: true });
    await quiet(heard);
    c.store.add('coffee');
    await quiet(heard);
    // b asks again (its answer goes over coffee), then a leaves and b leads.
    b.hide();
    b.show(true);
    await quiet(heard);
    a.hide();
    await quiet(heard);
    c.h.undo();
    await quiet(heard);
    const [sb, sc] = [b.store.state.value, c.store.state.value];
    expect(sc).toEqual(sb);
    expect([START(), add('coffee')(START())]).toContainEqual(sb);
  });
});

describe('the tab holding the lock leaves', () => {
  it('on pagehide: a tab takes over, and two tabs that then set one field at once end on one state', async () => {
    const { name, heard } = channel();
    const a = tab(name);
    await quiet(heard);
    const b = tab(name);
    const c = tab(name);
    await quiet(heard);
    a.hide();
    await quiet(heard);
    b.store.set('b');
    c.store.set('c');
    await quiet(heard);
    expectOne([b, c], START(), [[set('b')], [set('c')]]);
  });

  it('on pagehide with a write it had not run: the write lands once, and the tab back from the cache follows', async () => {
    const { name, heard } = channel();
    const a = tab(name);
    await quiet(heard);
    const b = tab(name);
    const c = tab(name);
    await quiet(heard);
    b.store.push('b');
    a.hide();
    await quiet(heard);
    c.store.set('c');
    b.store.set('b');
    await quiet(heard);
    a.show(true);
    await quiet(heard);
    expectOne([a, b, c], START(), [[push('b'), set('b')], [set('c')]]);
  });

  it('disposed with no pagehide: a tab takes over, and two tabs that then set one field at once end on one state', async () => {
    const { name, heard } = channel();
    const a = tab(name);
    await quiet(heard);
    const b = tab(name);
    const c = tab(name);
    await quiet(heard);
    a.store.push('a');
    await quiet(heard);
    a.store.$dispose();
    b.store.set('b');
    c.store.set('c');
    await quiet(heard);
    expectOne([b, c], push('a')(START()), [[set('b')], [set('c')]]);
  });
});

describe('a tab that opens while others write', () => {
  it('ends on the same state', async () => {
    const { name, heard } = channel();
    const a = tab(name);
    const b = tab(name);
    await quiet(heard);
    a.store.set('a');
    b.store.set('b');
    const c = tab(name);
    c.store.push('c');
    await quiet(heard);
    expectOne([a, b, c], START(), [[set('a')], [set('b')], [push('c')]]);
  });
});

describe('controls (green before the change)', () => {
  it('two tabs pressing Undo on one command end on one state', async () => {
    const { name, heard } = channel();
    const a = tab(name, { undo: true });
    const b = tab(name, { undo: true });
    await quiet(heard);
    a.store.add('coffee');
    await quiet(heard);
    a.h.undo();
    b.h.undo();
    await quiet(heard);
    expectOne([a, b], START(), [[]]);
  });

  it('two tabs still asking that write at once end on one state', async () => {
    const { name, heard } = channel();
    const a = tab(name);
    const b = tab(name);
    a.store.set('a');
    b.store.set('b');
    await quiet(heard);
    expectOne([a, b], START(), [[set('a')], [set('b')]]);
  });

  it('a write shows at once in its own tab', async () => {
    const { name, heard } = channel();
    const a = tab(name);
    const b = tab(name);
    await quiet(heard);
    b.store.set('b');
    expect(b.store.state.value.v).toBe('b');
    a.store.set('a');
    expect(a.store.state.value.v).toBe('a');
  });

  it('a tab alone sends no write', async () => {
    const { name, heard } = channel();
    const a = tab(name);
    await quiet(heard);
    a.store.set('a');
    a.store.push('x');
    await quiet(heard);
    expect(heard.filter((m) => m.kind === 'cmd')).toEqual([]);
    expect(a.store.state.value).toEqual({ v: 'a', items: ['x'], qty: { tea: 1 } });
  });

  it('the outcome check refuses a lost write and a write run twice', () => {
    const writes = [[push('x')], [push('y')]];
    expect(outcomes(START(), writes)).not.toContainEqual(push('x')(START()));
    expect(outcomes(START(), writes)).not.toContainEqual(push('y')(push('x')(push('x')(START()))));
    expect(outcomes(START(), writes)).toHaveLength(2);
  });
});

describe('without Web Locks', () => {
  it('a page with no navigator at all shares nothing either', async () => {
    vi.stubGlobal('navigator', undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { name, heard } = channel();
    const a = tab(name);
    a.store.set('a');
    await quiet(heard);
    expect(heard).toEqual([]);
    expect(warn.mock.calls.filter((c) => c.some((x) => String(x).includes('store:missing:locks')))).toHaveLength(1);
  });

  it('in production the same, with no warning', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    vi.stubGlobal('navigator', {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const share = await import('../src/store-share');
      const core = await import('../src/store/core');
      const bus = await import('../src/command-bus');
      const s = core.defineChamberStore('prodlocks', { state: START, reducers, share: share.shareTabs(`conv-${n++}`) })(bus.createCommandBus());
      s.set('a');
      expect(s.state.value.v).toBe('a');
      expect(warn).not.toHaveBeenCalled();
      s.$dispose();
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it('a store shares nothing, writes as usual, and development warns once per store', async () => {
    vi.stubGlobal('navigator', {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { name, heard } = channel();
    const a = tab(name);
    const b = tab(name);
    a.store.set('a');
    await quiet(heard);
    expect(a.store.state.value.v).toBe('a');
    expect(b.store.state.value.v).toBe('');
    expect(heard).toEqual([]);
    expect(warn.mock.calls.filter((c) => c.some((x) => String(x).includes('store:missing:locks')))).toHaveLength(2);
  });
});

/*
 * Each tab ran another tab's command as it arrived (log 36.F30). Two tabs that
 * set one field at once each ended on the other's value, two appends ended in
 * two arrangements, and a `$reset` against an add left one tab with the add.
 * A reducer is the app's own function, so tabs end equal only when they run
 * the same commands over the same states: one place has to be the state.
 *
 * That place is the tab the browser grants the store's Web Lock (Web Locks
 * 2.3: an exclusive lock is held by one agent at a time). It runs every tab's
 * command and posts it on, and the other tabs run only what it posts. A write
 * still runs at once in its own tab. Nothing compares a time, a count or a tab
 * id (log 36.F39).
 *
 * Equal tabs are not enough: two tabs that both lost a write are equal.
 * `outcomes` lists every state the writes can make, each tab's own writes kept
 * as that tab made them, and `expectOne` asks the tabs' one state to be among
 * them. Its own control shows it refuses a lost write and a doubled one.
 * `quiet` (tests/tabs-quiet.ts) waits for the channel to carry nothing.
 *
 * An answer is not one of the other tabs' steps. A tab that holds a command
 * under its answer (back from the back-forward cache) and undid it there
 * would leave the others apart, so an undo search stops at a state another
 * tab sent, and the state the undo reached is taken.
 */
