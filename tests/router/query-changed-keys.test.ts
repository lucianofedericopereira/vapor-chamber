/**
 * A repeated query key and a comma in one value are different queries.
 *
 * The engine decides which loaders to refetch on a query-only change by
 * diffing the old and new query. That diff compared `String(a[key])` against
 * `String(b[key])`, and `String(['a','b'])` is `'a,b'` - identical to the
 * scalar `'a,b'`. So `?tag=a&tag=b` -> `?tag=a,b` (and back) read as NO
 * change, the affected loader never refetched, and the page kept showing rows
 * for the previous filter while the URL claimed otherwise.
 *
 * Counted through a real router and a real loader rather than asserted against
 * the diff helper, since the helper is private and the observable symptom is
 * the missing fetch.
 *
 * The equalities that were always true are pinned here too: a one-element
 * array is still the same value as the scalar, and absent / '' / [] still
 * collapse together. Widening the diff would refetch where consumers
 * currently do not.
 */

import { describe, expect, it } from 'vitest';
import { createMemoryHistory } from '../../src/router/history';
import { createRouter } from '../../src/router/index';
import type { RouteRecord } from '../../src/router/types';
import type { LoaderHandlers } from '../../src/router/index';

const ROWS: RouteRecord[] = [
  {
    name: 'products',
    path: '/products',
    component: 'Products',
    load: 'rows:products',
    query: { tag: {}, page: { type: 'int', default: 1 } },
  },
];

function makeRouter() {
  const calls: Array<string | string[] | undefined> = [];
  const handlers: LoaderHandlers = {
    prefixes: {
      'rows:': (_ref, location) => {
        calls.push(location.query.tag);
        return { ok: true };
      },
    },
  };
  const router = createRouter({
    history: createMemoryHistory(''),
    routes: ROWS,
    components: { Products: { render: () => null } } as never,
    loaders: handlers,
    links: false,
    scroll: false,
    onError: () => {},
  });
  return { router, calls };
}

/** The refetch is fire-and-forget; let its microtasks drain. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('query diff - array versus comma-joined scalar', () => {
  it('refetches when a repeated key becomes one comma-joined value', async () => {
    const { router, calls } = makeRouter();
    await router.isReady();
    await router.push('/products?tag=a&tag=b');
    await settle();
    const before = calls.length;

    await router.push('/products?tag=a,b');
    await settle();

    // Pre-fix: both stringified to 'a,b', so this refetch never happened.
    expect(calls.length).toBe(before + 1);
    expect(calls[calls.length - 1]).toBe('a,b');
  });

  it('refetches when one comma-joined value becomes a repeated key', async () => {
    const { router, calls } = makeRouter();
    await router.isReady();
    await router.push('/products?tag=a,b');
    await settle();
    const before = calls.length;

    await router.push('/products?tag=a&tag=b');
    await settle();

    expect(calls.length).toBe(before + 1);
    expect(calls[calls.length - 1]).toEqual(['a', 'b']);
  });
});

describe('query diff - equalities that must NOT widen', () => {
  it('does not refetch when a single-element array meets its scalar', async () => {
    const { router, calls } = makeRouter();
    await router.isReady();
    await router.push('/products?tag=a');
    await settle();
    const before = calls.length;

    router.setQuery({ tag: ['a'] });
    await settle();

    expect(calls.length).toBe(before);
  });

  it('does not refetch when an absent key is written as empty', async () => {
    const { router, calls } = makeRouter();
    await router.isReady();
    await router.push('/products');
    await settle();
    const before = calls.length;

    router.setQuery({ tag: '' });
    await settle();

    expect(calls.length).toBe(before);
  });

  it('treats an EMPTY array as the empty value, not as a distinct one', async () => {
    const { router, calls } = makeRouter();
    await router.isReady();
    await router.push('/products?tag=a');
    await settle();
    const before = calls.length;

    // `{ query: { tag: [] } }` is the object form that reaches cleanQueryPatch
    // with a genuinely empty array - it serialises to no query at all, so this
    // is a real change away from `tag=a` and must refetch...
    await router.push({ path: '/products', query: { tag: [] } } as never);
    await settle();
    expect(calls.length).toBe(before + 1);

    // ...and having landed, `[]` must compare equal to absent, so repeating it
    // is not a second change. Both arms of the empty-array case in one test.
    const after = calls.length;
    await router.push({ path: '/products', query: { tag: [] } } as never);
    await settle();
    expect(calls.length).toBe(after);
  });
});
