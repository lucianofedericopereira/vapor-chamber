/**
 * Store definition refusals and disposal: an action key that is a store member, a url store without a router, a stale $dispose(), and the coded failure shape of every store refusal.
 * Why: an action key that names a store member would replace it (`store.state` becoming a dispatching function); a url store that throws after registering would leave handlers nothing can unregister; a stale $dispose() would remove the registry entry of the newer store with the same id and leave its state dead.
 * Shows: member keys are refused by name and the catalogue fix lists them; the throw comes before any registration and a later call with a router starts clean; a second $dispose() or a late-ending scope leaves the newer store registered; each refusal has its code, message and context, and production keeps the fact only; a "$" in an id or action key is store:invalid:name.
 * See: log s35.88, log s35.117, docs/contract.md.
 */
import { describe, expect, vi } from 'vitest';
import type { BusError } from '../src/command-bus';
import { effectScope } from 'vue';
import { createCommandBus, inspectBus } from '../src/command-bus';
import { ERROR_CODE_REGISTRY } from '../src/error-registry';
import { defineChamberStore } from '../src/store';
import { it } from '../src/vitest';
import { stubEnv } from '../src/vitest-pure';

const counter = { state: () => ({ n: 0 }), reducers: { inc: (s: { n: number }) => ({ n: s.n + 1 }) } };
const fakeRouter = { currentRoute: { value: { location: { query: {} } } }, setQuery: () => {} };

describe('an action key that is a store member', () => {
  const members = ['$id', 'state', 'url', '$reset', '$dispose', '$onField'];
  for (const key of members) {
    it(`"${key}" is refused when the store is defined, by name`, () => {
      expect(() => defineChamberStore('s', { state: () => ({}), reducers: { [key]: (s: object) => s } })).toThrow(
        `Store "s": the action "${key}" would replace the store's own "${key}".`,
      );
    });
  }

  it('the catalogue fix for store:already:member names every member refused above', () => {
    const fix = ERROR_CODE_REGISTRY.find((e) => e.code === 'store:already:member')!.fix;
    expect(members.filter((key) => !fix.includes(key))).toEqual([]);
  });

  it('control: any other key is an action', ({ bus }) => {
    const store = defineChamberStore('s', { state: () => ({ v: 0 }), reducers: { status: () => ({ v: 1 }) } })(bus);
    store.status();
    expect(store.state.value.v).toBe(1);
    store.$dispose();
  });
});

describe('a url store called without a router', () => {
  it('throws before it registers anything, so the call with a router starts clean', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = createCommandBus();
    const useFilters = defineChamberStore('f', { ...counter, url: { page: 'page' } });
    expect(() => useFilters(bus)).toThrow(/was given no router/);
    expect(inspectBus(bus).actions).toEqual([]);

    const filters = useFilters(bus, fakeRouter);
    filters.inc();
    expect(filters.state.value.n).toBe(1);
    expect(warn).not.toHaveBeenCalled(); // no "Handler ... is being overwritten"
    filters.$dispose();
    bus.dispose();
  });
});

describe('a stale $dispose() of a store already replaced', () => {
  it('a second $dispose() by its owner leaves the newer store registered', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = createCommandBus();
    const useCounter = defineChamberStore('c', counter);
    const first = useCounter(bus);
    first.$dispose();
    const second = useCounter(bus);
    first.$dispose(); // the old owner, again

    expect(useCounter(bus)).toBe(second);
    second.inc();
    expect(second.state.value.n).toBe(1);
    expect(warn).not.toHaveBeenCalled();
    second.$dispose();
    bus.dispose();
  });

  it('a scope that held the old store, ending late, leaves the newer store registered', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = createCommandBus();
    const useCounter = defineChamberStore('h', counter);
    const page = effectScope();
    const first = page.run(() => useCounter(bus))!;
    first.$dispose(); // disposed by hand while the page still holds it
    const second = useCounter(bus);
    page.stop(); // the page's holder leaves: the old store's last holder

    expect(useCounter(bus)).toBe(second);
    second.inc();
    expect(second.state.value.n).toBe(1);
    expect(warn).not.toHaveBeenCalled();
    second.$dispose();
    bus.dispose();
  });
});

describe('every store refusal is coded (shape rule 2)', () => {
  const codeOf = (fn: () => unknown): string | undefined => {
    try { fn(); } catch (e) { return (e as { code?: string }).code; }
    return 'did not throw';
  };

  it('store:already:member, store:missing:bus, store:missing:router, each catalogued', () => {
    expect(codeOf(() => defineChamberStore('s', { state: () => ({}), reducers: { state: (s: object) => s } }))).toBe('store:already:member');
    expect(codeOf(() => (defineChamberStore('s', counter) as unknown as () => unknown)())).toBe('store:missing:bus');
    const bus = createCommandBus();
    expect(codeOf(() => defineChamberStore('f', { ...counter, url: { page: 'page' } })(bus))).toBe('store:missing:router');
    for (const code of ['store:already:member', 'store:missing:bus', 'store:missing:router']) {
      expect(ERROR_CODE_REGISTRY.some((e) => e.code === code), code).toBe(true);
    }
    bus.dispose();
  });
});

describe('every store refusal has the core failure shape (docs/contract.md rule 5 and section 5)', () => {
  const thrown = (fn: () => unknown): BusError => {
    try { fn(); } catch (e) { return e as BusError; }
    throw new Error('did not throw');
  };
  const refusals = (store: typeof defineChamberStore, bus: ReturnType<typeof createCommandBus>) => [
    thrown(() => store('s', { state: () => ({}), reducers: { state: (s: object) => s } })),
    thrown(() => (store('s', counter) as unknown as () => unknown)()),
    thrown(() => store('f', { ...counter, url: { page: 'page', sort: 'sort' } })(bus)),
  ];

  it('the fact, then the advice in development; every value in the message is in context', () => {
    const bus = createCommandBus();
    const [member, noBus, noRouter] = refusals(defineChamberStore, bus);
    expect(member.message).toBe('Store "s": the action "state" would replace the store\'s own "state". Rename the action.');
    expect(member.context).toEqual({ id: 's', key: 'state' });
    expect(noBus.message).toBe('Store "s" was given no bus. Call useStore(bus): stores are keyed per bus, so each request\'s bus gets its own, and never fall back to the shared bus.');
    expect(noBus.context).toEqual({ id: 's' });
    expect(noRouter.message).toBe('Store "f" declares url fields (page, sort) and was given no router. Call useStore(bus, router): the router is an argument, so a store without url fields never imports it.');
    expect(noRouter.context).toEqual({ id: 'f', fields: ['page', 'sort'] });
    bus.dispose();
  });

  it('production carries the fact only', async () => {
    using _NODE_ENV = stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    const fresh = await import('../src/store');
    const { createCommandBus: freshBus } = await import('../src/command-bus');
    const bus = freshBus();
    expect(refusals(fresh.defineChamberStore, bus).map((e) => e.message)).toEqual([
      'Store "s": the action "state" would replace the store\'s own "state".',
      'Store "s" was given no bus.',
      'Store "f" declares url fields (page, sort) and was given no router.',
    ]);
    bus.dispose();
    vi.resetModules();
  });
});

describe("a $ in a store's id or action key (log s35.117)", () => {
  it('is store:invalid:name, the advice dropped in production', async () => {
    using _NODE_ENV = stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    const { defineChamberStore: prodDefine } = await import('../src/store');
    const state = () => ({ n: 0 });
    expect(() => prodDefine('ca$rt', { state, reducers: {} })).toThrow('Store "ca$rt": a name with "$" is the library\'s.');
    expect(() => prodDefine('cart', { state, reducers: { add$x: (x: { n: number }) => x } })).toThrow('Store "cart": the action "add$x" has a "$", which names the library\'s commands.');
    vi.resetModules();
  });
});
