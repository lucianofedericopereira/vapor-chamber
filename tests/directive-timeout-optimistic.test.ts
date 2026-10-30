// @vitest-environment happy-dom
/**
 * v-vc-command's own timeout is a give-up, not a failure: the late result decides the rollback.
 * Why: the dispatch may still land after the directive gives up; rolling back at the give-up would undo state the server applied.
 * Shows: on both renderers the give-up reports and releases; a late success keeps, a late failure or rejection rolls back once, even after unmount.
 * See: log 36.16 item 3.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type VaporApi, compileVapor, compileVdom } from './compile-vapor';
import { resetCommandBus, setCommandBus } from '../src/chamber';
import { type CommandResult, createAsyncCommandBus } from '../src/command-bus';
import { createDirectivePlugin, vcCommandVapor, vcOptimisticVapor, vcPayloadVapor } from '../src/directives';

const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';
const vapor = async (): Promise<VaporApi> => (await import(/* @vite-ignore */ WITH_VAPOR)) as unknown as VaporApi;

// A 50 ms give-up, each wait three times that, on fake timers: a stalled real clock could fire it early.
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
    // The give-up is reported and the button released.
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

  // A wrapped dispatch: a real bus rejects only at the start of a dispatch, never late.
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
