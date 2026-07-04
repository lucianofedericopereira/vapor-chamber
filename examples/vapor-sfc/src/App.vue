<!--
  Top-level Vapor SFC. Composes three smaller components, all using
  vapor-chamber composables to dispatch and observe a shared bus.

  Renders three panels:
    1. CartPanel — uses useCommand for per-button loading state
    2. SearchPanel — uses defineVaporCommand for fire-and-forget telemetry
    3. StatusBar — uses useSharedCommandState for cross-component aggregate state
-->
<script setup vapor lang="ts">
import { createAsyncCommandBus, setCommandBus } from 'vapor-chamber';
import CartPanel from './CartPanel.vue';
import SearchPanel from './SearchPanel.vue';
import StatusBar from './StatusBar.vue';

// The handlers below are ASYNC (simulated latency), so the shared bus must be
// the async bus: its dispatch returns Promise<CommandResult>, which the
// composables' loading/lastError wiring awaits. On the default SYNC bus an
// async handler's promise is wrapped as a plain ok-value — rejections escape
// as unhandled and lastError never fires.
const bus = createAsyncCommandBus();
setCommandBus(bus as any); // share it: useCommand/useSharedCommandState pick it up

// Stateful fake server: the cart accumulates across dispatches, so the UI's
// confirmed totals actually move. (Was stateless — total stuck at $19.99.)
const serverCart = { count: 0, cents: 0 };
bus.register('cartAdd', async (cmd) => {
  await new Promise(r => setTimeout(r, 250));
  if (cmd.target?.id < 0) throw new Error('Invalid product id');
  serverCart.count += cmd.payload?.qty ?? 1;
  serverCart.cents += 1999;
  return { count: serverCart.count, total: serverCart.cents / 100, lastAddedId: cmd.target?.id };
});

// NOTE: 'searchExecute' is deliberately NOT registered here —
// SearchPanel.vue owns it via defineVaporCommand() (a second registration
// would overwrite it and warn on every load).
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
