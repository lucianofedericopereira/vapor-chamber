# 5. Vue and Vapor components

This chapter wires the bus into components: the app shape, the composables, the directives,
forms and DevTools. Which entry to import from is [chapter 1](./01-getting-started.md#pick-the-entry-your-app-imports-from).
How Vue 3.6's signals and the Vapor renderer fit the bus is the [whitepaper](../whitepaper.md),
section 7.

## Pick the app shape

Vue Vapor compiles templates to direct DOM operations, driven by **signals** instead of a
diffed virtual tree. Vapor Chamber's state is built on the same signals. It works in three
contexts.

### A pure Vapor app (smallest bundle)

```typescript
import { createVaporChamberApp } from 'vapor-chamber/vapor';
import App from './App.vue';

createVaporChamberApp(App).mount('#app');   // no vDOM runtime
```

```vue
<script setup vapor>
import { useCommand } from 'vapor-chamber/vapor';
const { dispatch, pending } = useCommand();
</script>
```

### A mixed vDOM and Vapor tree (gradual migration)

```typescript
import { createApp, vaporInteropPlugin } from 'vue';

createApp(App).use(vaporInteropPlugin).mount('#app');
```

```vue
<script setup vapor>
// the same import in vDOM and Vapor components alike
import { useCommand } from 'vapor-chamber/vue';
const { dispatch, pending } = useCommand();
</script>
```

Vapor and vDOM components nest inside each other. Take `vaporInteropPlugin` from `vue`
directly. This library's `getVaporInteropPlugin()` returns it only once it has been handed over
(`configureVue({ vaporInteropPlugin })`). No entry wires it, because it pulls in the whole vDOM
interop renderer.

### Standard Vue 3, and detecting Vapor

Everything works without Vapor. `signal()` is wired to Vue's `shallowRef()`, at build time when
the composables come from `vapor-chamber/vue`. In Vue 3.6+ that is backed by alien-signals.

```typescript
import { isVaporAvailable } from 'vapor-chamber';
if (isVaporAvailable()) { /* Vue 3.6+ with createVaporApp available */ }
```

In a bundler, a bare `import 'vue'` carries Vapor: `vue.runtime.esm-bundler.js` re-exports
`@vue/runtime-vapor`, so no alias is needed.[^bundler-vapor] On a no-build page, Vapor ships
only as `vue/dist/vue.runtime-with-vapor.esm-browser*.js`: load that file and hand it over with
`configureVue(Vue)`. Never mix two Vue dists in one page. They are two disconnected reactivity
instances, and the failure is silent.

[^bundler-vapor]: Pinned by `tests/vue-bundler-vapor-exports.test.ts`.

## Use the composables

| Composable | Use when |
|---|---|
| `useCommand()` | Dispatch, a key's busy state (`pending`), handlers and listeners scoped to the component |
| `useCommandQuery()` | A read: `query(action, target)` with reactive `data` and `loading`. A query's failure is its result |
| `defineVaporCommand()` | A hot path, with zero reactive overhead |
| `useCommandHistory()` | Reactive undo/redo |
| `useCommandGroup()` | Namespace isolation across feature modules |
| `useCommandError()` | A component-scoped error boundary |
| `useSharedCommandState()` | The bus's command state in a component: `pending(action, target?)` per key, `anyPending`, `errors` |
| `createFormBus()` | Forms, with per-field validation and dirty tracking |

`useCommand` gates on `hasInjectionContext()`, not `getCurrentInstance()`, so it is Vapor-safe.
The same API works in `<script setup vapor>` and vDOM components alike, with automatic cleanup
on scope disposal.

## Show a busy button and its failure

A button reads its own key's busy state, and the dispatch's own result carries its failure:

```vue
<script setup vapor>
import { ref } from 'vue';
import { useCommand } from 'vapor-chamber/vapor';
const { dispatch, pending } = useCommand();
const saving = pending('save', doc);      // this key, bus-wide
const failure = ref(null);                 // the dispatch's own result
async function save() {
  const r = await dispatch('save', doc);
  failure.value = r.ok ? null : r.error;
}
</script>

<template>
  <!-- aria-disabled, not :disabled: a disabled button loses keyboard focus -->
  <button @click="!saving && save()" :aria-disabled="saving">Save</button>
  <p role="alert">{{ failure?.message }}</p>
</template>
```

### The full `useCommand` surface

```vue
<script setup vapor>
const { dispatch, pending, register, on, emit, dispose } = useCommand();

register('cartAdd', (cmd) => addToCart(cmd.target));   // scoped to this component
on('cart*', (cmd, result) => console.log('Cart event:', cmd.action));
dispatch('cartAdd', product, { quantity: 1 });
emit('cartChanged', { count: 1 });
// auto-cleanup through onScopeDispose - or call dispose() manually
</script>
```

## Dispatch from inside an effect

A dispatch is an *action*, not a read, so nothing the handler touches should make the caller
re-run. Every composable here suspends reactive tracking around its bus call. When you call a
**raw bus** inside an effect, wrap it:

```ts
import { getCommandBus, untracked } from 'vapor-chamber/vue';

watchEffect(() => {
  // without untracked(), anything the HANDLER reads becomes a dependency of
  // this effect - it would re-run on state it never mentions
  untracked(() => getCommandBus().dispatch('cartSync', cart));
});
```

On a page with no build step (a `<script>` tag or an import map), `untracked()` cannot suspend
tracking: Vue's browser builds do not export what it needs. See
[whitepaper 9.6](../whitepaper.md#96-blade--cdn-zero-build).

## Fire-and-forget, history, groups and errors

`defineVaporCommand` registers its handler and dispatches with no state at all, for telemetry,
scroll sampling, debounced search and autosave:

```vue
<script setup vapor>
const { dispatch } = defineVaporCommand('telemetryEvent', (cmd) => {
  sendMetric(cmd.target.event, cmd.target.params);
});
dispatch({ event: 'page_view', params: { page: '/shop' } });
</script>
```

```typescript
// state reduced by commands is a store: defineChamberStore (vapor-chamber/store)

// reactive undo/redo
const { canUndo, canRedo, undo, redo } = useCommandHistory({
  actions: ['editor*'],
});

// namespace isolation - all calls prefixed in camelCase
const cart = useCommandGroup('cart');
cart.register('add', handler);   // registers 'cartAdd'
cart.dispatch('add', product);   // dispatches 'cartAdd'
cart.on('*', listener);          // listens to 'cart*'

// component-scoped error boundary
const { errors, latestError, clearErrors } = useCommandError({
  actions: ['cart*'],
});
```

## Bind a control with a directive

`v-vc-command` turns any element into a control that dispatches, with its busy and failure
states handled:

```ts
import { createDirectivePlugin } from 'vapor-chamber/directives'
app.use(createDirectivePlugin())
```

```html
<button v-vc-command="'cartAdd'"
        v-vc-payload="{ id: product.id, qty: 1 }">
  Add to cart
</button>
```

- While the dispatch is in flight the directive adds `vc-loading`, and on a button
  `aria-disabled`, never `disabled`.
- A press while in flight, or on a disabled or `aria-disabled` element, dispatches nothing.
- On failure it adds `vc-error` and announces the message through the shared live region,
  leaving focus where it is.
- Modifiers: `.stop`, `.prevent`, `.self`, `.left`, `.middle`, `.right`, `.capture`,
  `.once`, `.passive`, `.<number>` (dispatch timeout in ms) and `.delegate` (one shared
  listener for a `v-for` list).

**In a Vapor component**, import `vcCommandVapor`, `vcPayloadVapor` and `vcOptimisticVapor`,
aliased as `vVcCommand`, `vVcPayload` and `vVcOptimistic`. A shorter alias compiles and mounts
nothing:

```vue
<script setup vapor>
import { vcCommandVapor as vVcCommand, vcPayloadVapor as vVcPayload } from 'vapor-chamber/directives'
</script>
<template>
  <button v-vc-command.stop="'cartAdd'" v-vc-payload="{ id: 1 }">Add</button>
</template>
```

App-wide on Vapor: `createVaporChamberApp(App).directive('vc-command', vcCommandVapor)`.

Do not put `:class` or `:aria-disabled` on the same element as `v-vc-command`, unless that
element is a component root: the binding's next update overwrites what the directive wrote. The
full rules, and the Vapor directive's shape, are in the [whitepaper](../whitepaper.md), section
7.7. On plain HTML, `bindCommands` gives the same interaction ([chapter 8](./08-pages-without-a-build.md)).

**A Vapor directive of your own** receives its argument as a getter, `() => Arg`, not as the
string (Vue 3.6.0-rc.9 on). Call it: `argument?.()`. A test that writes the
`withVaporDirectives` tuple by hand passes the string and hides the mistake, so compile the
template on the installed Vue instead.

## Drive a `<Transition>` from the bus

`useTransitionCommand({ namespace })` returns the eight enter and leave hooks, each dispatching a
command such as `drawerEnter`. Bind them with `<Transition v-bind="hooks">`. On Vapor,
`VcTransition` from `vapor-chamber/transitions/vapor` is a bus-driven transition, and
[accessibility.md](../accessibility.md) shows it as a placeholder that waits.

On a vDOM app, `<Transition mode="out-in">` with these hooks needs an async bus. On a sync bus
the hooks call `done()` at once, and Vue's vDOM `out-in` then throws and renders nothing. The
defect is Vue's (vuejs/core#15727). Vapor's `<Transition>` and the default mode are not affected.

## Build a form

Per-field validation, dirty tracking, and every plugin's rules and steps on every form command.

```typescript
const form = createFormBus({
  fields: { email: '', password: '' },
  rules: {
    email:    (v) => v.includes('@') ? null : 'Invalid email',   // sync - runs on every set()
    password: (v) => v.length >= 8   ? null : 'Too short',
    username: async (v) => await api.isUsernameTaken(v) ? 'Taken' : null,  // async - only on submit()
  },
  onSubmit: async (values) => await api.login(values),
});

form.use(logger());   // plugins attach like any bus

form.values.value; form.errors.value; form.isDirty.value; form.isValid.value; form.isSubmitting.value;
// read-only: set(), touch(), reset() and setErrors() write them, one write per command

form.set('email', 'user@example.com');   // update + re-validate
form.touch('email');
await form.submit();                     // validate -> onSubmit -> boolean
form.reset();
```

**Headless mode:** `reactive: false` skips signal allocation for server-side, batch or non-UI
use. Every API works the same.

**Two forms on one bus** each pass an `id`, the prefix of their action names (`'form'` by
default). A second form whose id is already on the bus throws. `form.dispose()` unregisters its
handlers and frees the id. `submit()` returns `false` while a submit is in flight, so a
double-click submits once.

```vue
<input :value="form.values.value.email"
       @input="form.set('email', $event.target.value)"
       @blur="form.touch('email')" />
<span v-if="form.touched.value.email && form.errors.value.email">
  {{ form.errors.value.email }}
</span>
<button :aria-disabled="!form.isValid.value || form.isSubmitting.value"
        @click="form.isValid.value && !form.isSubmitting.value && form.submit()">
  Submit
</button>
```

## Inspect the bus in Vue DevTools

It needs `@vue/devtools-api`. Without it, it does nothing and says nothing.

```typescript
import { setupDevtools } from 'vapor-chamber/devtools';

const app = createApp(App);
setupDevtools(getCommandBus(), app);
app.mount('#app');
```

An emitted fact runs no hooks, so it is not on the Commands layer. Name the facts to show on a
Facts layer: `setupDevtools(bus, app, { facts: ['router*'] })`.

Next: [6. Routing](./06-router.md).
