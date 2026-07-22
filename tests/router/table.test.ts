import { describe, expect, it } from 'vitest';
import { compilePath, createRouteTable } from '../../src/router/table';
import type { RouteRecord } from '../../src/router/types';

const ROWS: RouteRecord[] = [
  { name: 'catalog', path: '/catalog', parent: null, query: { view: { type: 'string', default: 'grid' } } },
  {
    name: 'catalog.products.edit',
    path: '/catalog/products/:id(\\d+)/edit',
    parent: 'catalog',
    component: 'Catalog/EditPage',
    params: { id: 'int' },
  },
  {
    name: 'catalog.products',
    path: '/catalog/products',
    parent: 'catalog',
    component: 'Catalog/ListPage',
    query: { page: { type: 'int', default: 1 } },
  },
  { name: 'docs', path: '/docs/*', component: 'DocsPage' },
  { name: 'report', path: '/report/:period?', component: 'ReportPage' },
  { name: 'legacy.orders', path: '/sales/orders/:id/view', blade: true },
  { name: 'home', path: '/', component: 'Dashboard' },
];

describe('compilePath', () => {
  it('compiles static, param, custom-regex, optional and splat segments', () => {
    expect(compilePath('/a/b').re.test('/a/b')).toBe(true);
    expect(compilePath('/a/:x').keys).toEqual(['x']);
    expect(compilePath('/a/:x(\\d+)').re.test('/a/12')).toBe(true);
    expect(compilePath('/a/:x(\\d+)').re.test('/a/xy')).toBe(false);
    expect(compilePath('/a/:x?').re.test('/a')).toBe(true);
    expect(compilePath('/d/*').re.test('/d/deep/er')).toBe(true);
  });

  it('matches root and tolerates trailing slashes', () => {
    expect(compilePath('/').re.test('/')).toBe(true);
    expect(compilePath('/a').re.test('/a/')).toBe(true);
  });

  it('is case-insensitive on static segments', () => {
    expect(compilePath('/Catalog').re.test('/catalog')).toBe(true);
  });
});

describe('createRouteTable', () => {
  const table = createRouteTable(ROWS);

  it('resolves in server order, first match wins, with typed params', () => {
    const hit = table.resolve('/catalog/products/42/edit');
    expect(hit?.record.name).toBe('catalog.products.edit');
    expect(hit?.params).toEqual({ id: 42 });
  });

  it('precomputes the root-first chain', () => {
    const record = table.getRecord('catalog.products');
    expect(record?.chain.map((r) => r.name)).toEqual(['catalog', 'catalog.products']);
  });

  it('precomputes the renderable chain (groups excluded)', () => {
    const record = table.getRecord('catalog.products');
    expect(record?.renderChain.map((r) => r.name)).toEqual(['catalog.products']);
  });

  it('precomputes chain-merged query defs, leaf wins', () => {
    const record = table.getRecord('catalog.products');
    expect(record?.queryDefs.page?.default).toBe(1);
    expect(record?.queryDefs.view?.default).toBe('grid'); // inherited from the group parent
  });

  it('never matches pure group records directly', () => {
    expect(table.resolve('/catalog')).toBeNull();
  });

  it('matches blade records and leaves undeclared params as strings', () => {
    const hit = table.resolve('/sales/orders/9/view');
    expect(hit?.record.blade).toBe(true);
    expect(hit?.params.id).toBe('9');
  });

  it('captures splats as pathMatch and handles optional params', () => {
    expect(table.resolve('/docs/guide/install')?.params.pathMatch).toBe('guide/install');
    expect(table.resolve('/report')?.record.name).toBe('report');
    expect(table.resolve('/report/2026-07')?.params.period).toBe('2026-07');
  });

  it('decodes encoded path segments', () => {
    const slugTable = createRouteTable([{ name: 's', path: '/tag/:slug', component: 'X' }]);
    expect(slugTable.resolve('/tag/caff%C3%A8')?.params.slug).toBe('caffè');
  });

  it('returns null for unknown paths', () => {
    expect(table.resolve('/nope')).toBeNull();
  });

  it('builds paths back from params', () => {
    const edit = table.getRecord('catalog.products.edit');
    expect(edit && table.buildPath(edit, { id: 42 })).toBe('/catalog/products/42/edit');
    const report = table.getRecord('report');
    expect(report && table.buildPath(report)).toBe('/report');
  });

  it('throws coded errors: missing_param, duplicate_route, unknown_parent', () => {
    const edit = table.getRecord('catalog.products.edit');
    expect(() => edit && table.buildPath(edit)).toThrow(expect.objectContaining({ code: 'missing_param' }));
    expect(() => createRouteTable([ROWS[6] as RouteRecord, ROWS[6] as RouteRecord])).toThrow(
      expect.objectContaining({ code: 'duplicate_route' }),
    );
    expect(() => createRouteTable([{ name: 'x', path: '/x', parent: 'ghost' }])).toThrow(
      expect.objectContaining({ code: 'unknown_parent' }),
    );
  });
});

describe('malformed param segments are a dev-time error, not a dead route', () => {
  it('rejects vue-router style /:name* instead of compiling it to a literal', () => {
    // Regression: PARAM_RE does not match ":pathMatch*", so the segment fell
    // through to `static` and compiled to the LITERAL "/:pathMatch*". The row
    // matched nothing, every unknown URL became `unmatched`, and — behind a
    // catch-all server — the hard-navigation fallback reloaded forever.
    expect(() => compilePath('/:pathMatch*')).toThrow(/not a valid param/);
    expect(() => compilePath('/products/:id(\\d+')).toThrow(/not a valid param/);
  });

  it('accepts every supported form', () => {
    expect(() => compilePath('/*')).not.toThrow();
    expect(() => compilePath('/products/:id')).not.toThrow();
    expect(() => compilePath('/products/:id(\\d+)')).not.toThrow();
    expect(() => compilePath('/products/:id?')).not.toThrow();
    expect(() => compilePath('/products/:rest(.*)')).not.toThrow();
  });

  it('the supported splat actually catches unknown paths', () => {
    const table = createRouteTable([
      { name: 'home', path: '/', component: 'H' },
      { name: 'notFound', path: '/*', component: 'N' },
    ]);
    expect(table.resolve('/')?.record.name).toBe('home');
    expect(table.resolve('/nope')?.record.name).toBe('notFound');
    expect(table.resolve('/deep/unknown/path')?.record.name).toBe('notFound');
  });
});

describe('renderSegments — the one path builder both callers share', () => {
  const table = createRouteTable([
    { name: 'files', path: '/files/*', component: 'F' },
    { name: 'user', path: '/users/:id', component: 'U' },
    { name: 'opt', path: '/opt/:slug?', component: 'O' },
  ]);

  it('appends the splat tail when pathMatch is present', () => {
    expect(table.buildPath(table.getRecord('files')!, { pathMatch: 'a/b/c' })).toBe('/files/a/b/c');
  });

  it('omits the splat entirely when pathMatch is absent or empty', () => {
    const record = table.getRecord('files')!;
    expect(table.buildPath(record, {})).toBe('/files');
    expect(table.buildPath(record, { pathMatch: '' })).toBe('/files');
  });

  it('skips an absent OPTIONAL param instead of failing', () => {
    expect(table.buildPath(table.getRecord('opt')!, {})).toBe('/opt');
  });

  it('names the missing param when a REQUIRED one is absent', () => {
    expect(() => table.buildPath(table.getRecord('user')!, {})).toThrow(/missing param "id"/);
  });

  it('encodes param values', () => {
    expect(table.buildPath(table.getRecord('user')!, { id: 'a b/c' })).toBe('/users/a%20b%2Fc');
  });
});

describe('decodePathPart — malformed percent-encoding', () => {
  it('returns the raw segment rather than throwing on a bad escape', () => {
    // decodeURIComponent('%E0%A4%A') throws URIError; a bad URL must not take
    // the router down, it just does not decode.
    const t = createRouteTable([{ name: 'u', path: '/users/:id', component: 'U' }]);
    const hit = t.resolve('/users/%E0%A4%A');
    expect(hit?.params.id).toBe('%E0%A4%A');
  });
});
