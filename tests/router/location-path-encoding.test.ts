// @vitest-environment happy-dom
/**
 * `location.path` is the path as in the URL (percent-encoded); only params are decoded.
 * Why: a link or redirect built from `location.path` would double-decode or break on spaces and reserved characters if the path were decoded.
 * Shows: a pushed string keeps its encoding in path and fullPath while the param is decoded; a named push encodes the param into the path.
 * See: log 35.95
 */
import { describe, expect, it } from 'vitest';
import { createMemoryHistory } from '@router/history';
import { createRouter } from '@router/index';
import { ROWS } from './fixture';

async function build() {
  const router = createRouter({
    history: createMemoryHistory('/'),
    routes: [...ROWS, { name: 'item', path: '/item/:id', parent: 'shell', component: 'List' }],
    components: { Home: { name: 'Home' }, List: { name: 'List' } },
    scroll: false,
    links: false,
    announce: false,
  });
  await router.isReady();
  return router;
}

describe('location.path encoding', () => {
  it('a pushed string keeps its percent-encoding in path and fullPath; the param is decoded', async () => {
    const router = await build();
    await router.push('/item/a%20b?q=1');
    const location = router.currentRoute.value.location;
    expect(location.path).toBe('/item/a%20b');
    expect(location.fullPath).toBe('/item/a%20b?q=1');
    expect(location.params.id).toBe('a b');
    router.dispose();
  });

  it('a named push encodes the param into the path', async () => {
    const router = await build();
    await router.push({ name: 'item', params: { id: 'a b' } });
    const location = router.currentRoute.value.location;
    expect(location.path).toBe('/item/a%20b');
    expect(location.params.id).toBe('a b');
    router.dispose();
  });
});
