/**
 * Feature example: transition hooks as commands
 * =============================================
 * `<Transition>` calls hooks as an element enters and leaves. The bridge turns
 * each into a command (`modalBeforeEnter`, `modalEnter`, `modalAfterEnter`,
 * `modalBeforeLeave`, `modalLeave`, `modalAfterLeave`). A handler times the
 * animation: on an async bus Vue waits for it, then `done()` runs. Plugins and
 * listeners see every step, and `phase` says where the element is.
 */

import { createApp, defineComponent, h, ref, Transition } from 'vue'
// One entry for a Vue app: `vapor-chamber/vue` wires Vue at build time, so `phase`
// stays a reactive signal in a production bundle (the root would not).
import { createCommandBus, createAsyncCommandBus, logger, setCommandBus } from 'vapor-chamber/vue'
import { createTransitionBridge, useTransitionCommand } from 'vapor-chamber/transitions'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const el = document.createElement('div')

// ─── 1. The factory, by hand (no framework) ──────────────────────────────────

const modalBus = createCommandBus({ onMissing: 'ignore' })
modalBus.use(logger({ actions: ['modal*'], collapsed: true }))

modalBus.register('modalBeforeEnter', () => console.log('Preparing the modal to enter'))
modalBus.register('modalAfterEnter', () => console.log('Modal is fully visible: the focus trap can start'))
modalBus.register('modalBeforeLeave', () => console.log('Modal is leaving: release the focus trap'))
modalBus.register('modalAfterLeave', () => console.log('Modal is out of the DOM: cleanup is done'))

const modal = createTransitionBridge({ bus: modalBus, namespace: 'modal' })

modal.onBeforeEnter(el)
console.log('Phase during enter:', modal.phase.value) // entering
modal.onEnter(el, () => console.log('done(): enter complete'))
modal.onAfterEnter(el)
console.log('Phase after enter:', modal.phase.value)  // idle
modal.onBeforeLeave(el)
console.log('Phase during leave:', modal.phase.value)  // leaving
modal.onLeave(el, () => console.log('done(): leave complete'))
modal.onAfterLeave(el)
console.log('Phase after leave:', modal.phase.value)  // idle

// ─── 2. An async handler times the animation ─────────────────────────────────

const bus = createAsyncCommandBus({ onMissing: 'ignore' })
setCommandBus(bus)

bus.register('drawerEnter', async () => {
  await wait(300) // a 300 ms slide-in
  console.log('Drawer slide-in finished')
})
bus.register('drawerLeave', async () => {
  await wait(200)
  console.log('Drawer slide-out finished')
})

const drawer = createTransitionBridge({ bus, namespace: 'drawer' })

// done() runs after the handler settles. The async bus makes Vue wait for it.
await new Promise<void>((done) => drawer.onEnter(el, () => { console.log('done(): Vue may go on (enter)'); done() }))
await new Promise<void>((done) => drawer.onLeave(el, () => { console.log('done(): Vue may go on (leave)'); done() }))

// ─── 3. In a Vue component ───────────────────────────────────────────────────

// `useTransitionCommand` binds the hooks to the shared bus, with a reactive
// `phase`. In a template: `<Transition v-bind="toast">`. Press Toggle on the
// page: the handlers below run, and the phase shows next to the toast.
bus.register('toastEnter', async (cmd) => {
  console.log('toastEnter on', cmd.target.className)
  await wait(300)
})
bus.register('toastLeave', async () => {
  await wait(200)
  console.log('toastLeave finished')
})

const Toaster = defineComponent({
  setup() {
    const toast = useTransitionCommand({ namespace: 'toast' })
    const shown = ref(false)
    return () => h('div', [
      h('button', { id: 'toggle', type: 'button', onClick: () => { shown.value = !shown.value } }, 'Toggle'),
      h('span', { id: 'phase' }, ` phase: ${toast.phase.value}`),
      // The enumerable hooks spread onto <Transition>; `phase` is not among them.
      h(Transition, { ...toast, css: false }, () => (shown.value ? h('p', { class: 'toast' }, 'Saved') : null)),
    ])
  },
})

const host = document.createElement('div')
document.body.append(host)
createApp(Toaster).mount(host)
