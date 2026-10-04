// @vitest-environment happy-dom
/**
 * examples/vue-vapor-component.vue, compiled and mounted (handoff finding 19,
 * log s35.125): it renders, adds, and undoes and redoes through the store.
 * Its package imports are pointed at the source, so the composables, the store
 * and the root share one shared bus, as they do in an app.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compileScript, parse } from '@vue/compiler-sfc';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, nextTick } from 'vue';
import { resetCommandBus } from '../src/chamber';

const root = resolve(import.meta.dirname, '..');
const src = (p: string) => resolve(root, 'src', p);

async function mountExample() {
  const sfc = readFileSync(resolve(root, 'examples/vue-vapor-component.vue'), 'utf8');
  const { descriptor } = parse(sfc, { filename: 'vue-vapor-component.vue' });
  const code = compileScript(descriptor, { id: 'vvc', inlineTemplate: true }).content
    .replace("from 'vapor-chamber/vue'", `from '${src('vue.ts')}'`)
    .replace("from 'vapor-chamber/store'", `from '${src('store.ts')}'`)
    .replace("from 'vapor-chamber'", `from '${src('index.ts')}'`);
  const dir = resolve(root, 'tests/__ref');
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, 'vue-vapor-component.ts');
  writeFileSync(file, code);
  const component = (await import(/* @vite-ignore */ file)).default;
  rmSync(file); // generated code: not left for the linter to read
  const el = document.createElement('div');
  document.body.appendChild(el);
  const app = createApp(component);
  app.mount(el);
  return { el, app };
}

afterEach(() => {
  document.body.innerHTML = '';
  resetCommandBus();
});

const items = (el: HTMLElement) => [...el.querySelectorAll('.todo-list li label')].map((l) => l.textContent?.trim());
const button = (el: HTMLElement, text: string) =>
  [...el.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(text)) as HTMLButtonElement;

describe('examples/vue-vapor-component.vue', () => {
  it('renders, adds, and undoes and redoes through the store', async () => {
    resetCommandBus();
    const { el, app } = await mountExample();
    const input = el.querySelector('#new-todo') as HTMLInputElement;
    for (const text of ['milk', 'bread']) {
      input.value = text;
      input.dispatchEvent(new Event('input'));
      await nextTick();
      (el.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'));
      await nextTick();
    }
    expect(items(el)).toEqual(['milk', 'bread']);
    expect(button(el, 'All').textContent).toContain('(2)');

    button(el, 'Undo').click();
    await nextTick();
    expect(items(el)).toEqual(['milk']);
    button(el, 'Redo').click();
    await nextTick();
    expect(items(el)).toEqual(['milk', 'bread']);
    app.unmount();
  });

  it('an empty todo is refused by the validator, and the message is shown', async () => {
    resetCommandBus();
    const { el, app } = await mountExample();
    (el.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'));
    await nextTick();
    expect(items(el)).toEqual([]);
    expect(el.querySelector('.error')?.textContent).toContain('cannot be empty');
    app.unmount();
  });
});
