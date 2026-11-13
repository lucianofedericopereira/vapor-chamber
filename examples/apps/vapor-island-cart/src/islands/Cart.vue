<script setup vapor lang="ts">
import { useSharedCommandState } from 'vapor-chamber/vue';
import { bus, cart, history } from '../store';

// The bus's recent failures, whichever island caused them. Read as
// `shared.lastError.value` in the template: a destructured signal would be
// unwrapped there, and from this entry its type says it is not a ref.
const shared = useSharedCommandState({ bus });
</script>

<!-- No <style>: LIGHT-DOM custom element - page CSS applies directly. -->
<template>
  <section class="cart" :class="{ 'cart--filled': cart.state.value.count > 0 }">
    <h2>Cart</h2>
    <p v-if="cart.state.value.count === 0" class="cart-empty">Your cart is empty.</p>
    <div v-else class="cart-summary">
      <div class="cart-row">
        <span class="label">Items</span>
        <span class="value">{{ cart.state.value.count }}</span>
      </div>
      <div class="cart-row cart-total">
        <span class="label">Total</span>
        <span class="value">${{ (cart.state.value.cents / 100).toFixed(2) }}</span>
      </div>
      <div class="cart-row">
        <span class="label">Last added</span>
        <span class="value last-added">{{ cart.state.value.lastAdded }}</span>
      </div>
      <p class="cart-error" role="alert">{{ shared.lastError.value?.message }}</p>
      <button type="button" class="btn-clear" @click="cart.$reset()">Clear cart</button>
    </div>
    <!-- aria-disabled, not disabled: undoing the last step would disable the
         focused button and send keyboard focus to <body>. -->
    <div class="cart-actions">
      <button type="button" class="btn-undo" :aria-disabled="!history.canUndo.value" @click="history.canUndo.value && history.undo()"><- Undo</button>
      <button type="button" class="btn-redo" :aria-disabled="!history.canRedo.value" @click="history.canRedo.value && history.redo()">-> Redo</button>
    </div>
  </section>
</template>
