<!--
  Fire-and-forget hot path via `defineVaporCommand`.

  Search-as-you-type and telemetry events are high-frequency. Allocating two
  reactive signals (loading, lastError) per keystroke is wasted overhead.
  `defineVaporCommand` skips that — handler runs, fire-and-forget.

  The local `query` signal is a plain Vue ref for the input value.
-->
<script setup vapor lang="ts">
import { defineVaporCommand, signal } from 'vapor-chamber';

const query = signal('');

// Zero-overhead — no reactive loading/error allocation per call.
const { dispatch: search } = defineVaporCommand('searchExecute', async (cmd) => {
  // In a real app, forward to your search backend. Here we just log the term.
  console.log('[searchExecute]', cmd.target);
});

function onInput(e: Event) {
  query.value = (e.target as HTMLInputElement).value;
  if (query.value.length >= 2) search(query.value);
}
</script>

<template>
  <section class="panel">
    <h2>Search</h2>
    <p>
      Demonstrates the fire-and-forget hot path. Each keystroke (after 2
      chars) dispatches a <code>searchExecute</code> command — no reactive
      loading state is allocated per call.
    </p>
    <!-- query is a top-level ref — auto-unwrapped in the template, no .value -->
    <input
      type="text"
      :value="query"
      @input="onInput"
      placeholder="Type to search…"
      style="padding: 0.4rem; width: 200px;"
    />
    <p>Open the console — <code>[searchExecute]</code> logs each dispatch.</p>
  </section>
</template>
