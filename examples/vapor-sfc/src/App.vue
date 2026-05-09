<!--
  Top-level Vapor SFC. Composes three smaller components, all using
  vapor-chamber composables to dispatch and observe a shared bus.

  Renders three panels:
    1. CartPanel — uses useVaporCommand for per-button loading state
    2. SearchPanel — uses defineVaporCommand for fire-and-forget telemetry
    3. StatusBar — uses useSharedCommandState for cross-component aggregate state
-->
<script setup vapor lang="ts">
import { getCommandBus } from 'vapor-chamber';
import CartPanel from './CartPanel.vue';
import SearchPanel from './SearchPanel.vue';
import StatusBar from './StatusBar.vue';

// Register a few demo handlers on the shared bus. In a real app these would
// live in handler modules and be installed at app startup.
const bus = getCommandBus();

bus.register('cartAdd', async (cmd) => {
  await new Promise(r => setTimeout(r, 250));
  if (cmd.target?.id < 0) throw new Error('Invalid product id');
  return { count: 1, total: 19.99, lastAddedId: cmd.target?.id };
});

bus.register('searchExecute', async (cmd) => {
  await new Promise(r => setTimeout(r, 200));
  return { hits: ['result A', 'result B'], query: cmd.target };
});
</script>

<template>
  <h1>vapor-chamber — Vapor SFC example</h1>
  <p>
    Three components share one command bus. Each demonstrates a different
    composable pattern.
  </p>

  <StatusBar />
  <CartPanel />
  <SearchPanel />
</template>
