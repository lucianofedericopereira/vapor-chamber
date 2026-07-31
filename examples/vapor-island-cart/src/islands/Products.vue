<script setup vapor lang="ts">
import { bus, products } from '../store';

// The emitter island. Each button dispatches a typed product straight onto the
// shared bus via @click — no document listener, no closest(), no JSON.parse.
//
// Vue 3.6.0-rc.2 (#15127, BREAKING): compiler-vapor event delegation is now
// opt-in via `@click.delegate`, not automatic — this three-item list got a
// free shared document listener under the old default and now gets N direct
// ones instead. Left as plain `@click` here: at this size .delegate has
// nothing to win (vapor-chamber's own bench of the equivalent trade-off in
// src/directives.ts shows the delegated path is marginally SLOWER to mount,
// not faster — the payoff is standing listener count, not speed). For a
// real catalog-sized list (hundreds/thousands of rows), add `.delegate` to
// trade that mount cost for one shared listener instead of one per row.
function add(p: (typeof products)[number]) {
  bus.dispatch('cartAdd', p);
}
</script>

<template>
  <section class="products">
    <h2>Menu</h2>
    <ul class="product-list">
      <li v-for="p in products" :key="p.id" class="product-item">
        <div>
          <div class="product-name">{{ p.name }}</div>
          <div class="product-price">${{ p.price.toFixed(2) }}</div>
        </div>
        <button class="btn-add" @click="add(p)">Add to cart</button>
      </li>
    </ul>
  </section>
</template>
