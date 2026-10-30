// @vitest-environment happy-dom
/**
 * form.aria() and form.firstInvalid() rendered in the vdom and vapor renderers.
 * Why: aria-describedby is an ID list; if the error id replaced an input's own hint, or the render did not follow the error, assistive tech would miss one of them.
 * Shows: a spread input names its hint, then hint plus error id with aria-invalid; the render clears when the field changes; an effect reading firstInvalid() re-runs when an error shows.
 * See: log 36.F42, WAI-ARIA 1.2 aria-describedby.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { configureVue } from '../src/chamber';
import { createFormBus } from '../src/form';
import { type VaporApi, compileVapor, compileVdom } from './compile-vapor';

const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';
const TAKEN = [{ pointer: '/payload/email', detail: 'taken' }];
let v: VaporApi;
beforeAll(async () => { v = await import(/* @vite-ignore */ WITH_VAPOR); configureVue(v); });

async function render(kind: 'vdom' | 'vapor', template: string) {
  const form = createFormBus({ fields: { email: '', name: '' } });
  const compiled = kind === 'vdom' ? await compileVdom(v, template) : await compileVapor(v, template);
  const host = document.createElement('div');
  document.body.append(host);
  const app = kind === 'vdom'
    ? v.createApp({ render: () => compiled.render({ form }, []) })
    : v.createVaporApp(v.defineVaporComponent({ setup: () => compiled.render({ form }) }));
  app.mount(host);
  const input = host.querySelector('input')!;
  const read = () => ({ describedby: input.getAttribute('aria-describedby'), invalid: input.getAttribute('aria-invalid') });
  const done = () => { app.unmount(); host.remove(); };
  return { form, read, done, err: form.errorId('email') };
}

for (const kind of ['vdom', 'vapor'] as const) {
  describe(`form.aria() rendered, ${kind}`, () => {
    it("names the input's own hint while valid, then the hint and the error", async () => {
      const t = await render(kind, `<input v-bind="form.aria('email', 'email-hint')">`);
      expect(t.read()).toEqual({ describedby: 'email-hint', invalid: null });
      t.form.setErrors(TAKEN);
      await v.nextTick();
      expect(t.read()).toEqual({ describedby: `email-hint ${t.err}`, invalid: 'true' });
      t.done();
    });

    it('follows the error: shown after mount, gone once the field changes', async () => {
      const t = await render(kind, `<input v-bind="form.aria('email')">`);
      expect(t.read()).toEqual({ describedby: null, invalid: null });
      t.form.setErrors(TAKEN);
      await v.nextTick();
      expect(t.read()).toEqual({ describedby: t.err, invalid: 'true' });
      t.form.set('email', 'ana@example.com');
      await v.nextTick();
      expect(t.read()).toEqual({ describedby: null, invalid: null });
      t.done();
    });

    it('control: a static hint alone renders', async () => {
      const t = await render(kind, `<input aria-describedby="email-hint">`);
      expect(t.read().describedby).toBe('email-hint');
      t.done();
    });
  });
}

it('firstInvalid() is read by an effect that re-runs when an error shows', async () => {
  const form = createFormBus({ fields: { email: '', name: '' } });
  const seen: unknown[] = [];
  const stop = v.watchEffect(() => { seen.push(form.firstInvalid()); });
  form.setErrors(TAKEN);
  await v.nextTick();
  expect(seen).toEqual([undefined, 'email']);
  stop();
});

it('control: an effect reading form.errors.value re-runs (the harness sees the form)', async () => {
  const form = createFormBus({ fields: { email: '', name: '' } });
  let runs = 0;
  const stop = v.watchEffect(() => { runs++; void form.errors.value; });
  form.setErrors(TAKEN);
  await v.nextTick();
  expect(runs).toBe(2);
  stop();
});
