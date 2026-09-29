<!--
  Per-component reactive loading state via `useCommand`.

  Each button gets its own `loading` / `lastError` signals. Clicking either
  button marks only that button busy (aria-disabled) while the dispatch is in
  flight.
-->
<script setup vapor lang="ts">
// The Vapor entry wires Vue at build time; from the root this would work only
// because main.ts happens to import it too.
import { useCommand, signal } from 'vapor-chamber/vapor';
// v-vc-command, imported as a vVcCommand binding - the idiomatic form.
//
// THE ALIAS IS THE WHOLE DIRECTIVE NAME, camelCased. `v-vc-command` looks for
// `vVcCommand`, `v-vc-payload` for `vVcPayload`. A shorter alias compiles,
// type-checks, and falls back to a directive nobody registered - which Vue
// warns about in DEV and NOT in the production build this example ships, so it
// renders a dead control silently. `npm run check:example` is what catches it.
import {
  vcCommandVapor as vVcCommand,
  vcOptimisticVapor as vVcOptimistic,
  vcPayloadVapor as vVcPayload,
} from 'vapor-chamber/directives';
import { asRef } from './_reactive';

// asRef: vapor-chamber signals are Vue shallowRefs at runtime - typed as such here
// so vue-tsc auto-unwraps them in the template (see _reactive.ts).
const cmd = useCommand();
const { dispatch } = cmd;
const loading = asRef(cmd.loading);
const lastError = asRef(cmd.lastError);

// Success feedback: render the handler's CONFIRMED state - the single source
// of truth.
const cart = asRef(signal<{ count: number; total: number } | null>(null));

async function addToCart(id: number) {
  const result = await dispatch('cartAdd', { id }, { qty: 1 });
  if (result.ok) cart.value = result.value as { count: number; total: number };
}

// v-vc-payload carries a live object, which is the reason it exists alongside
// `data-vc-payload`: the attribute is JSON, so a Date arrives as a string and a
// Map as `{}`. Here it is simply reactive - the qty follows the input with no
// re-render of the directive, because the binding is read at dispatch time.
const qty = asRef(signal(3));
const richPayload = () => ({ qty: qty.value, orderedAt: new Date() });

// v-vc-optimistic: the function applies the change immediately and returns the
// rollback the directive runs if the dispatch fails.
// It receives the Command, so it can bump by the PAYLOAD the binding carried -
// which is also what makes this example checkable: a working v-vc-payload moves
// the counter by qty, a dead one by the `?? 1` fallback.
const optimisticCount = asRef(signal(0));
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
      Demonstrates per-component reactive state. The button marks only itself
      busy while the command is in flight.
    </p>
    <!-- Top-level refs from setup are AUTO-UNWRAPPED in the template - no .value.
         (.value here would read a property off the unwrapped value instead.) -->
    <div class="row">
      <!-- aria-disabled, not :disabled: disabling the pressed button would
           send keyboard focus to <body>. A press in flight is ignored. -->
      <button :aria-disabled="loading" @click="!loading && addToCart(1)">
        {{ loading ? 'Adding...' : 'Add product #1' }}
      </button>
      <button :aria-disabled="loading" @click="!loading && addToCart(-1)">
        {{ loading ? 'Adding...' : 'Add invalid product (errors)' }}
      </button>
    </div>
    <!--
      The same dispatch with no handler at all. The directive reads its target
      and payload from data-vc-* attributes, adds vc-loading / vc-error classes
      while it runs, and marks the button busy for the duration.

      It keeps a compiled v-vc-command in an example, so building the examples
      checks that it mounts in a compiled Vapor template (a change to Vue's
      directive tuple, #15490, once made it inert in every one).
    -->
    <div class="row">
      <button v-vc-command="'cartAdd'" data-vc-target='{"id":2}' data-vc-payload='{"qty":1}'>
        Add product #2 (v-vc-command, no handler)
      </button>
    </div>
    <!--
      v-vc-payload and v-vc-optimistic, on Vapor: a live payload (not JSON in
      an attribute) and an optimistic update with rollback, keeping vc-loading,
      busy-while-in-flight, the re-entrancy guard and the timeout. The order of
      the two directives on the element does not matter.
    -->
    <div class="row">
      <label>qty <input type="number" v-model.number="qty" min="1" max="99" style="width:5rem"></label>
      <button v-vc-payload="richPayload()" v-vc-command="'cartAdd'" v-vc-optimistic="bumpOptimistically"
              data-vc-target='{"id":3}'>
        Add product #3 (v-vc-payload + v-vc-optimistic)
      </button>
      <span class="count">optimistic: {{ optimisticCount }}</span>
    </div>
    <!-- Live regions: the outcome is heard, not only seen. -->
    <p class="ok" role="status">
      <template v-if="cart">✓ In cart: {{ cart.count }} item{{ cart.count > 1 ? 's' : '' }} - total ${{ cart.total.toFixed(2) }}</template>
    </p>
    <p class="error" role="alert">
      <template v-if="lastError">Error: {{ lastError.message }}</template>
    </p>
  </section>
</template>
