// @vitest-environment happy-dom
/** `location.path` is the path as in the URL; only params are decoded. The long note is at the end. */
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
    router.destroy();
  });

  it('a named push encodes the param into the path', async () => {
    const router = await build();
    await router.push({ name: 'item', params: { id: 'a b' } });
    const location = router.currentRoute.value.location;
    expect(location.path).toBe('/item/a%20b');
    expect(location.params.id).toBe('a b');
    router.destroy();
  });
});

/*
 * Router re-review, 1.26 (log 35.95). `RouteLocation.path` was documented as
 * "Decoded path relative to base" and `RouteTable.resolve` as taking "a decoded
 * path". Neither is what the code does: the engine takes the path from the
 * string as given (the history hands it `location.pathname`, which the browser
 * percent-encodes) or from `buildPath`, which encodes each param; the table
 * matches that and decodes only the captured params. vue-router's `path` is
 * the encoded one too. The comments now say so; these tests pin the behaviour
 * they state.
 */
