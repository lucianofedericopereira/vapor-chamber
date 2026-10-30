/**
 * routerFacts emits a fact after a navigation commits or fails, and never dispatches a command.
 * Why: if a navigation were a dispatched command, the bus's guards and hooks would gate it; if no fact were emitted, bus plugins, listeners and DevTools could not see navigations.
 * Shows: routerNavigated carries to and from with no meta and no dispatch; routerFailed carries the error and target; a refusal and a query-only change emit nothing; the stop, and stopping a Vue scope, end both subscriptions; without routerFacts nothing is emitted.
 * See: log s35.215
 */
import { describe, expect, it } from 'vitest';
import { effectScope } from 'vue';
import { createCommandBus } from '../../src/command-bus';
import { routerFacts } from '@router/index';
import type { RouteRecord } from '@router/types';
import { ROWS, makeRouter } from './fixture';

const BROKEN: RouteRecord = { name: 'broken', path: '/broken', parent: 'shell', component: 'Missing' };

function setup(withFacts: boolean) {
  const router = makeRouter({ routes: [...ROWS, BROKEN], links: false, onError: () => {} });
  const bus = createCommandBus();
  const heard: Array<{ event: string; data: any; meta: unknown }> = [];
  bus.on('router*', (cmd) => heard.push({ event: cmd.action, data: cmd.target, meta: cmd.meta }));
  const commands: string[] = [];
  bus.onAfter((cmd) => commands.push(cmd.action));
  const stop = withFacts ? routerFacts(router, bus) : () => {};
  return { router, bus, heard, commands, stop };
}

describe('routerFacts', () => {
  it('a committed navigation emits routerNavigated with to and from', async () => {
    const { router, heard, commands } = setup(true);
    await router.isReady();
    await router.push('/list');
    expect(heard.map((h) => [h.event, h.data.from.path, h.data.to.path])).toEqual([
      ['routerNavigated', '/', '/'],
      ['routerNavigated', '/', '/list'],
    ]);
    // Facts carry no meta and reach no dispatch hook.
    expect(heard.every((h) => h.meta === undefined)).toBe(true);
    expect(commands).toEqual([]);
  });

  it('a failed navigation emits routerFailed with the error and its target', async () => {
    const { router, heard } = setup(true);
    await router.isReady();
    await router.push('/broken');
    const failed = heard.filter((h) => h.event === 'routerFailed');
    expect(failed.map((h) => [h.data.error.code, h.data.to.path])).toEqual([['router:missing:component', '/broken']]);
  });

  it('a refused navigation and a query-only change emit nothing', async () => {
    const { router, heard } = setup(true);
    await router.isReady();
    heard.length = 0;
    const off = router.beforeEach(() => false);
    await router.push('/list');
    off();
    await router.push('/?q=1');
    expect(heard).toEqual([]);
  });

  it('the stop ends both subscriptions', async () => {
    const { router, heard, stop } = setup(true);
    await router.isReady();
    stop();
    heard.length = 0;
    await router.push('/list');
    await router.push('/broken');
    expect(heard).toEqual([]);
  });

  it('made inside a Vue scope, both subscriptions stop with it', async () => {
    const router = makeRouter({ routes: [...ROWS, BROKEN], links: false, onError: () => {} });
    const bus = createCommandBus();
    const heard: string[] = [];
    bus.on('router*', (cmd) => heard.push(cmd.action));
    const scope = effectScope();
    scope.run(() => routerFacts(router, bus));
    await router.isReady();
    await router.push('/list');
    scope.stop();
    await router.push('/');
    await router.push('/broken');
    expect(heard).toEqual(['routerNavigated', 'routerNavigated']);
  });

  it('control: without routerFacts the same navigations emit nothing', async () => {
    const { router, heard } = setup(false);
    await router.isReady();
    await router.push('/list');
    await router.push('/broken');
    expect(heard).toEqual([]);
  });
});
