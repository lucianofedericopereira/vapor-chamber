// @vitest-environment happy-dom
/**
 * A RouterError has exactly the core BusError's two hidden classes: one without a cause, one with.
 * Why: a RouterError with extra object shapes (per optional `to` or `cause`) would make every `isRouterError` read and every handler switching on `code` polymorphic in V8.
 * Shows: with or without `to` is one map; a cause adds the one own property BusError gives it; both maps equal BusError's; a superseded push and an unknown name share a map; absent `context` and `cause` read undefined; a plain Error differs from a RouterError.
 * See: log s35.94, log s35.108
 */
import { describe, expect, it } from 'vitest';
import { sameMap } from '../v8';
import { BusError } from '../../src/failure';
import { routerError } from '@router/errors';
import { createMemoryHistory } from '@router/history';
import { createRouter } from '@router/index';
import { ROWS } from './fixture';

const to = { name: 'list', path: '/list', fullPath: '/list', params: {}, query: {}, hash: '', matched: [], meta: {} };

describe('RouterError shape', () => {
  it('with and without `to`, one map; a cause adds the one own property BusError gives it', () => {
    const plain = routerError('missing:record', 'a');
    expect(sameMap(plain, routerError('aborted:navigation', 'b', { to }))).toBe(true);
    const caused = routerError('missing:router', 'd', { cause: 1 });
    expect(sameMap(caused, routerError('failed:loader', 'c', { to, cause: new Error('x') }))).toBe(true);
    expect(sameMap(plain, caused)).toBe(false);
    // The same two maps as the core's own failures, whoever raised them.
    expect(sameMap(plain, new BusError('missing:handler', 'e'))).toBe(true);
    expect(sameMap(caused, new BusError('failed:handler', 'f', { cause: 2 }))).toBe(true);
  });

  it('the navigation path: a superseded push and an unknown name share it', async () => {
    const router = createRouter({
      history: createMemoryHistory('/'),
      routes: [...ROWS, { name: 'other', path: '/other', parent: 'shell', component: 'Other' }],
      components: { Home: { name: 'Home' }, List: { name: 'List' }, Other: { name: 'Other' } },
      scroll: false,
      links: false,
      announce: false,
      onError: () => {},
    });
    await router.isReady();
    const first = router.push('/list');
    await router.push('/other');
    const cancelled = await first;
    const unknown = await router.push({ name: 'nope' });
    expect(cancelled?.code).toBe('router:aborted:navigation');
    expect(unknown?.code).toBe('router:missing:record');
    expect(sameMap(cancelled as object, unknown as object)).toBe(true);
    router.dispose();
  });

  it('absent options read as undefined, as before', () => {
    const error = routerError('missing:record', 'a');
    expect(error.context).toBeUndefined();
    expect(error.cause).toBeUndefined();
  });

  it('control: the probe tells a plain Error from a RouterError', () => {
    expect(sameMap(new Error('a'), routerError('missing:record', 'a'))).toBe(false);
  });
});
