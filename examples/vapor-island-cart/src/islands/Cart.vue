<script setup vapor lang="ts">
import { cart } from '../store';
import { useCommand } from '../composables/useCommand';

const clearCmd = useCommand('cart.clear');
const undoCmd  = useCommand('cart.undo');
const redoCmd  = useCommand('cart.redo');
</script>

<!-- No <style>: LIGHT-DOM custom element — page CSS applies directly. -->
<template>
  <section class="cart" :class="{ 'cart--filled': cart.count > 0 }">
    <h2>Cart</h2>
    <p v-if="cart.empty" class="cart-empty">Your cart is empty.</p>
    <div v-else class="cart-summary">
      <div class="cart-row">
        <span class="label">Items</span>
        <span class="value">{{ cart.count }}</span>
      </div>
      <div class="cart-row cart-total">
        <span class="label">Total</span>
        <span class="value">${{ cart.total.toFixed(2) }}</span>
      </div>
      <div class="cart-row">
        <span class="label">Last added</span>
        <span class="value last-added">{{ cart.lastAdded }}</span>
      </div>
      <p v-if="clearCmd.error.value" class="cart-error">{{ clearCmd.error.value }}</p>
      <button class="btn-clear" @click="clearCmd.execute()">Clear cart</button>
    </div>
    <div class="cart-actions">
      <button class="btn-undo" :disabled="cart.cantUndo" @click="undoCmd.execute()">↩ Undo</button>
      <button class="btn-redo" :disabled="cart.cantRedo" @click="redoCmd.execute()">↪ Redo</button>
    </div>
  </section>
</template>
