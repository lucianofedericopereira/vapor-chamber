// The busy-display recipe of docs/accessibility.md on `vc-loading`: hidden before the delay, shown after, gone with the class; rationale at the end.
import { afterEach, describe, expect, it } from 'vitest';
import { createAsyncCommandBus } from 'vapor-chamber';
import { bindCommands } from '../../src/command-binding';

const RECIPE = `
.vc-loading .busy { visibility: hidden; animation: vc-busy-after 0s 120ms forwards; }
@keyframes vc-busy-after { to { visibility: visible; } }
.busy { visibility: hidden; }
`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  document.body.innerHTML = '';
  document.head.querySelector('style[data-recipe]')?.remove();
});

describe('the delayed busy display, CSS only', () => {
  it('a slow command shows the spinner after 120 ms; the answer hides it', async () => {
    const style = document.createElement('style');
    style.setAttribute('data-recipe', '');
    style.textContent = RECIPE;
    document.head.append(style);
    const bus = createAsyncCommandBus();
    let open!: () => void;
    bus.register('save', () => new Promise<void>((r) => { open = r; }));
    const root = document.createElement('div');
    root.innerHTML = '<button data-vc-command="save">Save <span class="busy">...</span></button>';
    document.body.append(root);
    bindCommands(root, { bus });
    const button = root.querySelector('button')!;
    const busy = root.querySelector('.busy')!;
    const seen = () => getComputedStyle(busy).visibility;
    button.click();
    await wait(30);
    const early = { loading: button.classList.contains('vc-loading'), seen: seen() };
    await wait(200);
    const late = seen();
    open();
    await wait(30);
    expect({ early, late, after: seen(), loading: button.classList.contains('vc-loading') })
      .toEqual({ early: { loading: true, seen: 'hidden' }, late: 'visible', after: 'hidden', loading: false });
  });
});

// docs/accessibility.md, "A busy display that waits": the owner ruled (2026-10-19) that a
// delay before showing busy is the app's display choice, so the library has no option for
// it. The recipe is CSS on the `vc-loading` class the binding sets from press to answer:
// an animation with a 120 ms delay turns the spinner visible, and removing the class ends
// it. A fast answer removes the class before the delay, so nothing flashes. Measured in
// Chromium because happy-dom runs no CSS animation.
