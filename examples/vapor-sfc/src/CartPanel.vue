<!--
  Per-component reactive loading state via `useCommand`.

  Each button gets its own `loading` / `lastError` signals. Clicking either
  button disables only that button while the dispatch is in flight.
-->
<script setup vapor lang="ts">
// The Vapor entry wires Vue at build time; from the root this would work only
// because main.ts happens to import it too.
import { useCommand, signal } from 'vapor-chamber/vapor';
// v-vc-command, imported as a vVcCommand binding - the idiomatic form. It was
// registered app-wide in main.ts until v1.22.0 because vue-tsc rejected the
// imported form's ARGUMENT; the reshape removed the argument, so this now
// type-checks. See the note in main.ts.
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
// of truth. (Without this, a successful dispatch had no visible outcome.)
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

// v-vc-optimistic had NO Vapor substitute before v1.22.0. The function applies
// the change immediately and returns the rollback the directive runs if the
// dispatch fails.
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
      Demonstrates per-component reactive state. The button disables only
      itself while the command is in flight.
    </p>
    <!-- Top-level refs from setup are AUTO-UNWRAPPED in the template - no .value.
         (.value here would read a property off the unwrapped value instead.) -->
    <div class="row">
      <button :disabled="loading" @click="addToCart(1)">
        {{ loading ? 'Adding...' : 'Add product #1' }}
      </button>
      <button :disabled="loading" @click="addToCart(-1)">
        {{ loading ? 'Adding...' : 'Add invalid product (errors)' }}
      </button>
    </div>
    <!--
      The same dispatch with no handler at all. The directive reads its target
      and payload from data-vc-* attributes, adds vc-loading / vc-error classes
      while it runs, and disables the button for the duration.

      This is here because it was NOT here when it mattered: Vue 3.6.0-rc.9
      #15490 changed the compiled directive tuple and v-vc-command stopped
      mounting in every compiled Vapor template. No example carried one, so
      rebuilding all three examples - which this project's alignment ritual
      does every cycle - would have passed while the feature was dead.

      Imported above as a `vVcCommand` binding. Until v1.22.0 it had to be registered
      app-wide in main.ts to get past vue-tsc; see the note there.
    -->
    <div class="row">
      <button v-vc-command="'cartAdd'" data-vc-target='{"id":2}' data-vc-payload='{"qty":1}'>
        Add product #2 (v-vc-command, no handler)
      </button>
    </div>
    <!--
      v-vc-payload and v-vc-optimistic, on Vapor. Both were vDOM-only until
      v1.22.0: the payload had a lossy substitute (`data-vc-payload`, JSON in an
      attribute) and optimistic-with-rollback had none at all, so a Vapor
      consumer had to abandon the directive and hand-roll the dispatch, losing
      vc-loading, disable-while-busy, the re-entrancy guard and the timeout with
      it. The order of the two directives on the element does not matter.
    -->
    <div class="row">
      <label>qty <input type="number" v-model.number="qty" min="1" max="99" style="width:5rem"></label>
      <button v-vc-payload="richPayload()" v-vc-command="'cartAdd'" v-vc-optimistic="bumpOptimistically"
              data-vc-target='{"id":3}'>
        Add product #3 (v-vc-payload + v-vc-optimistic)
      </button>
      <span class="count">optimistic: {{ optimisticCount }}</span>
    </div>
    <p v-if="cart" class="ok">
      ✓ In cart: {{ cart.count }} item{{ cart.count > 1 ? 's' : '' }} - total ${{ cart.total.toFixed(2) }}
    </p>
    <p v-if="lastError" class="error">
      Error: {{ lastError.message }}
    </p>
  </section>
</template>
