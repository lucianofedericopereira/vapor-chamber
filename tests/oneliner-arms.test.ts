// @vitest-environment happy-dom
/**
 * Small behaviours of the transition bridge, createReaction, encodeQueryParam, resolveBase and buildMenu.
 * Why: a transition whose `done()` never fires leaves the element stuck mid-transition; a refused reaction whose unsubscribe throws, or a scalar `mapPayload` that gets wrapped, would break callers; a scalar for an `array` param must still encode as an array. Also the only file reaching the transition's rejected-promise arm, a refused reaction's no-op unsubscribe, a scalar `array` param and buildMenu with no flagged rows, so the 100% floor needs it.
 * Shows: `done()` fires once when the handler fails, the dispatch promise rejects, or it resolves; a refused createReaction returns a safe no-op unsubscribe; `mapPayload` scalars pass unwrapped and objects get the causation marker; encodeQueryParam wraps scalars, keeps arrays, and drops default and empty arrays; resolveBase gives the prefix or '' without locales, and an explicit `url` wins; buildMenu returns `[]` with no flagged rows and stamps `exactActive` on flagged ones.
 */
import { describe, it, expect, vi } from 'vitest';
import { createTransitionBridge } from '../src/transitions';
import { createReaction } from '../src/utilities';
import { createCommandBus, createAsyncCommandBus } from '../src/index';
import { encodeQueryParam } from '@router/url';
import { resolveBase } from '@router/history';
import { buildMenu } from '@router/menu';
import { createRouteTable } from '@router/table';

describe('transition bridge done() callback', () => {
  it('calls done() when a handler fails (the bus resolves that as errResult)', async () => {
    const bus = createAsyncCommandBus({ onMissing: 'ignore' });
    bus.register('modalEnter', async () => { throw new Error('animation handler died'); });
    const t: any = createTransitionBridge({ bus, namespace: 'modal' });

    const done = vi.fn();
    t.onEnter(document.createElement('div'), done);

    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1));
  });

  it('calls done() when the dispatch promise itself REJECTS', async () => {
    // The chamber bus never rejects, but the bridge also accepts other BaseBus implementations that might.
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

describe('createReaction', () => {
  it('returns a callable no-op unsubscribe when it refuses to install', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bus = createCommandBus({ onMissing: 'ignore' });

    // The source pattern matches its own target, so install refuses.
    const off = createReaction('cart*', 'cartSync').install(bus);

    expect(error).toHaveBeenCalledTimes(1);
    expect(typeof off).toBe('function');
    expect(() => off()).not.toThrow();
  });

  it('passes a non-object mapPayload value through unwrapped', () => {
    const bus = createCommandBus({ onMissing: 'ignore' });
    const seen: unknown[] = [];
    bus.register('source', () => 1);
    bus.register('target', (cmd: any) => { seen.push(cmd.payload); return 2; });

    const off = createReaction('source', 'target', { mapPayload: () => 'a bare string' }).install(bus);
    bus.dispatch('source', {});

    // A scalar has nothing to carry the causation marker, so it rides as-is.
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

describe('encodeQueryParam', () => {
  it('wraps a scalar for a declared array param', () => {
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

describe('resolveBase', () => {
  it('falls back to an empty pathname with no window and no option', () => {
    // Without `url` or `locales` the base is the prefix, whatever the pathname.
    expect(resolveBase({})).toBe('');
    expect(resolveBase({ prefix: '/admin' })).toBe('/admin');
  });

  it('prefers an explicit url over everything else', () => {
    expect(resolveBase({ url: '/shop/', pathname: '/other' })).toBe('/shop');
  });
});

describe('buildMenu', () => {
  it('returns an empty menu when no row carries meta.menu', () => {
    const table = createRouteTable([
      { name: 'home', path: '/', component: 'Home' },
      { name: 'list', path: '/list', component: 'List' },
    ]);
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
