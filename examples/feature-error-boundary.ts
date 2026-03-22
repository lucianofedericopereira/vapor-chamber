/**
 * Feature example: useCommandError — component-scoped error boundary
 * ==================================================================
 * Captures failed command results reactively at the component level.
 * Replaces ad-hoc try/catch blocks scattered across components.
 */

import {
  createCommandBus,
  setCommandBus,
  useCommand,
  useCommandError,
  useCommandGroup,
} from 'vapor-chamber'

const bus = createCommandBus()
setCommandBus(bus)

// Register some handlers that may fail
bus.register('cartAdd', (cmd) => {
  if (!cmd.target?.id) throw new Error('Product ID is required')
  return { added: true, id: cmd.target.id }
})

bus.register('orderSubmit', () => {
  throw new Error('Payment gateway timeout')
})

bus.register('userLogin', (cmd) => {
  if (cmd.target.password.length < 8) throw new Error('Password too short')
  return { token: 'jwt_abc123' }
})

// ─── Global error capture (catch all failures) ────────────────────────────────

const { errors, latestError, clearErrors } = useCommandError()

bus.dispatch('cartAdd', {})         // missing id → error
bus.dispatch('orderSubmit', {})     // payment error

console.log('All errors:', errors.value.length)
console.log('Latest:', latestError.value?.message)
// → 'Payment gateway timeout'

clearErrors()

// ─── Filtered: only watch specific namespaces ─────────────────────────────────

const orderErrors = useCommandError({
  filter: (cmd) => cmd.action.startsWith('order'),
})

const authErrors = useCommandError({
  filter: (cmd) => cmd.action.startsWith('user'),
})

bus.dispatch('cartAdd', {})           // ignored by both
bus.dispatch('orderSubmit', {})       // captured by orderErrors
bus.dispatch('userLogin', { target: { password: 'short' } })  // captured by authErrors

console.log('Order errors:', orderErrors.errors.value.length)  // → 1
console.log('Auth errors:', authErrors.errors.value.length)    // → 1

// ─── In a Vue component ───────────────────────────────────────────────────────

/*
 * <script setup lang="ts">
 * import { useCommand, useCommandError } from 'vapor-chamber'
 *
 * // Per-component error state — cleared on unmount automatically
 * const { dispatch, loading } = useCommand()
 * const { latestError, clearErrors } = useCommandError({
 *   filter: (cmd) => cmd.action === 'checkoutSubmit',
 * })
 * </script>
 *
 * <template>
 *   <div>
 *     <button @click="dispatch('checkoutSubmit', formData)" :disabled="loading.value">
 *       {{ loading.value ? 'Processing…' : 'Pay now' }}
 *     </button>
 *
 *     <div v-if="latestError.value" class="error-banner">
 *       <p>{{ latestError.value.message }}</p>
 *       <button @click="clearErrors">Dismiss</button>
 *     </div>
 *   </div>
 * </template>
 */

// ─── Error entries include timestamp for stale-error detection ────────────────

bus.dispatch('orderSubmit', {})

const entry = errors.value[0]
console.log('Error action:', entry.cmd.action)    // 'orderSubmit'
console.log('Error message:', entry.error.message) // 'Payment gateway timeout'
console.log('Timestamp:', new Date(entry.timestamp).toISOString())

export {}
