// @vitest-environment happy-dom
/**
 * Single-arm gaps across the small modules — each one line, each a normal
 * runtime condition rather than an exotic one.
 *
 *  - transitions: an async transition command that REJECTS must still call
 *    Vue's `done()`, or the element is stuck mid-transition forever (190).
 *  - utilities: createReaction's refusal returns a working no-op unsubscribe
 *    (246), and a non-object mapPayload value rides through unwrapped (273).
 *  - router/url: encodeQueryParam wrapping a scalar for an `array` param (93).
 *  - router/history: resolveBase with no window and no pathname (74).
 *  - router/menu: a table with no menu-flagged rows at all (96).
 *  - ssr: the rehydrate() thenable guard's own `.catch` (249).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTransitionBridge } from '../src/transitions';
import { createReaction } from '../src/utilities';
import { createCommandBus, createAsyncCommandBus } from '../src/index';
import { encodeQueryParam } from '../src/router/url';
import { resolveBase } from '../src/router/history';
import { rehydrate } from '../src/ssr';
import { buildMenu } from '../src/router/menu';
import { createRouteTable } from '../src/router/table';

afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
// transitions — done() on a rejected dispatch (190)
// ---------------------------------------------------------------------------

describe('transition bridge done() callback', () => {
  it('calls done() when a handler fails (the bus resolves that as errResult)', async () => {
    const bus = createAsyncCommandBus({ onMissing: 'ignore' });
    bus.register('modalEnter', async () => { throw new Error('animation handler died'); });
    const t: any = createTransitionBridge({ bus, namespace: 'modal' });

    const done = vi.fn();
    t.onEnter(document.createElement('div'), done);

    // The element must not be left mid-transition just because the handler failed.
    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1));
  });

  it('calls done() when the dispatch promise itself REJECTS (190)', async () => {
    // The chamber bus never rejects — failures come back as errResult — so this
    // arm exists for the other BaseBus implementations the bridge accepts. A
    // bus that breaks that contract must still not strand the element.
    const bus = { dispatch: () => Promise.reject(new Error('bus contract broken')) } as any;
    const t: any = createTransitionBridge({ bus, namespace: 'modal' });

    const done = vi.fn();
    t.onEnter(document.createElement('div'), done);
    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1));
  });

  it('calls done() when the dispatch resolves', async () => {
    const bus = createAsyncCommandBus({ onMissing: 'ignore' });
    bus.register('modalEnter', async () => 'ok');
    const t: any = createTransitionBridge({ bus, namespace: 'modal' });

    const done = vi.fn();
    t.onEnter(document.createElement('div'), done);
    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1));
  });
});

// ---------------------------------------------------------------------------
// utilities — createReaction (226-285)
// ---------------------------------------------------------------------------

describe('createReaction', () => {
  it('returns a callable no-op unsubscribe when it refuses to install (246)', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bus = createCommandBus({ onMissing: 'ignore' });

    // Source pattern matches its own target → refused (would self-trigger).
    const off = createReaction('cart*', 'cartSync').install(bus);

    expect(error).toHaveBeenCalledTimes(1);
    expect(typeof off).toBe('function');
    expect(() => off()).not.toThrow(); // the no-op must still be safe to call
  });

  it('passes a non-object mapPayload value through unwrapped (273)', () => {
    const bus = createCommandBus({ onMissing: 'ignore' });
    const seen: unknown[] = [];
    bus.register('source', () => 1);
    bus.register('target', (cmd: any) => { seen.push(cmd.payload); return 2; });

    const off = createReaction('source', 'target', { mapPayload: () => 'a bare string' }).install(bus);
    bus.dispatch('source', {});

    // Nothing to spread the causation marker into — the scalar rides as-is.
    expect(seen).toEqual(['a bare string']);
    off();
  });

  it('merges the causation marker into an object mapPayload value', () => {
    const bus = createCommandBus({ onMissing: 'ignore' });
    const seen: any[] = [];
    bus.register('source', () => 1);
    bus.register('target', (cmd: any) => { seen.push(cmd.payload); return 2; });

    const off = createReaction('source', 'target', { mapPayload: () => ({ qty: 3 }) }).install(bus);
    bus.dispatch('source', {});

    expect(seen[0].qty).toBe(3);
    expect(seen[0].__reactionHops).toBeDefined();
    off();
  });
});

// ---------------------------------------------------------------------------
// router/url — encodeQueryParam array coercion (93)
// ---------------------------------------------------------------------------

describe('encodeQueryParam', () => {
  it('wraps a scalar for a declared array param (93)', () => {
    expect(encodeQueryParam('red', { type: 'array' })).toEqual(['red']);
    expect(encodeQueryParam(7, { type: 'array' })).toEqual(['7']);
  });

  it('keeps an array as-is and drops one equal to the default', () => {
    expect(encodeQueryParam(['a', 'b'], { type: 'array' })).toEqual(['a', 'b']);
    expect(encodeQueryParam(['a'], { type: 'array', default: ['a'] })).toBeNull();
  });

  it('drops an empty array', () => {
    expect(encodeQueryParam([], { type: 'array' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// router/history — resolveBase + position (71-121)
// ---------------------------------------------------------------------------

describe('resolveBase', () => {
  it('falls back to an empty pathname with no window and no option (74)', () => {
    // Node environment: no window, no options.pathname → '' is the pathname.
    expect(resolveBase({})).toBe('');
    expect(resolveBase({ prefix: '/admin' })).toBe('/admin');
  });

  it('prefers an explicit url over everything else', () => {
    expect(resolveBase({ url: '/shop/', pathname: '/other' })).toBe('/shop');
  });
});

// ---------------------------------------------------------------------------
// router/menu — nothing flagged for the menu (96)
// ---------------------------------------------------------------------------

describe('buildMenu', () => {
  it('returns an empty menu when no row carries meta.menu (96)', () => {
    const table = createRouteTable([
      { name: 'home', path: '/', component: 'Home' },
      { name: 'list', path: '/list', component: 'List' },
    ]);
    // No root bucket exists at all — the `?? []` fallback is what answers.
    expect(buildMenu(table.records, '/')).toEqual([]);
  });

  it('builds and active-stamps rows that are flagged', () => {
    const table = createRouteTable([
      { name: 'home', path: '/', component: 'Home', meta: { menu: 1, title: 'nav.home' } },
      { name: 'list', path: '/list', component: 'List', meta: { menu: 2, title: 'nav.list' } },
    ]);
    const menu = buildMenu(table.records, '/list');
    expect(menu.map(i => i.name)).toEqual(['home', 'list']);
    expect(menu.find(i => i.name === 'list')!.exactActive).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ssr — the thenable guard's own catch (249)
// ---------------------------------------------------------------------------

describe('rehydrate on an async bus', () => {
  it('absorbs the pending dispatch rejection it reports (249)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = {
      hasHandler: () => true,
      // A pending promise that later rejects: rehydrate() must attach its own
      // catch, or this surfaces as an unhandled rejection after it returns.
      dispatch: () => Promise.reject(new Error('late failure')),
    } as any;

    const results = rehydrate(bus, [{ action: 'cartAdd', target: {} }]);
    expect(results[0]!.ok).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);

    // Give the rejection a turn to surface — the absorbed catch keeps it quiet.
    await new Promise(r => setTimeout(r, 0));
  });
});
