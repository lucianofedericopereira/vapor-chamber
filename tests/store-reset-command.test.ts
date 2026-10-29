// `$reset()` is a command: plugins, history and listeners see it, and it reaches storage.
import { describe, expect, it } from 'vitest';
import { createAsyncCommandBus, createCommandBus, inspectBus } from '../src/command-bus';
import { defineChamberStore } from '../src/store';
import { saveTo } from '../src/store-persist';
import { history } from '../src/plugins-core';

type Counter = { n: number };

const useCounter = defineChamberStore('counter', {
  state: (): Counter => ({ n: 0 }),
  reducers: { set: (_s: Counter, n: number) => ({ n }) },
});

function memoryStorage(initial: string | null = null) {
  let stored = initial;
  return {
    getItem: () => stored,
    setItem: (_k: string, v: string) => { stored = v; },
    read: () => stored,
  };
}

describe('store $reset as a command', () => {
  it("the store's persist saves the reset, and a reload reads the reset state", async () => {
    const storage = memoryStorage();
    const usePersisted = defineChamberStore('counter', {
      state: (): Counter => ({ n: 0 }),
      reducers: { set: (_s: Counter, n: number) => ({ n }) },
      persist: saveTo({ key: 'vc:counter', storage }),
    });
    const store = usePersisted(createCommandBus());
    store.set(5);
    await Promise.resolve();
    expect(storage.read()).toBe(JSON.stringify({ n: 5 }));

    store.$reset();
    await Promise.resolve();

    expect(storage.read()).toBe(JSON.stringify({ n: 0 }));
    store.$dispose();
    // The reload: the next page's store reads what was saved.
    storage.setItem('vc:counter', JSON.stringify({ n: 0 }));
    expect(usePersisted(createCommandBus()).state.value).toEqual({ n: 0 });
  });

  it('a listener hears it, and history records it', () => {
    const bus = createCommandBus();
    const heard: string[] = [];
    bus.on('*', (cmd) => heard.push(cmd.action));
    const h = history({ bus });
    const store = useCounter(bus);
    store.set(5);
    store.$reset();
    expect(heard).toEqual(['counterSet', 'counter$reset']);
    expect(h.getState().past.map((c) => c.action)).toEqual(['counterSet', 'counter$reset']);
    store.$dispose();
  });

  it('returns the dispatch result: ok, with the fresh state as its value', () => {
    const bus = createCommandBus();
    const store = useCounter(bus);
    store.set(5);
    const result = store.$reset() as { ok: boolean; value: unknown };
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ n: 0 });
    expect(result.value).toBe(store.state.value);
    store.$dispose();
  });

  it('a rule can refuse it, and then the state is unchanged', () => {
    const bus = createCommandBus();
    const store = useCounter(bus);
    store.set(5);
    bus.use({ authorize: (action) => (action === 'counter$reset' ? () => ({ ok: false, value: undefined, error: new Error('refused') }) : undefined) });
    const result = store.$reset() as { ok: boolean };
    expect(result.ok).toBe(false);
    expect(store.state.value).toEqual({ n: 5 });
    store.$dispose();
  });

  it('on an async bus the state is reset once the returned promise settles', async () => {
    const bus = createAsyncCommandBus();
    const store = useCounter(bus);
    await store.set(5);
    expect(store.state.value).toEqual({ n: 5 });
    const result = await store.$reset();
    expect(result.ok).toBe(true);
    expect(store.state.value).toEqual({ n: 0 });
    store.$dispose();
  });

  it('$dispose unregisters the reset handler with the actions', () => {
    const bus = createCommandBus();
    const store = useCounter(bus);
    expect(inspectBus(bus).actions).toContain('counter$reset');
    store.$dispose();
    expect(inspectBus(bus).actions).not.toContain('counter$reset');
  });
});

describe('$reset goes back to state(), so state() is the reset target', () => {
  it('a state() that reads storage resets to the saved record, not the default', async () => {
    const storage = memoryStorage();
    const useSaved = defineChamberStore('saved', {
      state: (): Counter => JSON.parse(storage.read() ?? 'null') ?? { n: 0 },
      reducers: { set: (_s: Counter, n: number) => ({ n }) },
      persist: saveTo({ key: 'vc:f1', storage }),
    });
    const store = useSaved(createCommandBus());
    store.set(5);
    await Promise.resolve();
    store.$reset();
    expect(store.state.value).toEqual({ n: 5 });
    store.$dispose();
  });

  it("a pure state(), with the saved record read by the store's persist, resets to the default", async () => {
    const storage = memoryStorage(JSON.stringify({ n: 5 }));
    const useLoaded = defineChamberStore('loaded', {
      state: (): Counter => ({ n: 0 }),
      reducers: { set: (_s: Counter, n: number) => ({ n }) },
      persist: saveTo({ key: 'vc:f1b', storage }),
    });
    const store = useLoaded(createCommandBus());
    expect(store.state.value).toEqual({ n: 5 });
    store.$reset();
    expect(store.state.value).toEqual({ n: 0 });
    await Promise.resolve();
    expect(storage.read()).toBe(JSON.stringify({ n: 0 }));
    store.$dispose();
  });
});

describe('naming: a name with `$` is the library\'s', () => {
  // The pattern manual chapter 2, "Enforce a naming convention" shows, with 'throw'.
  const naming = { pattern: /^[a-z][a-zA-Z0-9]+$/, onViolation: 'throw' as const };

  it('a store on a bus with the manual chapter 2, "Enforce a naming convention" naming rule creates and resets', () => {
    const bus = createCommandBus({ naming });
    const store = useCounter(bus);
    store.set(5);
    expect((store.$reset() as { ok: boolean }).ok).toBe(true);
    expect(store.state.value).toEqual({ n: 0 });
    store.$dispose();
  });

  it('control: a name without `$` that fails the rule still throws', () => {
    const bus = createCommandBus({ naming });
    expect(() => bus.register('bad_name', () => 1)).toThrow(/does not match naming pattern/);
    expect(() => bus.dispatch('bad_name', null)).toThrow(/does not match naming pattern/);
  });
});

// Before this, `$reset()` wrote the signal directly: no plugin, listener or
// history entry saw it, so with `persist` the reset never reached storage and
// the next reload brought back the state from before it (the 1.26 list, item
// 18; its probe read storage `{n:5}` after the reset). Now it dispatches
// `<id>$reset`, registered beside the store's actions.
//
// The name carries `$` so that no user action can collide with it: a store
// with an action `reset` already owns `<id>Reset`. A naming rule such as the
// manual chapter 2, "Enforce a naming convention" camelCase pattern would reject `$`, so names containing `$` are
// reserved for the library and skip the naming check (log s35.70). The check
// runs only after the pattern has failed, so a name that passes pays nothing.
