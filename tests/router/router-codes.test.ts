/**
 * Router failures are core BusErrors coded `router:condition:subject`, and the registry and HARD_NAV_CODES agree with them.
 * Why: a router failure that is not a core BusError would be unreadable by the core's owner and condition readers, would carry a stack when it is only a refusal or a supersede, and could be misclassified as a hard navigation.
 * Shows: owner, condition, code and `context.to` read like any core failure; a superseded navigation has no stack and a failure keeps one; a guard throw, a missing url and a missing or throwing loader each get their own code; the registry's router rows and HARD_NAV_CODES match the stated lists.
 * See: log s35.108, docs/contract.md
 */
import { describe, expect, it } from 'vitest';
import { BusError, conditionOf, ownerOf } from '../../src/command-bus';
import { HARD_NAV_CODES, isRouterError } from '@router/errors';
import { ERROR_CODE_REGISTRY } from '../../src/error-registry';
import { ROWS, makeRouter } from './fixture';

const withLoad = (load: string) => [...ROWS, { name: 'data', path: '/data', parent: 'shell', component: 'Home', load }];
const stackLines = (e: unknown) => /\n\s+at /.test(String((e as Error).stack));

describe('a router failure is the core failure', () => {
  it('a BusError owned by router, its condition read like any other, the target in context', async () => {
    const router = makeRouter({ links: false, announce: false });
    await router.start();
    const error = await router.push('/nowhere');
    expect(error).toBeInstanceOf(BusError);
    expect(ownerOf(error)).toBe('router');
    expect(conditionOf(error)).toBe('missing');
    expect(error?.code).toBe('router:missing:route');
    expect((error as BusError).context?.to).toMatchObject({ fullPath: '/nowhere' });
    expect(isRouterError(error, 'router:missing:route')).toBe(true);
    expect(String((error as BusError).toJSON().type)).toMatch(/errors\.md#missing$/);
    router.dispose();
  });

  it('a superseded navigation carries no stack; a failure keeps its own', async () => {
    let release!: () => void;
    const router = makeRouter({ links: false, announce: false });
    router.beforeEach((to) => (to.path === '/list' ? new Promise<boolean>((r) => { release = () => r(true); }) : true));
    await router.start();
    const held = router.push('/list');
    await Promise.resolve();
    await router.push('/');
    release();
    const superseded = await held;
    expect(superseded?.code).toBe('router:aborted:navigation');
    expect(stackLines(superseded)).toBe(false);
    router.dispose();

    const failing = makeRouter({ links: false, announce: false, onError: () => {} });
    failing.beforeEach(() => { throw new Error('guard bug'); });
    await failing.start().catch(() => {});
    const failed = await failing.push('/list');
    expect(failed?.code).toBe('router:failed:guard');
    expect(stackLines(failed)).toBe(true);
    failing.dispose();
  });
});

describe('codes the old taxonomy merged', () => {
  it('a guard that throws is router:failed:guard, its throw the cause, and not a hard navigation', async () => {
    const thrown = new Error('guard bug');
    const router = makeRouter({ links: false, announce: false, onError: () => {} });
    await router.start();
    router.beforeEach((to) => { if (to.path === '/list') throw thrown; return true; });
    const error = await router.push('/list');
    expect(error?.code).toBe('router:failed:guard');
    expect((error as Error).cause).toBe(thrown);
    expect(HARD_NAV_CODES.has(error!.code)).toBe(false);
    router.dispose();
  });

  it('reload() with no { url } source is router:missing:url, not a failed load', async () => {
    const router = makeRouter({ links: false, announce: false });
    await router.start();
    const error = await router.reload().then(() => null, (e: unknown) => e);
    expect(isRouterError(error, 'router:missing:url')).toBe(true);
    router.dispose();
  });

  it('a load no handler serves is router:missing:loader; a loader that throws is router:failed:loader', async () => {
    const none = makeRouter({ links: false, announce: false, routes: withLoad('rows:x'), loaders: {}, onError: () => {} });
    await none.start();
    expect((await none.push('/data'))?.code).toBe('router:missing:loader');
    none.dispose();

    const throwing = makeRouter({
      links: false, announce: false, routes: withLoad('rows:x'), onError: () => {},
      loaders: { prefixes: { 'rows:': () => { throw new Error('backend down'); } } },
    });
    await throwing.start();
    expect((await throwing.push('/data'))?.code).toBe('router:failed:loader');
    throwing.dispose();
  });
});

describe('the catalogue', () => {
  const routerRows = ERROR_CODE_REGISTRY.filter((e) => e.code.startsWith('router:'));

  it('every router code has a registry row', () => {
    expect(routerRows.map((e) => e.code).sort()).toEqual([
      'router:aborted:navigation', 'router:already:route', 'router:conflict:base', 'router:exceeded:redirects',
      'router:failed:blade', 'router:failed:commit', 'router:failed:component', 'router:failed:guard', 'router:failed:history', 'router:failed:hook', 'router:failed:loader',
      'router:failed:navigation', 'router:failed:revalidate', 'router:failed:routes',
      'router:invalid:component', 'router:invalid:menu', 'router:invalid:parent', 'router:invalid:path',
      'router:missing:component', 'router:missing:fetchBlade', 'router:missing:http', 'router:missing:inline',
      'router:missing:loader', 'router:missing:param', 'router:missing:parent', 'router:missing:record',
      'router:missing:route', 'router:missing:router', 'router:missing:routes', 'router:missing:url',
      'router:refused:guard', 'router:unexpected:routes',
    ]);
  });

  it("HARD_NAV_CODES is the plan's rule over them: missing or failed route, component or server HTML", () => {
    const rule = routerRows.map((e) => e.code).filter((code) => {
      const [, condition, subject] = code.split(':');
      return (condition === 'missing' || condition === 'failed') && (subject === 'route' || subject === 'component' || subject === 'blade');
    });
    expect([...HARD_NAV_CODES].sort()).toEqual(rule.sort());
  });
});
