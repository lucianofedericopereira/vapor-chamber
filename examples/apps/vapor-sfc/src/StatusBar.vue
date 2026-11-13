<!--
  The whole bus, read through `useSharedCommandState`.

  Both signals are BUS-WIDE: `anyPending` is on while any command is in
  flight, whoever sent it, and `errors` collects every failed command. One
  state serves every caller on the bus (tests/shared-state.test.ts).
-->
<script setup vapor lang="ts">
import { useSharedCommandState } from 'vapor-chamber/vapor';

// From `vapor-chamber/vapor` the command state's signals are typed as the Vue
// shallowRefs they are, so vue-tsc unwraps them in the template with no cast.
const { anyPending, errors, clear } = useSharedCommandState({ maxSize: 5 });
</script>

<template>
  <section class="panel" style="background: #fafafa;">
    <h2>
      Status
      <span v-if="anyPending" style="font-weight: normal; color: #08c;">
        - loading...
      </span>
    </h2>
    <p>
      The bus as a whole. It reacts when you click in Cart or type in Search.
    </p>
    <!-- The button stays in place (aria-disabled when there is nothing to
         clear): removing it while it has focus would drop keyboard focus. -->
    <p>
      <strong>Recent errors ({{ errors.length }}):</strong>
      <button type="button" :aria-disabled="errors.length === 0" @click="errors.length > 0 && clear()" style="margin-left: 0.5rem;">
        Clear
      </button>
    </p>
    <!-- A live region: a new error is announced, not only listed. -->
    <div aria-live="polite">
      <ul v-if="errors.length">
        <li v-for="(e, i) in errors" :key="i" class="error">{{ e.message }}</li>
      </ul>
      <p v-else class="ok">No errors.</p>
    </div>
  </section>
</template>
