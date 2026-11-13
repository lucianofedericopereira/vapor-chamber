<!--
  Search as you type, paced at the sender.

  `useCommand({ debounce })` waits for a pause in the typing, then sends the
  last text only. The typed text is the PAYLOAD, so every keystroke shares one
  key. A call that a newer one replaced settles aborted and is ignored here.
  The results are the dispatch's own result.
-->
<script setup vapor lang="ts">
import { signal, useCommand } from 'vapor-chamber/vapor';
import type { Product } from './shop';

const { dispatch, pending } = useCommand({ debounce: 250 });
const searching = pending('productSearch');

const query = signal('');
const results = signal<Product[] | null>(null);

async function onInput(e: Event) {
  query.value = (e.target as HTMLInputElement).value;
  const term = query.value.trim();
  if (term.length < 2) {
    results.value = null;
    return;
  }
  const result = await dispatch('productSearch', undefined, term);
  // Only the text still in the box: an older answer never replaces a newer one.
  if (result.ok && term === query.value.trim()) results.value = result.value as Product[];
}
</script>

<template>
  <section class="panel">
    <h2>Search</h2>
    <p>
      Type at least 2 characters. The search waits for a pause in the typing,
      then sends the last text only.
    </p>
    <input
      type="search"
      :value="query"
      @input="onInput"
      placeholder="Try: usb, wireless, stand"
      aria-label="Search"
      style="padding: 0.4rem; width: 220px;"
    />
    <p role="status">
      <template v-if="searching">Searching...</template>
      <template v-else-if="results && results.length === 0">No product matches "{{ query }}".</template>
      <template v-else-if="results">{{ results.length }} result{{ results.length > 1 ? 's' : '' }}</template>
    </p>
    <ul v-if="results && results.length">
      <li v-for="p in results" :key="p.id">{{ p.name }} - ${{ (p.cents / 100).toFixed(2) }}</li>
    </ul>
  </section>
</template>
