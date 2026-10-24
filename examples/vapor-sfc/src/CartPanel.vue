<!--
  The cart, three ways to add to it, one source of truth.

  A button reads the key it dispatches, `pending('cartAdd', { id })`, so a
  click marks only that button busy while its command is in flight. The
  confirmed cart is the store the server writes (`cart.state`): the buttons
  differ in how they send, never in where the answer lands. A failure of any
  of them is the last cart result, shown once.
-->
<script setup vapor lang="ts">
import { createAsyncCommandBus, signal, useCommand } from 'vapor-chamber/vapor';
import { VcTransition } from 'vapor-chamber/transitions/vapor';
// THE ALIAS IS THE WHOLE DIRECTIVE NAME, camelCased: `v-vc-command` looks for
// `vVcCommand`, `v-vc-payload` for `vVcPayload`. A shorter alias compiles,
// type-checks, and falls back to a directive nobody registered. Vue warns
// about that in DEV and NOT in the production build, so the control renders
// dead without a word. `npm run check:example` is what catches it.
import {
  vcCommandVapor as vVcCommand,
  vcOptimisticVapor as vVcOptimistic,
  vcPayloadVapor as vVcPayload,
} from 'vapor-chamber/directives';
import { cart } from './shop';

const { dispatch, pending, on } = useCommand();

// One flag per button: the key each dispatches (bus-wide, any caller counts).
const addingOne = pending('cartAdd', { id: 1 });
const addingInvalid = pending('cartAdd', { id: -1 });

// The last cart result, from any button: a success clears the failure.
const failure = signal<Error | null>(null);
on('cartAdd', (_cmd, result) => {
  failure.value = result.ok ? null : (result.error ?? null);
});

// A placeholder that waits: VcTransition on the same key. Its Enter holds a
// 150 ms delay, so a fast answer never shows it, and it leaves when its Leave
// answers, once the data has landed. Its commands use a bus of their own, so
// they never count in the app's anyPending. docs/accessibility.md.
const ui = createAsyncCommandBus();
let delay: ReturnType<typeof setTimeout> | undefined;
ui.register('busyEnter', (c) => new Promise<void>((done) => {
  delay = setTimeout(() => { (c.target as HTMLElement).style.visibility = 'visible'; done(); }, 150);
}));
ui.register('busyEnterCancelled', async () => { clearTimeout(delay); });
ui.register('busyLeave', (c) => (c.target as HTMLElement).animate([{ opacity: 1 }, { opacity: 0 }], 150).finished);

// v-vc-payload carries a live object, which is the reason it exists alongside
// `data-vc-payload`: the attribute is JSON, so a Date arrives as a string and a
// Map as `{}`. The qty follows the input, read at dispatch time.
const qty = signal(3);
const richPayload = () => ({ qty: qty.value, orderedAt: new Date() });

// v-vc-optimistic: the function applies the change at once and returns the
// rollback the directive runs if the command fails. It receives the Command,
// so it bumps by the PAYLOAD the binding carried, which is also what makes
// this example checkable (scripts/check-example-directive.mjs). Ask for more
// than the server has (qty above 10) and the counter goes back.
const optimisticCount = signal(0);
function bumpOptimistically(cmd: { payload?: { qty?: number } }) {
  const n = cmd.payload?.qty ?? 1;
  optimisticCount.value += n;
  return () => {
    optimisticCount.value -= n;
  };
}
</script>

<template>
  <section class="panel">
    <h2>Cart</h2>
    <p>
      Each button reads its own key, so it marks only itself busy while its
      command is in flight.
    </p>
    <div class="row">
      <!-- aria-disabled, not :disabled: disabling the pressed button would
           send keyboard focus to <body>. A press in flight is ignored. -->
      <button type="button" :aria-disabled="addingOne" @click="!addingOne && dispatch('cartAdd', { id: 1 }, { qty: 1 })">
        {{ addingOne ? 'Adding...' : 'Add product #1' }}
      </button>
      <button type="button" :aria-disabled="addingInvalid" @click="!addingInvalid && dispatch('cartAdd', { id: -1 }, { qty: 1 })">
        {{ addingInvalid ? 'Adding...' : 'Add invalid product (errors)' }}
      </button>
    </div>
    <!-- Shown only when adding #1 answers slower than 150 ms (tests/vapor/busy-placeholder.test.ts). -->
    <VcTransition :show="addingOne" namespace="busy" :bus="ui">
      <p class="busy" style="visibility: hidden" aria-hidden="true">Still saving...</p>
    </VcTransition>
    <!--
      The same dispatch from the template alone. The directive reads its
      target and payload from data-vc-* attributes, adds vc-loading / vc-error
      classes while it runs, and marks the button busy for the duration.

      It keeps a compiled v-vc-command in an example, so building the examples
      checks that it mounts in a compiled Vapor template (a change to Vue's
      directive tuple, #15490, once made it inert in every one).
    -->
    <div class="row">
      <button type="button" v-vc-command="'cartAdd'" data-vc-target='{"id":2}' data-vc-payload='{"qty":1}'>
        Add product #2 (v-vc-command)
      </button>
    </div>
    <!--
      v-vc-payload and v-vc-optimistic: a live payload (not JSON in an
      attribute) and an optimistic update with rollback, keeping vc-loading,
      busy-while-in-flight, the re-entrancy guard and the timeout. The order
      of the two directives on the element does not matter.
    -->
    <div class="row">
      <label>qty <input type="number" v-model.number="qty" min="1" max="99" style="width:5rem"></label>
      <button type="button" v-vc-payload="richPayload()" v-vc-command="'cartAdd'" v-vc-optimistic="bumpOptimistically"
              data-vc-target='{"id":3}'>
        Add product #3 (v-vc-payload + v-vc-optimistic)
      </button>
      <span class="count">optimistic: {{ optimisticCount }}</span>
    </div>
    <!-- Live regions: the outcome is heard, not only seen. -->
    <p class="ok" role="status">
      <template v-if="cart.state.value.count > 0">✓ In cart: {{ cart.state.value.count }} item{{ cart.state.value.count > 1 ? 's' : '' }} - total ${{ cart.state.value.total.toFixed(2) }}</template>
    </p>
    <p class="error" role="alert">
      <template v-if="failure">Error: {{ failure.message }}</template>
    </p>
  </section>
</template>
