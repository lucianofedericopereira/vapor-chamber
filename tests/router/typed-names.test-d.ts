import { createRouter, createMemoryHistory } from '../../src/router/index';

// Compile-time check: createRouter<TName> narrows push/resolve names.
type AdminRouteName = 'home' | 'products';

const router = createRouter<AdminRouteName>({
  history: createMemoryHistory(),
  routes: [{ name: 'home', path: '/', component: 'Home' }],
  components: { Home: {} },
});

void router.push({ name: 'home' });
void router.push({ name: 'products' });
// @ts-expect-error — typo'd route name must not compile
void router.push({ name: 'prodcts' });
