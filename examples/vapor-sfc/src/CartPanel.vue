<!--
  Per-component reactive loading state via `useCommand`.

  Each button gets its own `loading` / `lastError` signals. Clicking either
  button disables only that button while the dispatch is in flight.
-->
<script setup vapor lang="ts">
import { useCommand, signal } from 'vapor-chamber';
import { asRef } from './_reactive';

// asRef: vapor-chamber signals are Vue shallowRefs at runtime — typed as such here
// so vue-tsc auto-unwraps them in the template (see _reactive.ts).
const cmd = useCommand();
const { dispatch } = cmd;
const loading = asRef(cmd.loading);
const lastError = asRef(cmd.lastError);

// Success feedback: render the handler's CONFIRMED state — the single source
// of truth. (Without this, a successful dispatch had no visible outcome.)
const cart = asRef(signal<{ count: number; total: number } | null>(null));

async function addToCart(id: number) {
  const result = await dispatch('cartAdd', { id }, { qty: 1 });
  if (result.ok) cart.value = result.value as { count: number; total: number };
}
</script>

<template>
  <section class="panel">
    <h2>Cart</h2>
    <p>
      Demonstrates per-component reactive state. The button disables only
      itself while the command is in flight.
    </p>
    <!-- Top-level refs from setup are AUTO-UNWRAPPED in the template — no .value.
         (.value here would read a property off the unwrapped value instead.) -->
    <div class="row">
      <button :disabled="loading" @click="addToCart(1)">
        {{ loading ? 'Adding…' : 'Add product #1' }}
      </button>
      <button :disabled="loading" @click="addToCart(-1)">
        {{ loading ? 'Adding…' : 'Add invalid product (errors)' }}
      </button>
    </div>
    <p v-if="cart" class="ok">
      ✓ In cart: {{ cart.count }} item{{ cart.count > 1 ? 's' : '' }} — total ${{ cart.total.toFixed(2) }}
    </p>
    <p v-if="lastError" class="error">
      Error: {{ lastError.message }}
    </p>
  </section>
</template>
