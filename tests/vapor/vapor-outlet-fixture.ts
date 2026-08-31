/**
 * Scenarios for the Vapor outlet, mounted against a REAL `createVaporApp` with
 * a REAL router and NO `vaporInteropPlugin` anywhere. That omission is the
 * premise under test, so nothing here may install one.
 *
 * WHY THIS IS A SEPARATE MODULE FROM THE TEST FILE. Two arms run these
 * scenarios: the in-process one under vitest, and one that esbuild bundles
 * under production defines and executes outside the runner. The second cannot
 * import vitest, so this file holds no assertions - it returns observations,
 * and `vapor-outlet.test.ts` applies the SAME assertions to both arms. A
 * behaviour that passes only under dev defines has not tested the premise: the
 * slot-fallback path was prod-only broken upstream until `2473b78`, and this
 * repo's own bug history is dev-correct/prod-broken twice over.
 *
 * It is also kept out of the outlet's own import graph so the size and
 * retained-binding arms measure the outlet and not this file's scenery.
 */

import {
  createComponent,
  createVaporApp,
  defineComponent,
  defineVaporComponent,
  h,
  nextTick,
  setInsertionState,
  template,
} from 'vue';
import { createMemoryHistory } from '../../src/router/history';
import { createRouter } from '../../src/router/index';
import { RouterOutlet } from '../../src/router/vapor';
import type { RouteRecord } from '../../src/router/types';

/** One observation set per behaviour; the caller owns the assertions. */
export type OutletObservations = {
  build: 'dev' | 'prod';
  depth: { text: string; layoutOccurrences: number; userOccurrences: number };
  nullBranch: { elementCount: number; text: string; residual: string[] };
  fallback: { text: string; elementCount: number };
  reuse: {
    setupsAfterFirstUser: number;
    setupsAfterParamSwap: number;
    sameElementAcrossParamSwap: boolean;
    setupsAfterQuerySwap: number;
    textAfterRecordSwap: string;
    setupsAfterReturningToUser: number;
    setupsAcrossTwinRecords: number;
    sameElementAcrossTwinRecords: boolean;
  };
  attrs: { layoutHtml: string; markedTag: string | null; outletChildTag: string | null };
  guard: {
    vdom: { name: string | null; code: unknown };
    blade: { name: string | null; code: unknown };
  };
};

const ROWS: RouteRecord[] = [
  // `/` exists so the router's initial navigation matches; every scenario
  // pushes away from it before observing anything.
  { name: 'home', path: '/', component: 'Home' },
  { name: 'layout', path: '/app', component: 'Layout' },
  { name: 'user', path: '/app/user/:id', parent: 'layout', component: 'User', params: { id: 'int' }, query: { tab: {} } },
  { name: 'about', path: '/app/about', parent: 'layout', component: 'About' },
  // Second record, SAME component key: reuse keys on resolved-COMPONENT
  // identity in both outlets, so crossing between these two must NOT remount.
  { name: 'twin', path: '/app/twin', parent: 'layout', component: 'User' },
  // Guard rows sit at depth 0 so the throw leaves `mount()` directly rather
  // than through a layout.
  { name: 'vdomrow', path: '/vdom', component: 'VdomPage' },
  { name: 'bladerow', path: '/blade', blade: true },
];

/** `<div class="x">...</div>` as a Vapor block, with `body` mounted into it. */
function shell(cls: string, body: (host: ParentNode) => void): Element {
  const el = (template(`<div class="${cls}"></div>`, 1) as () => Element)();
  body(el);
  return el;
}

/** A leaf route component rendering fixed markup. */
function leaf(html: string) {
  return defineVaporComponent({ setup: () => (template(html, 1) as () => Element)() });
}

/** A component whose body is one outlet - the nesting under test. */
function withOutlet(cls: string, slots?: Record<string, unknown>, props?: Record<string, unknown>) {
  return defineVaporComponent({
    setup: () =>
      shell(cls, (host) => {
        setInsertionState(host);
        createComponent(RouterOutlet as never, (props ?? null) as never, slots as never);
      }),
  });
}

/**
 * Classifier for what a branch left behind. A fragment anchor is a comment
 * node in dev and an empty text node under production defines, so node KIND is
 * the only assertion that is not dev/prod divergent by construction.
 */
function describeNode(node: Node): string {
  if (node.nodeType === 8) return `anchor:comment(${(node as Comment).data})`;
  if (node.nodeType === 3 && (node as Text).data === '') return 'anchor:empty-text';
  if (node.nodeType === 3) return `text(${(node as Text).data})`;
  return `element(${(node as Element).tagName})`;
}

type FixtureRouter = {
  isReady: () => Promise<void>;
  push: (to: string) => Promise<unknown>;
  destroy: () => void;
};

function makeRouter(components: Record<string, unknown>) {
  return createRouter({
    base: '',
    history: createMemoryHistory(''),
    routes: ROWS,
    components: { Home: leaf('<span>home</span>'), ...components },
    // A real router option, not a mock of anything under test: it is what
    // turns the blade row into a resolved component so the guard can see it.
    fetchBlade: async () => '<p>blade</p>',
  }) as unknown as FixtureRouter;
}

/** One real `createVaporApp`, one real router, NO `vaporInteropPlugin`. */
async function scenario(components: Record<string, unknown>, root?: unknown) {
  const router = makeRouter(components);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = createVaporApp((root ?? withOutlet('root')) as never);
  app.use(router as never);
  app.mount(host);
  await router.isReady();
  return {
    host,
    push: async (to: string) => {
      await router.push(to);
      await nextTick();
    },
    layout: () => host.querySelector('.layout') as Element,
    done: () => {
      app.unmount();
      host.remove();
      router.destroy();
    },
  };
}

/**
 * Navigate FIRST, mount second, and report what the guard threw.
 *
 * Two harness decisions, both forced by measurement rather than taste.
 *
 * `app.config.errorHandler`, not a try/catch around `mount()`. The guard
 * throws inside the branch getter, which Vue runs through
 * `callWithErrorHandling`; with no handler installed, Vue RETHROWS in a dev
 * build and only `console.error`s in a production one, so catching off
 * `mount()` observes the guard in dev and silently observes nothing in prod -
 * the dev-correct/prod-broken shape this whole file exists to rule out. An
 * installed handler is build-independent: Vue routes the error to it and
 * returns in both. The try/catch stays as a belt-and-braces fallback.
 *
 * Navigate before mounting, because reaching the route on an already-mounted
 * app would put the throw inside a scheduler flush, where it belongs to
 * neither the caller nor the handler deterministically.
 */
async function guardAtMount(path: string, components: Record<string, unknown>) {
  const router = makeRouter(components);
  await router.isReady();
  await router.push(path);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = createVaporApp(withOutlet('root') as never) as unknown as {
    config: { errorHandler?: (error: unknown) => void };
    use: (plugin: unknown) => unknown;
    mount: (el: Element) => unknown;
    unmount: () => void;
  };
  let caught: unknown = null;
  app.config.errorHandler = (error: unknown) => {
    caught = error;
  };
  app.use(router);
  try {
    app.mount(host);
  } catch (error) {
    caught ??= error;
  }
  try {
    app.unmount();
  } catch {
    /* a failed mount may leave nothing to unmount */
  }
  host.remove();
  router.destroy();
  const error = caught as { name?: string; code?: unknown } | null;
  return { name: error?.name ?? null, code: error?.code };
}

export async function runOutletObservations(): Promise<OutletObservations> {
  const build: 'dev' | 'prod' = process.env.NODE_ENV === 'production' ? 'prod' : 'dev';

  // (a) two nested outlets resolve their depth through provide/inject. A failed
  //     depth read renders the layout again at depth 1, so the occurrence
  //     counts - not the visible text - are what discriminate.
  const app1 = await scenario({ Layout: withOutlet('layout'), User: leaf('<span>user</span>') });
  await app1.push('/app/user/7');
  const html1 = app1.host.innerHTML;
  const depth = {
    text: app1.host.textContent ?? '',
    layoutOccurrences: html1.split('class="layout"').length - 1,
    userOccurrences: html1.split('<span>user</span>').length - 1,
  };
  app1.done();

  // (b) a depth with no entry and NO default slot renders a true empty branch.
  const app2 = await scenario({ Layout: withOutlet('layout') });
  await app2.push('/app');
  const nullBranch = {
    elementCount: app2.layout().children.length,
    text: app2.layout().textContent ?? '',
    residual: [...app2.layout().childNodes].map(describeNode),
  };
  app2.done();

  // (c) the same depth WITH a default slot renders the fallback.
  const app3 = await scenario({
    Layout: withOutlet('layout', {
      default: () => (template('<em>no child route</em>', 1) as () => Element)(),
    }),
  });
  await app3.push('/app');
  const fallback = { text: app3.layout().textContent ?? '', elementCount: app3.layout().children.length };
  app3.done();

  // (d) the reuse contract. Vapor runs setup once per instance, so `setups`
  //     incrementing IS a remount.
  let setups = 0;
  const User = defineVaporComponent({
    setup() {
      setups++;
      return (template('<span class="user">user</span>', 1) as () => Element)();
    },
  });
  const app4 = await scenario({ Layout: withOutlet('layout'), User, About: leaf('<span>about</span>') });

  await app4.push('/app/user/1');
  const setupsAfterFirstUser = setups;
  const firstEl = app4.host.querySelector('.user');

  await app4.push('/app/user/2');
  const setupsAfterParamSwap = setups;
  const sameElementAcrossParamSwap = firstEl !== null && firstEl === app4.host.querySelector('.user');

  await app4.push('/app/user/2?tab=profile');
  const setupsAfterQuerySwap = setups;

  await app4.push('/app/about');
  const textAfterRecordSwap = app4.layout().textContent ?? '';

  await app4.push('/app/user/3');
  const setupsAfterReturningToUser = setups;

  // Two DIFFERENT records resolving to the SAME component: reuse keys on
  // resolved-component identity, so this crossing must not remount either.
  const beforeTwin = app4.host.querySelector('.user');
  await app4.push('/app/twin');
  const reuse = {
    setupsAfterFirstUser,
    setupsAfterParamSwap,
    sameElementAcrossParamSwap,
    setupsAfterQuerySwap,
    textAfterRecordSwap,
    setupsAfterReturningToUser,
    setupsAcrossTwinRecords: setups,
    sameElementAcrossTwinRecords: beforeTwin !== null && beforeTwin === app4.host.querySelector('.user'),
  };
  app4.done();

  // (e) attrs placed ON the outlet. No contract was ever documented for this;
  //     the observation is recorded so the test can pin whatever it is.
  const app5 = await scenario({
    Layout: withOutlet('layout', undefined, { class: () => 'marked' }),
    User: leaf('<span>user</span>'),
  });
  await app5.push('/app/user/7');
  const layoutEl = app5.layout();
  const attrs = {
    layoutHtml: layoutEl.innerHTML,
    markedTag: (app5.host.querySelector('.marked') as Element | null)?.tagName ?? null,
    outletChildTag: (layoutEl.firstElementChild as Element | null)?.tagName ?? null,
  };
  app5.done();

  // (f) the mode guard, both causes.
  const guard = {
    vdom: await guardAtMount('/vdom', {
      VdomPage: defineComponent({ name: 'VdomPage', setup: () => () => h('span', 'vdom') }),
    }),
    blade: await guardAtMount('/blade', {}),
  };

  return { build, depth, nullBranch, fallback, reuse, attrs, guard };
}
