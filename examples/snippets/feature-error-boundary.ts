/**
 * Feature example: useCommandError - a component shows the failures of its own commands
 * =======================================================================================
 * `useCommandError` collects the failed results of the bus reactively, all of
 * them or only the actions named, with the failing command and a timestamp. A
 * component reads `latestError` into a banner. No try/catch in the component.
 */

import { createApp, defineComponent, h } from 'vue'
// One entry for a Vue app: `vapor-chamber/vue` carries the bus too, and
// wires Vue (the root would not).
import { createAsyncCommandBus, setCommandBus, useCommand, useCommandError } from 'vapor-chamber/vue'

const bus = createAsyncCommandBus()
setCommandBus(bus)

bus.register('cartAdd', async (cmd) => {
  if (!cmd.target?.id) throw new Error('Product ID is required')
  return { added: true, id: cmd.target.id }
})
bus.register('orderSubmit', () => {
  throw new Error('Payment gateway timeout')
})
bus.register('userLogin', async (cmd) => {
  if (cmd.target.password.length < 8) throw new Error('Password too short')
  return { token: 'jwt_abc123' }
})
bus.register('checkoutSubmit', async () => {
  await new Promise((resolve) => setTimeout(resolve, 600))
  throw new Error('Card declined')
})

// ─── All failures, or only some ───────────────────────────────────────────────

// Outside a component, for brevity: in an app each of these runs in setup()
// and leaves with the component. Here the end of this section calls dispose().
const all = useCommandError()
const orderErrors = useCommandError({ actions: ['order*'] })
const authErrors = useCommandError({ actions: ['user*'] })

await bus.dispatch('cartAdd', {})
await bus.dispatch('orderSubmit', {})
await bus.dispatch('userLogin', { password: 'short' })
await bus.dispatch('cartAdd', { id: 1 }) // succeeds: not an error

console.log('All errors:', all.errors.value.length)          // 3
console.log('Latest:', all.latestError.value?.message)       // Password too short
console.log('Order errors:', orderErrors.errors.value.length) // 1
console.log('Auth errors:', authErrors.errors.value.length)   // 1

// Each entry names the failing command and when it failed.
const entry = all.errors.value[0]
console.log('Error action:', entry.cmd.action)
console.log('Error message:', entry.error.message)
console.log('Timestamp:', new Date(entry.timestamp).toISOString())

all.clearErrors()
console.log('After clearErrors:', all.errors.value.length, all.latestError.value)
for (const errors of [all, orderErrors, authErrors]) errors.dispose()

// ─── In a component ───────────────────────────────────────────────────────────

// The button is busy while its command is in flight (`pending`), and the banner
// shows the failure until the user dismisses it. Click Pay now on the page.
const Checkout = defineComponent({
  setup() {
    const cmd = useCommand()
    const errs = useCommandError({ actions: ['checkoutSubmit'] })
    const order = { id: 7 }
    const busy = cmd.pending('checkoutSubmit', order)
    const pay = () => { if (!busy.value) cmd.dispatch('checkoutSubmit', order) }

    return () => h('div', [
      // aria-disabled, not disabled: keyboard focus stays on the button
      h('button', { id: 'pay', type: 'button', 'aria-disabled': busy.value, onClick: pay },
        busy.value ? 'Processing...' : 'Pay now'),
      errs.latestError.value
        ? h('div', { class: 'error-banner', role: 'alert' }, [
          h('p', errs.latestError.value.message),
          h('button', { id: 'dismiss', type: 'button', onClick: errs.clearErrors }, 'Dismiss'),
        ])
        : null,
    ])
  },
})

const host = document.createElement('div')
document.body.append(host)
createApp(Checkout).mount(host)
