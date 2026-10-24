// `bindCommands` on a real page in Chromium: a press keeps focus, a role="button" answers the keyboard, typed text sends once; rationale at the end.
import { afterEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { createAsyncCommandBus } from 'vapor-chamber';
import { bindCommands } from '../../src/command-binding';

const settle = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function page(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('bindCommands in Chromium', () => {
  it('a click dispatches on the given bus and the button keeps focus', async () => {
    const bus = createAsyncCommandBus();
    const seen: unknown[] = [];
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    bus.register('cartAdd', async (cmd) => { seen.push(cmd.target); await gate; return 'added'; });
    const root = page(`<button data-vc-command="cartAdd" data-vc-target='{"id":7}'>Add</button>`);
    const unbind = bindCommands(root, { bus });
    const button = root.querySelector('button')!;
    await userEvent.click(button);
    const during = { focused: document.activeElement === button, aria: button.getAttribute('aria-disabled') };
    open();
    await settle();
    expect({ seen, during, focused: document.activeElement === button, loading: button.classList.contains('vc-loading') })
      .toEqual({ seen: [{ id: 7 }], during: { focused: true, aria: 'true' }, focused: true, loading: false });
    unbind();
  });

  it('a role="button" gets the keyboard: Enter dispatches', async () => {
    const bus = createAsyncCommandBus();
    let runs = 0;
    bus.register('save', async () => { runs++; });
    const root = page('<div role="button" data-vc-command="save">Save</div>');
    bindCommands(root, { bus });
    const div = root.querySelector('div')!;
    div.focus();
    await userEvent.keyboard('{Enter}');
    await settle();
    expect({ tabindex: div.getAttribute('tabindex'), runs }).toEqual({ tabindex: '0', runs: 1 });
  });

  it('typed text with data-vc-debounce sends once, the last value as the payload', async () => {
    const bus = createAsyncCommandBus();
    const runs: unknown[] = [];
    bus.register('searchQuery', async (cmd) => { runs.push(cmd.payload); return []; });
    const root = page('<input data-vc-command="searchQuery" data-vc-debounce="150">');
    bindCommands(root, { bus });
    await userEvent.type(root.querySelector('input')!, 'usb');
    await wait(300);
    expect(runs).toEqual(['usb']);
  });
});

// The happy-dom file (tests/bind-commands.test.ts) pins the rules. These three need an
// engine: focus stays on a pressed button (aria-disabled, never disabled, so HTML's focus
// fixup does not move it), a role="button" is made focusable and answers Enter, and real
// typing fires one `input` per key, which the debounce collapses to one send of the whole
// text. The bus is the one passed in; nothing sets the shared bus.
