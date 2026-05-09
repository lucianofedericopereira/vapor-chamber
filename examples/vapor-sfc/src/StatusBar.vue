<!--
  Cross-component aggregate state via `useSharedCommandState`.

  This component subscribes to "is *anything* in flight?" and "what was the
  last error?" — across the whole app. Even though CartPanel uses its own
  per-component `useVaporCommand`, the shared state still observes those
  dispatches because both go through the same bus.

  Memory math: this approach allocates ~5 signal nodes total. If we instead
  gave every panel a private `useVaporCommand`, we'd allocate 2 signals per
  panel × N panels.
-->
<script setup vapor lang="ts">
import { useSharedCommandState } from 'vapor-chamber';

const { isAnyLoading, errors, errorCount, clear } = useSharedCommandState({ errorCap: 5 });
</script>

<template>
  <section class="panel" style="background: #fafafa;">
    <h2>
      Status
      <span v-if="isAnyLoading.value" style="font-weight: normal; color: #08c;">
        — loading…
      </span>
    </h2>
    <p>
      Aggregate state across all components. Watch this panel react when you
      click in Cart or type in Search.
    </p>
    <p>
      <strong>Recent errors ({{ errorCount.value }}):</strong>
      <button v-if="errorCount.value > 0" @click="clear" style="margin-left: 0.5rem;">
        Clear
      </button>
    </p>
    <ul v-if="errors.value.length">
      <li v-for="(e, i) in errors.value" :key="i" class="error">{{ e.message }}</li>
    </ul>
    <p v-else class="ok">No errors.</p>
  </section>
</template>
