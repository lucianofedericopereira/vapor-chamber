import { describe, expect, it } from 'vitest';
import { isRouterError } from '../../src/router/errors';
import { createMemoryHistory } from '../../src/router/history';
import { createRouter } from '../../src/router/index';
import { buildBreadcrumbs, buildMenu } from '../../src/router/menu';
import { createRouteTable } from '../../src/router/table';
import type { RouteRecord } from '../../src/router/types';
import { pathActivity } from '../../src/router/url';

/** An admin-shaped table: a menued section GROUP with menued children, a
 *  menued static leaf, a non-menued detail route under a titled ancestor. */
const ROWS: RouteRecord[] = [
  { name: 'shell', path: '/', parent: null }, // layout group, not menued
  { name: 'home', path: '/', parent: 'shell', component: 'Home', meta: { title: 'admin.home', menu: 10 } },
  {
    name: 'catalog',
    path: '/catalog',
    parent: 'shell',
    meta: { title: 'admin.catalog', menu: 20 }, // group section node: no component
  },
  {
    name: 'products',
    path: '/catalog/products',
    parent: 'catalog',
    component: 'Products',
    meta: { title: 'admin.products', menu: 22 },
  },
  {
    name: 'brands',
    path: '/catalog/brands',
    parent: 'catalog',
    component: 'Brands',
    meta: { title: 'admin.brands', menu: 21 },
  },
  {
    name: 'product.edit',
    path: '/catalog/products/:id(\\d+)/edit',
    parent: 'products',
    component: 'Edit',
    params: { id: 'int' },
    meta: { title: 'admin.edit' }, // titled but NOT menued
  },
  { name: 'orders', path: '/orders', parent: 'shell', component: 'Orders', meta: { title: 'admin.orders', menu: 30 } },
];

const records = () => createRouteTable(ROWS).records;

describe('buildMenu', () => {
  it('projects menued rows only, position-sorted, nested under the nearest menued ancestor', () => {
    const menu = buildMenu(records(), '/');

    expect(menu.map((item) => item.name)).toEqual(['home', 'catalog', 'orders']);
    // catalog's children sort by meta.menu (brands 21 < products 22), not table order.
    const catalog = menu[1];
    expect(catalog?.children.map((item) => item.name)).toEqual(['brands', 'products']);
    // product.edit has a title but no meta.menu — never in the menu.
    expect(JSON.stringify(menu)).not.toContain('product.edit');
  });

  it('gives group section nodes no href; leaf items get base-prefixed hrefs', () => {
    const menu = buildMenu(records(), '/', '/admin');

    const catalog = menu[1];
    expect(catalog?.href).toBeNull();
    expect(catalog?.children[1]?.href).toBe('/admin/catalog/products');
    expect(menu[0]?.href).toBe('/admin/');
    expect(menu[0]?.title).toBe('admin.home');
  });

  it('stamps active/exact like data-active, and parents light up with their children', () => {
    const menu = buildMenu(records(), '/catalog/products/7/edit');

    const [home, catalog, orders] = menu;
    expect(home?.active).toBe(false);
    expect(orders?.active).toBe(false);
    const products = catalog?.children[1];
    expect(products?.active).toBe(true); // prefix match, same rule as stamping
    expect(products?.exactActive).toBe(false);
    // the group has no path of its own — active flows up from products
    expect(catalog?.active).toBe(true);
    expect(catalog?.exactActive).toBe(false);

    const exact = buildMenu(records(), '/catalog/products');
    expect(exact[1]?.children[1]?.exactActive).toBe(true);
  });

  it('is loud about menu rows without a title, non-numeric positions, and required params', () => {
    const noTitle = createRouteTable([{ name: 'x', path: '/x', component: 'X', meta: { menu: 1 } }]).records;
    expect(() => buildMenu(noTitle, '/')).toThrowError(/needs meta\.title/);

    const badPos = createRouteTable([
      { name: 'x', path: '/x', component: 'X', meta: { menu: 'first', title: 't' } },
    ]).records;
    expect(() => buildMenu(badPos, '/')).toThrowError(/meta\.menu must be a number/);

    const dynamic = createRouteTable([
      { name: 'x', path: '/x/:id', component: 'X', meta: { menu: 1, title: 't' } },
    ]).records;
    try {
      buildMenu(dynamic, '/');
      expect.unreachable('dynamic menu row accepted');
    } catch (error) {
      expect(isRouterError(error, 'bad_menu_row')).toBe(true);
    }
  });

  it('tolerates optional params and splats in menu rows (segments drop from the href)', () => {
    const rows: RouteRecord[] = [
      { name: 'report', path: '/report/:period?', component: 'R', meta: { menu: 1, title: 'admin.report' } },
      { name: 'docs', path: '/docs/*', component: 'D', meta: { menu: 2, title: 'admin.docs' } },
    ];
    const menu = buildMenu(createRouteTable(rows).records, '/');
    expect(menu.map((item) => item.href)).toEqual(['/report', '/docs']);
  });
});

describe('buildBreadcrumbs', () => {
  const table = createRouteTable(ROWS);

  function locationFor(path: string) {
    const hit = table.resolve(path);
    if (!hit) throw new Error(`unmatched: ${path}`);
    return {
      name: hit.record.name,
      path,
      fullPath: path,
      params: hit.params,
      query: {},
      hash: '',
      matched: hit.record.chain,
      meta: hit.record.meta,
    };
  }

  it('walks the parent chain root-first, keeping only titled records', () => {
    const crumbs = buildBreadcrumbs(locationFor('/catalog/products/7/edit'), '/admin');

    // shell has no title and drops; the rest is the layout chain.
    expect(crumbs.map((crumb) => crumb.name)).toEqual(['catalog', 'products', 'product.edit']);
    expect(crumbs.map((crumb) => crumb.title)).toEqual(['admin.catalog', 'admin.products', 'admin.edit']);
    expect(crumbs.map((crumb) => crumb.current)).toEqual([false, false, true]);
  });

  it('links crumbs with the location params interpolated; groups stay href-less', () => {
    const crumbs = buildBreadcrumbs(locationFor('/catalog/products/7/edit'), '/admin');

    expect(crumbs[0]?.href).toBeNull(); // catalog is a group — never a URL
    expect(crumbs[1]?.href).toBe('/admin/catalog/products');
    expect(crumbs[2]?.href).toBe('/admin/catalog/products/7/edit');
  });

  it('leaves an ancestor href-less when the location cannot supply its params', () => {
    const rows: RouteRecord[] = [
      { name: 'user', path: '/users/:userId', component: 'U', meta: { title: 'admin.user' } },
      { name: 'audit', path: '/audit', parent: 'user', component: 'A', meta: { title: 'admin.audit' } },
    ];
    const t = createRouteTable(rows);
    const hit = t.resolve('/audit');
    const crumbs = buildBreadcrumbs({
      name: 'audit',
      path: '/audit',
      fullPath: '/audit',
      params: hit?.params ?? {},
      query: {},
      hash: '',
      matched: hit?.record.chain ?? [],
      meta: {},
    });

    expect(crumbs[0]?.href).toBeNull(); // :userId not derivable from /audit
    expect(crumbs[1]?.href).toBe('/audit');
  });
});

describe('router surface', () => {
  it('exposes base and reactive routes — setRoutes swaps what useMenu would see', async () => {
    const router = createRouter({
      base: '/admin',
      history: createMemoryHistory('/admin'),
      routes: ROWS,
      components: { Home: {}, Products: {}, Brands: {}, Edit: {}, Orders: {} },
    });
    await router.isReady();

    expect(router.base).toBe('/admin');
    expect(buildMenu(router.routes.value, '/', router.base).map((item) => item.name)).toEqual([
      'home',
      'catalog',
      'orders',
    ]);

    router.setRoutes([{ name: 'only', path: '/only', component: 'Home', meta: { title: 't', menu: 1 } }]);
    expect(buildMenu(router.routes.value, '/', router.base).map((item) => item.name)).toEqual(['only']);
  });
});

describe('pathActivity', () => {
  it('is trailing-slash tolerant and never prefix-matches the root', () => {
    expect(pathActivity('/', '/')).toEqual({ active: true, exact: true });
    expect(pathActivity('/', '/anything')).toEqual({ active: false, exact: false });
    expect(pathActivity('/products/', '/products')).toEqual({ active: true, exact: true });
    expect(pathActivity('/products', '/products/7')).toEqual({ active: true, exact: false });
    expect(pathActivity('/products', '/productsx')).toEqual({ active: false, exact: false });
  });
});
