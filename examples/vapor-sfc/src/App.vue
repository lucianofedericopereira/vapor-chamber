<!--
  Top-level Vapor SFC: three panels on one bus, each showing a different
  view of it.

    1. CartPanel - a busy state per button, the cart the server confirmed
    2. SearchPanel - a paced search with its results
    3. StatusBar - the whole bus: anything in flight, every failure
-->
<script setup vapor lang="ts">
// shop.ts builds the bus and shares it (setCommandBus), so importing it here
// runs it before any panel asks for the bus.
import './shop';
import CartPanel from './CartPanel.vue';
import SearchPanel from './SearchPanel.vue';
import StatusBar from './StatusBar.vue';
</script>

<template>
  <h1>vapor-chamber - Vapor SFC example</h1>
  <p>
    Three components share one command bus. Each reads a different part of
    its state.
  </p>

  <StatusBar />
  <CartPanel />
  <SearchPanel />
</template>
