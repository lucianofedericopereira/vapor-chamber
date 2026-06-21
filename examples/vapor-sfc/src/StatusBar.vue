<!--
  Cross-component aggregate state via `useSharedCommandState`.

  Errors are observed BUS-WIDE (v1.6.0): even though CartPanel dispatches via
  its own per-component `useCommand`, every failed command on the shared
  bus lands in this panel's error list. `isAnyLoading` tracks dispatches made
  through `useSharedCommandState().dispatch` (bus-wide in-flight pairing is
  not guaranteed on all error paths).

  Memory math: this approach allocates ~5 signal nodes total. If we instead
  gave every panel a private `useCommand`, we'd allocate 2 signals per
  panel × N panels.
-->
<script setup vapor lang="ts">
import { useSharedCommandState } from 'vapor-chamber';
import { asRef } from './_reactive';

// asRef: signals are Vue shallowRefs at runtime — typed as such so vue-tsc
// auto-unwraps them in the template (see _reactive.ts).
const shared = useSharedCommandState({ errorCap: 5 });
const isAnyLoading = asRef(shared.isAnyLoading);
const errors = asRef(shared.errors);
const errorCount = asRef(shared.errorCount);
const { clear } = shared;
</script>

<template>
  <section class="panel" style="background: #fafafa;">
    <h2>
      Status
      <!-- Top-level refs are auto-unwrapped in templates — no .value. -->
      <span v-if="isAnyLoading" style="font-weight: normal; color: #08c;">
        — loading…
      </span>
    </h2>
    <p>
      Aggregate state across all components. Watch this panel react when you
      click in Cart or type in Search.
    </p>
    <p>
      <strong>Recent errors ({{ errorCount }}):</strong>
      <button v-if="errorCount > 0" @click="clear" style="margin-left: 0.5rem;">
        Clear
      </button>
    </p>
    <ul v-if="errors.length">
      <li v-for="(e, i) in errors" :key="i" class="error">{{ e.message }}</li>
    </ul>
    <p v-else class="ok">No errors.</p>
  </section>
</template>
