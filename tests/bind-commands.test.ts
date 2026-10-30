// @vitest-environment happy-dom
/**
 * `bindCommands(root, { bus })`: the directive's interaction on plain HTML, from `[data-vc-command]` attributes.
 * Why: the interaction (busy, error, announce, keyboard, in-flight guard) is DOM code with no Vue, so plain HTML gets it too, on the bus passed in, never the shared one.
 * Shows: presses dispatch with target and payload, busy and error states, the action read at press time; debounce, throttle and IME pace a control; a refused press is silent.
 * See: plan 1.32 4.5, plan 1.32 step 6a.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindCommands } from '../src/command-binding';
import { createAsyncCommandBus, createCommandBus, type Command } from '../src/command-bus';
import { getCommandBus, resetCommandBus } from '../src/chamber';

const settle = () => new Promise((r) => setTimeout(r, 0));

function page(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

function deferred<T = unknown>() {
  let resolve!: (x: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

afterEach(() => {
  document.body.innerHTML = '';
  resetCommandBus();
  vi.useRealTimers();
});

describe('bindCommands: presses', () => {
  it('dispatches each [data-vc-command] on the bus it was given, with target and payload', async () => {
    const bus = createAsyncCommandBus();
    const seen: Command[] = [];
    bus.register('cartAdd', async (cmd) => { seen.push(cmd); return 'added'; });
    const shared = vi.fn();
    getCommandBus().register('cartAdd', shared);
    const root = page(`<button data-vc-command="cartAdd" data-vc-target='{"id":1}' data-vc-payload='{"qty":2}'>Add</button>`);
    bindCommands(root, { bus });
    root.querySelector('button')!.click();
    await settle();
    expect({ target: seen[0]?.target, payload: seen[0]?.payload, shared: shared.mock.calls.length })
      .toEqual({ target: { id: 1 }, payload: { qty: 2 }, shared: 0 });
  });

  it('marks the button busy while in flight and ignores a second press', async () => {
    const bus = createAsyncCommandBus();
    const gate = deferred();
    let runs = 0;
    bus.register('save', () => { runs++; return gate.promise; });
    const root = page('<button data-vc-command="save">Save</button>');
    bindCommands(root, { bus });
    const button = root.querySelector('button')!;
    button.click();
    await settle();
    const during = { loading: button.classList.contains('vc-loading'), aria: button.getAttribute('aria-disabled') };
    button.click();
    gate.resolve('ok');
    await settle();
    await settle();
    expect({ during, runs, after: button.classList.contains('vc-loading'), aria: button.getAttribute('aria-disabled') })
      .toEqual({ during: { loading: true, aria: 'true' }, runs: 1, after: false, aria: null });
  });

  it('a failure sets vc-error', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    bus.register('save', async () => { throw new Error('No room left.'); });
    const root = page('<button data-vc-command="save">Save</button>');
    bindCommands(root, { bus });
    const button = root.querySelector('button')!;
    button.click();
    await settle();
    await settle();
    expect(button.classList.contains('vc-error')).toBe(true);
  });

  it('binds the root itself, reads the action at press time, and unbind detaches', () => {
    const bus = createCommandBus();
    const ran: string[] = [];
    bus.register('first', () => { ran.push('first'); });
    bus.register('second', () => { ran.push('second'); });
    const root = page('');
    const button = document.createElement('button');
    button.setAttribute('data-vc-command', 'first');
    root.append(button);
    const unbind = bindCommands(button, { bus });
    button.click();
    button.setAttribute('data-vc-command', 'second');
    button.click();
    unbind();
    button.click();
    expect(ran).toEqual(['first', 'second']);
  });

  it('control: an element without the attribute is left alone', () => {
    const bus = createCommandBus();
    const handler = vi.fn();
    bus.register('save', handler);
    const root = page('<button>Save</button>');
    bindCommands(root, { bus });
    root.querySelector('button')!.click();
    expect(handler).not.toHaveBeenCalled();
  });
});

// A form control sends on `input`, or `change` for a select, checkbox or radio, as `v-model` chooses.
describe('bindCommands: pacing from attributes', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it('a debounced text input sends once, the last value as the payload, the key steady', async () => {
    const bus = createCommandBus();
    const runs: unknown[] = [];
    bus.register('searchQuery', (cmd) => { runs.push(cmd.payload); return []; });
    const root = page('<input data-vc-command="searchQuery" data-vc-debounce="300">');
    bindCommands(root, { bus });
    const input = root.querySelector('input')!;
    for (const text of ['u', 'us', 'usb']) {
      input.value = text;
      input.dispatchEvent(new Event('input'));
    }
    await vi.advanceTimersByTimeAsync(300);
    expect({ runs, error: input.classList.contains('vc-error') }).toEqual({ runs: ['usb'], error: false });
  });

  it('a throttled button refuses a press inside the wait, silently', async () => {
    const bus = createCommandBus();
    let runs = 0;
    bus.register('mark', () => { runs++; });
    const root = page('<button data-vc-command="mark" data-vc-throttle="1000">Mark</button>');
    bindCommands(root, { bus });
    const button = root.querySelector('button')!;
    button.click();
    await vi.advanceTimersByTimeAsync(10);
    button.click();
    await vi.advanceTimersByTimeAsync(10);
    expect({ runs, error: button.classList.contains('vc-error') }).toEqual({ runs: 1, error: false });
  });

  it('an IME composition sends nothing until it ends, then the composed value once', async () => {
    const bus = createCommandBus();
    const runs: unknown[] = [];
    bus.register('searchQuery', (cmd) => { runs.push(cmd.payload); return []; });
    const root = page('<input data-vc-command="searchQuery" data-vc-debounce="50">');
    bindCommands(root, { bus });
    const input = root.querySelector('input')!;
    input.dispatchEvent(new Event('compositionstart'));
    for (const text of ['k', 'ka', 'kan']) {
      input.value = text;
      input.dispatchEvent(new Event('input'));
    }
    await vi.advanceTimersByTimeAsync(100);
    const during = [...runs];
    input.value = '\u6f22';
    input.dispatchEvent(new Event('compositionend'));
    await vi.advanceTimersByTimeAsync(100);
    expect({ during, runs }).toEqual({ during: [], runs: ['\u6f22'] });
  });

  it('a stale answer of a paced input is aborted, silently', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    bus.register('searchQuery', async (cmd) => {
      await new Promise((r) => setTimeout(r, cmd.payload === 'a' ? 100 : 10));
      if (cmd.signal?.aborted) throw cmd.signal.reason;
      return [];
    });
    const root = page('<input data-vc-command="searchQuery" data-vc-debounce="5">');
    bindCommands(root, { bus });
    const input = root.querySelector('input')!;
    input.value = 'a';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(10);
    input.value = 'ab';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(200);
    expect(input.classList.contains('vc-error')).toBe(false);
  });

  it('a checkbox sends on change, its checked state as the payload', async () => {
    const bus = createCommandBus();
    const runs: unknown[] = [];
    bus.register('notifyToggle', (cmd) => { runs.push(cmd.payload); });
    const root = page('<input type="checkbox" data-vc-command="notifyToggle">');
    bindCommands(root, { bus });
    const box = root.querySelector('input')!;
    box.checked = true;
    box.dispatchEvent(new Event('input'));
    box.dispatchEvent(new Event('change'));
    expect(runs).toEqual([true]);
  });

  it('a refused press never reaches the bus: no listener hears it', async () => {
    const bus = createCommandBus();
    const heard: string[] = [];
    bus.on('*', (cmd) => { heard.push(cmd.action); });
    bus.register('mark', () => 1);
    const root = page('<button data-vc-command="mark" data-vc-throttle="1000">Mark</button>');
    bindCommands(root, { bus });
    root.querySelector('button')!.click();
    await vi.advanceTimersByTimeAsync(10);
    root.querySelector('button')!.click();
    await vi.advanceTimersByTimeAsync(10);
    expect(heard).toEqual(['mark']);
  });
});
