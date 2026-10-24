// Async after-hooks: a sync hook costs no microtask turn, an async one is still awaited. The long note is at the end.
import { describe, expect, it, vi } from 'vitest';
import { createAsyncCommandBus } from '../src/command-bus';
import { configureReport } from '../src/report';

/** Microtask turns between the call and its promise settling. */
async function turns(p: Promise<unknown>): Promise<number> {
  let done = false;
  p.then(() => { done = true; });
  let n = 0;
  while (!done && n < 1_000) {
    await null;
    n++;
  }
  return n;
}

function bus(hooks: number) {
  const b = createAsyncCommandBus();
  b.register('go', (cmd) => cmd.target);
  for (let i = 0; i < hooks; i++) b.onAfter(() => {});
  return b;
}

describe('async after-hooks: no frame for sync hooks', () => {
  it('a dispatch with sync hooks settles in the turns of a bus with none', async () => {
    const none = await turns(bus(0).dispatch('go', 1));
    expect(await turns(bus(1).dispatch('go', 1))).toBe(none);
    expect(await turns(bus(3).dispatch('go', 1))).toBe(none);
  });

  it('a query with sync hooks settles in the turns of a bus with none', async () => {
    const none = await turns(bus(0).query('go', 1));
    expect(await turns(bus(2).query('go', 1))).toBe(none);
  });

  it('control: a hook that returns a promise still costs its turns', async () => {
    const none = await turns(bus(0).dispatch('go', 1));
    const b = bus(0);
    b.onAfter(() => Promise.resolve());
    expect(await turns(b.dispatch('go', 1))).toBeGreaterThan(none);
  });
});

describe('async after-hooks: an async hook is awaited', () => {
  it('the hooks after it and the listeners run once its promise settles', async () => {
    const b = createAsyncCommandBus();
    b.register('go', async () => 1);
    const seen: string[] = [];
    let release!: () => void;
    b.onAfter(() => { seen.push('h1'); });
    b.onAfter(() => new Promise<void>((r) => { release = () => { seen.push('h2 settled'); r(); }; }));
    b.onAfter(() => { seen.push('h3'); });
    b.on('go', () => { seen.push('listener'); });
    const p = b.dispatch('go', 1);
    for (let i = 0; i < 100 && seen.length === 0; i++) await null;
    for (let i = 0; i < 20; i++) await null;
    expect(seen).toEqual(['h1']);
    release();
    expect((await p).ok).toBe(true);
    expect(seen).toEqual(['h1', 'h2 settled', 'h3', 'listener']);
  });

  it('a rejected hook is reported and the rest still run', async () => {
    const reports: string[] = [];
    configureReport({ sinks: [(r) => { reports.push(r.code); }] });
    try {
      const b = createAsyncCommandBus();
      b.register('go', async () => 1);
      const after = vi.fn();
      b.onAfter(() => Promise.reject(new Error('no')));
      b.onAfter(after);
      const listener = vi.fn();
      b.on('go', listener);
      expect((await b.dispatch('go', 1)).ok).toBe(true);
      expect(reports).toEqual(['core:failed:hook']);
      expect(after).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      configureReport(null);
    }
  });

  it('a hook removed while one awaits is skipped, one added then waits for the next dispatch', async () => {
    const b = createAsyncCommandBus();
    b.register('go', async () => 1);
    const seen: string[] = [];
    let off!: () => void;
    b.onAfter(async () => {
      off();
      b.onAfter(() => { seen.push('added'); });
    });
    off = b.onAfter(() => { seen.push('removed'); });
    await b.dispatch('go', 1);
    expect(seen).toEqual([]);
    await b.dispatch('go', 2);
    expect(seen).toEqual(['added']);
  });
});

describe('async after-hooks: an async hook is awaited on every path', () => {
  /** A bus whose one hook returns a promise the test releases. */
  function gated() {
    const b = createAsyncCommandBus({ retry: false });
    let release!: () => void;
    let held = 0;
    b.onAfter(() => new Promise<void>((r) => { held++; release = r; }));
    return { b, release: () => release(), held: () => held };
  }

  /** The promise does not settle while the hook holds, and settles once released. */
  async function waitsForTheHook(p: Promise<unknown>, g: ReturnType<typeof gated>) {
    let settled = false;
    p.then(() => { settled = true; });
    for (let i = 0; i < 100 && g.held() === 0; i++) await null;
    for (let i = 0; i < 20; i++) await null;
    expect([g.held(), settled]).toEqual([1, false]);
    g.release();
    await p;
    expect(settled).toBe(true);
  }

  it('a dispatch whose signal was aborted before it started', async () => {
    const g = gated();
    g.b.register('go', async () => 1);
    const ac = new AbortController();
    ac.abort();
    await waitsForTheHook(g.b.dispatch('go', 1, undefined, { signal: ac.signal }), g);
  });

  it('a dispatch a rule refuses', async () => {
    const g = gated();
    g.b.register('go', async () => 1);
    g.b.use({ authorize: () => () => ({ ok: false, value: undefined, error: new Error('refused') }) });
    await waitsForTheHook(g.b.dispatch('go', 1), g);
  });

  it('an exclusive action', async () => {
    const g = gated();
    g.b.register('go', async () => 1, { exclusive: {} });
    await waitsForTheHook(g.b.dispatch('go', 1), g);
  });

  it('an exclusive action whose key throws', async () => {
    const g = gated();
    g.b.register('go', async () => 1, { exclusive: { key: () => { throw new Error('no key'); } } });
    await waitsForTheHook(g.b.dispatch('go', 1), g);
  });

  it('an optimistic action, its done', async () => {
    const g = gated();
    g.b.register('go', async () => 1, { optimistic: true, undo: async () => {} });
    const r = await g.b.dispatch('go', 1);
    await waitsForTheHook((r.value as { done: Promise<unknown> }).done, g);
  });
});

// Why: on the async bus every dispatch and query with any onAfter hook (history(),
// useCommandHistory, useCommandError, the devtools) ran its hooks inside an async
// function, so it paid that function's promise and its caller's `await`, two
// microtask turns, even when every hook returned nothing. The phase 2 study counted
// it as 9 promise units against 7. The turn counts above pin the claim: a sync hook
// adds none. The control keeps the counter honest, a hook's own promise still
// costs turns. The other cases pin what must not change: an async hook delays the
// hooks after it and the listeners, its rejection is `core:failed:hook` and the rest
// run, and a dispatch walks the hooks it started with (tests/hook-removal-parity).
