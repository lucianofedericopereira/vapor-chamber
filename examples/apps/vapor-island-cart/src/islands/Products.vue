<script setup vapor lang="ts">
import { announce, useCommand } from 'vapor-chamber/vue';
import { bus, products } from '../store';

const { dispatch } = useCommand({ bus });

// The emitter island. Each button dispatches `cartAdd` with a typed product, which
// the cart store reduces, onto the shared bus via @click - no document
// listener, no closest(), no JSON.parse.
//
// Plain `@click`, one direct listener per row: compiler-vapor delegates only
// with `@click.delegate` (#15127), and at this size delegation wins nothing
// (the delegated path is marginally slower to mount; its payoff is standing
// listener count). For a catalog-sized list, add `.delegate`.
function add(p: (typeof products)[number]) {
  const result = dispatch('cartAdd', p);
  // The cart changes in another island, out of the pressed button's sight:
  // say what changed (WCAG 4.1.3) through the library's shared live region.
  if (result.ok) announce(`${p.name} added to the cart.`);
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
        <button type="button" class="btn-add" @click="add(p)">Add to cart</button>
      </li>
    </ul>
  </section>
</template>
