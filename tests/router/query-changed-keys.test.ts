/**
 * A repeated query key and a comma in one value are different queries.
 * Why: the query diff that picks loaders to refetch would read `?tag=a&tag=b` and `?tag=a,b` as equal, leaving a page showing rows for the previous filter while the URL claims another; widening it too far would refetch where consumers do not expect it.
 * Shows: through a real router and loader, a repeated key becoming a comma-joined value (and back) refetches; a one-element array meets its scalar, and absent, '' and [] collapse together, without a refetch.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryHistory } from '@router/history';
import type { RouteRecord } from '@router/types';
import type { LoaderHandlers } from '@router/index';
import { makeRouter as fixtureRouter } from './fixture';

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
  const router = fixtureRouter({
    history: createMemoryHistory(''),
    routes: ROWS,
    components: { Products: { render: () => null } } as never,
    loaders: handlers,
    links: false,
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

    // The object form reaches cleanQueryPatch with a genuinely empty array; it serialises to no query, a real change away from `tag=a`.
    await router.push({ path: '/products', query: { tag: [] } } as never);
    await settle();
    expect(calls.length).toBe(before + 1);

    // Once landed, `[]` compares equal to absent, so repeating it is not a second change.
    const after = calls.length;
    await router.push({ path: '/products', query: { tag: [] } } as never);
    await settle();
    expect(calls.length).toBe(after);
  });
});
