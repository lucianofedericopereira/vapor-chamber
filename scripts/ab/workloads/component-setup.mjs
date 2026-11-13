// Workload for scripts/ab/ab.mjs (log 36.F58, the #16108 fix): a component's
// setup as the examples write it, created and disposed in an effectScope the
// way Vue stops a component's scope. Each row is one example's composables,
// through vapor-chamber/vapor:
//   cart_panel     examples/apps/vapor-sfc/src/CartPanel.vue: useCommand(), pending x2, on()
//   search_panel   examples/apps/vapor-sfc/src/SearchPanel.vue: useCommand({ debounce }), pending()
//   status_bar     examples/apps/vapor-sfc/src/StatusBar.vue: useSharedCommandState({ maxSize })
//   todo_component examples/snippets/vue-vapor-component.vue: useCommand, useCommandHistory, useCommandError
// raw_dispatch is the control: a bus dispatch, a path the fix does not run.
import { effectScope } from 'vue';
import {
  createCommandBus,
  setCommandBus,
  useCommand,
  useCommandError,
  useCommandHistory,
  useSharedCommandState,
} from '__DIST__/vapor.js';

const bus = createCommandBus();
setCommandBus(bus);
bus.register('cartAdd', (cmd) => cmd.target.id);
bus.register('inc', (cmd) => cmd.payload + 1);

let heard = 0;
const onCart = () => { heard++; };

function cartPanel() {
  const sc = effectScope();
  const r = sc.run(() => {
    const { pending, on } = useCommand();
    const one = pending('cartAdd', { id: 1 });
    const invalid = pending('cartAdd', { id: -1 });
    on('cartAdd', onCart);
    return (one.value ? 1 : 0) + (invalid.value ? 1 : 0) + 1;
  });
  sc.stop();
  return r;
}

function searchPanel() {
  const sc = effectScope();
  const r = sc.run(() => {
    const { pending } = useCommand({ debounce: 250 });
    return pending('productSearch').value ? 2 : 1;
  });
  sc.stop();
  return r;
}

function statusBar() {
  const sc = effectScope();
  const r = sc.run(() => useSharedCommandState({ maxSize: 5 }).errors.value.length + 1);
  sc.stop();
  return r;
}

function todoComponent() {
  const sc = effectScope();
  const r = sc.run(() => {
    const cmd = useCommand();
    const hist = useCommandHistory({ actions: ['todo*'] });
    const errs = useCommandError({ actions: ['todoAdd'] });
    return (typeof cmd.dispatch === 'function' ? 1 : 0) + (hist.canUndo.value ? 1 : 0) + errs.errors.value.length;
  });
  sc.stop();
  return r;
}

// Self-check: the cart panel's listener hears while its scope runs and is gone once the scope stops.
{
  const sc = effectScope();
  sc.run(() => useCommand().on('cartAdd', onCart));
  bus.dispatch('cartAdd', { id: 1 });
  if (heard !== 1) throw new Error(`component-setup: the listener heard ${heard} dispatches, expected 1`);
  sc.stop();
  bus.dispatch('cartAdd', { id: 1 });
  if (heard !== 1) throw new Error('component-setup: the listener outlived its scope');
  heard = 0;
}

export const N = { cart_panel: 30_000, search_panel: 30_000, status_bar: 30_000, todo_component: 20_000, raw_dispatch: 200_000 };
export function cart_panel(n) { let s = 0; for (let i = 0; i < n; i++) s += cartPanel(); return s; }
export function search_panel(n) { let s = 0; for (let i = 0; i < n; i++) s += searchPanel(); return s; }
export function status_bar(n) { let s = 0; for (let i = 0; i < n; i++) s += statusBar(); return s; }
export function todo_component(n) { let s = 0; for (let i = 0; i < n; i++) s += todoComponent(); return s; }
export function raw_dispatch(n) { let s = 0; for (let i = 0; i < n; i++) s += bus.dispatch('inc', null, i).value; return s; }
export const check = () => [cart_panel(10), search_panel(10), status_bar(10), todo_component(10), raw_dispatch(10), heard];
