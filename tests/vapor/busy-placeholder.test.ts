// The Vapor busy pattern: VcTransition's :show on `pending`, a delay in the Enter handler, gone when Leave answers; rationale at the end.
import * as vue from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../src/vapor';
import { createAsyncCommandBus } from '../../src/command-bus';
import { commandState } from '../../src/command-state';
import { VcTransition } from '../../src/transitions/vapor';
import { compileVapor } from '../compile-vapor';

const v = vue as any;
const TEMPLATE = '<div class="host"><VcTransition :show="s.saving.value" namespace="busy" :bus="s.ui"><span class="busy" style="visibility: hidden">saving</span></VcTransition></div>';

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

/** The app's bus with one slow command, a bus of the indicator's own, and the placeholder mounted. */
async function page() {
  const app = createAsyncCommandBus();
  let answer!: () => void;
  app.register('cartSave', () => new Promise<void>((r) => { answer = r; }));
  const saving = commandState(app).pending('cartSave');

  // The indicator's commands on their own bus, so they never count in the app's anyPending.
  const ui = createAsyncCommandBus();
  let delay: ReturnType<typeof setTimeout> | undefined;
  ui.register('busyEnter', (cmd) => new Promise<void>((done) => {
    delay = setTimeout(() => { (cmd.target as HTMLElement).style.visibility = 'visible'; done(); }, 120);
  }));
  ui.register('busyEnterCancelled', async () => { clearTimeout(delay); });
  ui.register('busyLeave', () => new Promise<void>((done) => setTimeout(done, 50)));

  const { render } = await compileVapor(v, TEMPLATE);
  const host = document.createElement('div');
  document.body.append(host);
  const vapp = v.createVaporApp(v.defineVaporComponent({ setup: () => render({ s: { saving, ui } }) }));
  vapp.component('VcTransition', VcTransition);
  vapp.mount(host);
  const busy = () => host.querySelector('.busy') as HTMLElement | null;
  return { app, busy, answer: () => answer(), shown: () => busy()?.style.visibility === 'visible' };
}

describe('the busy placeholder on Vapor', () => {
  it('a fast command never shows it', async () => {
    const p = await page();
    vi.useFakeTimers();
    const done = p.app.dispatch('cartSave', undefined);
    await vi.advanceTimersByTimeAsync(30);
    const during = { present: p.busy() !== null, shown: p.shown() };
    p.answer();
    await done;
    await vi.advanceTimersByTimeAsync(200);
    expect({ during, everShown: p.shown(), gone: p.busy() === null })
      .toEqual({ during: { present: true, shown: false }, everShown: false, gone: true });
  });

  it('a slow command shows it after the delay, and it stays until Leave answers', async () => {
    const p = await page();
    vi.useFakeTimers();
    const done = p.app.dispatch('cartSave', undefined);
    await vi.advanceTimersByTimeAsync(200);
    const shown = p.shown();
    p.answer();
    await done;
    await vi.advanceTimersByTimeAsync(10);
    const leaving = p.busy() !== null;
    await vi.advanceTimersByTimeAsync(60);
    expect({ shown, leaving, gone: p.busy() === null }).toEqual({ shown: true, leaving: true, gone: true });
  });
});

// The owner's pattern (2026-10-20), documented beside the display bindings and in
// docs/accessibility.md: nothing in the library for it. `VcTransition` inserts the content
// as soon as `show` turns true and dispatches `<ns>Enter` after that flush, so the
// placeholder starts hidden in its own style and the app's Enter handler shows it after
// its delay. A command that answers first turns `show` false while Enter waits:
// `<ns>EnterCancelled` clears the delay and the leave commands run, so nothing was shown.
// On an async bus the content leaves only when `<ns>Leave` answers (busy until the data
// lands). The indicator's commands go on a bus of their own: on the app's bus they would
// count in its `anyPending` and `errors`.
