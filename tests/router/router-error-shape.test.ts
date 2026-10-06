// @vitest-environment happy-dom
/** A RouterError has the core BusError's hidden classes: one with no cause, one with. The long note is at the end. */
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
    // The same two as the core's own failures: one shape, whoever raised it.
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

/*
 * Router re-review, 1.26 (log 35.94). `routerError` built `new Error(message,
 * cause ? { cause } : undefined)` and then added `to` only when given, so a
 * RouterError came in four hidden classes (with or without each). The
 * navigation path builds both kinds: a superseded navigation's `cancelled`
 * carries `to`, a name that does not resolve (`unknown_route_name`, thrown by
 * resolveLocation) does not, a loader failure carries both; every
 * `isRouterError` read and every handler switching on `code` saw them all.
 * V8 rule: one literal per object kind, no late properties. The Error is
 * still built by `new Error` and gets `name` and `code` after it, but always
 * the same four own properties in the same order: `stack`, `message`,
 * `cause`, then `name`, `code`, `to`.
 *
 * Observable: `'cause' in error` and `'to' in error` are now true with
 * `undefined` when not given; reading either is unchanged (the third test).
 * JSON.stringify of an Error drops undefined own properties, and `cause` is
 * not enumerable.
 *
 * Log s35.108: a RouterError is now the core's BusError (router-codes.test.ts),
 * and takes its shape: `action`, `context` (where `to` lives) and `name` set on
 * every one, `cause` an own property only when given, as BusError passes it to
 * Error's constructor. So two maps, no cause and cause, and they are the core
 * failures' two: a reader of failures sees the same classes whoever raised
 * them. The superseded push and the unknown name still share one.
 */
