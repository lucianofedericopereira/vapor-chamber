// @vitest-environment happy-dom
// v-vc-command's own timeout is a give-up, not a failure: the late result decides the rollback. Notes at the end.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type VaporApi, compileVapor, compileVdom } from './compile-vapor';
import { resetCommandBus, setCommandBus } from '../src/chamber';
import { type CommandResult, createAsyncCommandBus } from '../src/command-bus';
import { createDirectivePlugin, vcCommandVapor, vcOptimisticVapor, vcPayloadVapor } from '../src/directives';

const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';
const vapor = async (): Promise<VaporApi> => (await import(/* @vite-ignore */ WITH_VAPOR)) as unknown as VaporApi;

// A 50 ms give-up; each wait below is three times that, on fake timers.
const TEMPLATE = `<button v-vc-command.50="'cartAdd'" v-vc-optimistic="fn">go</button>`;
const sleep = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const settle = () => sleep(0);

type Mounted = { button: HTMLButtonElement; unmount: () => void };

/** The template compiled by the installed Vue and mounted on one renderer, all three directives registered. */
async function mountOn(renderer: 'vapor' | 'vdom', fn: () => () => void): Promise<Mounted> {
  const v = await vapor();
  const host = document.createElement('div');
  document.body.appendChild(host);
  let app;
  if (renderer === 'vapor') {
    const { render } = await compileVapor(v, TEMPLATE);
    app = v.createVaporApp(v.defineVaporComponent({ setup: () => render({ fn }) }));
    app.directive('vc-command', vcCommandVapor);
    app.directive('vc-payload', vcPayloadVapor);
    app.directive('vc-optimistic', vcOptimisticVapor);
  } else {
    const { render } = await compileVdom(v, TEMPLATE);
    app = v.createApp({ render, data: () => ({ fn }) }).use(createDirectivePlugin());
  }
  app.mount(host);
  return {
    button: host.querySelector('button') as HTMLButtonElement,
    unmount: () => {
      app.unmount();
      host.remove();
    },
  };
}

/** An async bus whose `cartAdd` answers when the test says: `ok()` or `fail()`. */
function gatedBus() {
  let ok!: () => void;
  let fail!: () => void;
  const bus = createAsyncCommandBus();
  bus.register('cartAdd', () => new Promise((resolve, reject) => {
    ok = () => resolve('saved');
    fail = () => reject(new Error('out of stock'));
  }));
  setCommandBus(bus);
  return { ok: () => ok(), fail: () => fail() };
}

const look = (b: HTMLButtonElement) => ({
  loading: b.classList.contains('vc-loading'),
  error: b.classList.contains('vc-error'),
  aria: b.getAttribute('aria-disabled'),
});

beforeAll(async () => {
  await vapor();
});

describe.each(['vapor', 'vdom'] as const)('v-vc-command on %s: a slow dispatch and its optimistic update', (renderer) => {
  const log: string[] = [];
  const fn = () => {
    log.push('apply');
    return () => log.push('rollback');
  };

  beforeEach(() => {
    resetCommandBus();
    log.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout, then a late success: the optimistic state is kept', async () => {
    const gate = gatedBus();
    const m = await mountOn(renderer, fn);
    m.button.click();
    await sleep(150);
    // The give-up is reported and the button released, as before.
    expect([log, look(m.button)]).toEqual([['apply'], { loading: false, error: true, aria: null }]);
    gate.ok();
    await settle();
    expect(log).toEqual(['apply']);
    m.unmount();
  });

  it('timeout, then a late failure: rolled back once, when it fails', async () => {
    const gate = gatedBus();
    const m = await mountOn(renderer, fn);
    m.button.click();
    await sleep(150);
    expect(log).toEqual(['apply']);
    gate.fail();
    await settle();
    await settle();
    expect(log).toEqual(['apply', 'rollback']);
    m.unmount();
  });

  it('timeout, unmount, then a late failure: rolled back, the element untouched', async () => {
    const gate = gatedBus();
    const m = await mountOn(renderer, fn);
    m.button.click();
    await sleep(150);
    expect(log).toEqual(['apply']);
    m.unmount();
    const before = [m.button.className, look(m.button)];
    gate.fail();
    await settle();
    await settle();
    expect([log, [m.button.className, look(m.button)]]).toEqual([['apply', 'rollback'], before]);
  });

  it('timeout, then the dispatch itself rejects late: rolled back once', async () => {
    let reject!: (e: Error) => void;
    const late = new Promise<CommandResult>((_, r) => { reject = r; });
    setCommandBus(Object.assign(createAsyncCommandBus(), { dispatch: () => late }));
    const m = await mountOn(renderer, fn);
    m.button.click();
    await sleep(150);
    expect(log).toEqual(['apply']);
    reject(new Error('bus gone'));
    await settle();
    expect(log).toEqual(['apply', 'rollback']);
    m.unmount();
  });

  it('control: a failure within the timeout rolls back', async () => {
    const gate = gatedBus();
    const m = await mountOn(renderer, fn);
    m.button.click();
    await settle();
    gate.fail();
    await settle();
    await settle();
    expect([log, look(m.button)]).toEqual([['apply', 'rollback'], { loading: false, error: true, aria: null }]);
    m.unmount();
  });

  it('control: a success within the timeout keeps', async () => {
    const gate = gatedBus();
    const m = await mountOn(renderer, fn);
    m.button.click();
    await settle();
    gate.ok();
    await settle();
    await settle();
    expect([log, look(m.button)]).toEqual([['apply'], { loading: false, error: false, aria: null }]);
    await sleep(150);
    expect(log).toEqual(['apply']);
    m.unmount();
  });
});

/*
 * Log 36.16 item 3 (F5's lead in the complexity review). The directive's
 * documentation: "the rollback runs if the dispatch fails" (vcOptimisticVapor).
 * Its own timeout is the directive giving up (`directive:timeout:dispatch`),
 * not the dispatch failing, and the dispatch may still land: an app whose
 * server applies the command after the timeout saw its optimistic state undone
 * at the give-up. Now the give-up is reported and the button released as
 * before, and the late result decides: a failure (or a rejection) runs the
 * rollback once, a success runs nothing. The late result touches no element,
 * so after an unmount it still runs the rollback, which is the app's own state.
 * The rejection case wraps a real async bus's `dispatch`: the bus itself
 * rejects only at the start of a dispatch (a naming violation), never late.
 *
 * The waits run on fake timers. On real ones, a stall of 60 ms after the click
 * (a loaded machine) left the 50 ms give-up due before the next `setTimeout(0)`,
 * so "a success within the timeout keeps" read `vc-error`.
 */
