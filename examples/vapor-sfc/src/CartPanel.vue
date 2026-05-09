<!--
  Per-component reactive loading state via `useVaporCommand`.

  Each button gets its own `loading` / `lastError` signals. Clicking either
  button disables only that button while the dispatch is in flight.
-->
<script setup vapor lang="ts">
import { useVaporCommand } from 'vapor-chamber';

const { dispatch, loading, lastError } = useVaporCommand();

async function addToCart(id: number) {
  await dispatch('cartAdd', { id }, { qty: 1 });
}
</script>

<template>
  <section class="panel">
    <h2>Cart</h2>
    <p>
      Demonstrates per-component reactive state. The button disables only
      itself while the command is in flight.
    </p>
    <div class="row">
      <button :disabled="loading.value" @click="addToCart(1)">
        {{ loading.value ? 'Adding…' : 'Add product #1' }}
      </button>
      <button :disabled="loading.value" @click="addToCart(-1)">
        {{ loading.value ? 'Adding…' : 'Add invalid product (errors)' }}
      </button>
    </div>
    <p v-if="lastError.value" class="error">
      Error: {{ lastError.value.message }}
    </p>
  </section>
</template>
