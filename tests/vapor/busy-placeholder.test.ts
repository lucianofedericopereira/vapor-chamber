/**
 * The Vapor busy placeholder: `VcTransition` with `:show` on a command's `pending`, a delay in the app's Enter handler, and the content gone when Leave answers.
 * Why: the library has no busy indicator of its own, so the pattern in the docs would break for an app if a fast command flashed the placeholder or a slow one left it up after the data landed. A command that answers first turns `show` false while Enter waits, and `<ns>EnterCancelled` must clear the delay.
 * Shows: with a fast command the placeholder is inserted hidden, never becomes visible and is gone after Leave; with a slow one it becomes visible after the delay and stays until Leave answers.
 * See: log s36.94, docs/accessibility.md
 */
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

/** The app's bus with one slow command, a bus of the indicator's own, and the placeholder mounted. `VcTransition` inserts the content when `show` turns true and dispatches `<ns>Enter` after that flush, so the placeholder starts hidden and the Enter handler shows it after its delay. */
async function page() {
  const app = createAsyncCommandBus();
  let answer!: () => void;
  app.register('cartSave', () => new Promise<void>((r) => { answer = r; }));
  const saving = commandState(app).pending('cartSave');

  // Own bus: on the app's bus these commands would count in its `anyPending` and `errors`.
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
