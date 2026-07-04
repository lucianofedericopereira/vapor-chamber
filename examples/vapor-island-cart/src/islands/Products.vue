<script setup vapor lang="ts">
import { bus, products } from '../store';

// The emitter island. Each button dispatches a typed product straight onto the
// shared bus via @click — no document listener, no closest(), no JSON.parse.
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
