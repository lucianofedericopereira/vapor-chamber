/**
 * Pattern 5: Filament panel + vapor-chamber islands
 * ==================================================
 * Filament uses Livewire for its own components.
 * Vapor Chamber coexists as reactive islands inside a Filament panel.
 *
 * Useful for: complex visualizations, real-time widgets, multi-step wizards,
 * or any section that benefits from Vue Vapor's signal-based reactivity
 * without needing a full Livewire component.
 *
 * resources/js/islands/analytics.ts
 */

import { createAsyncCommandBus, persist } from 'vapor-chamber'
import { createHttpBridge } from 'vapor-chamber/transports'
import { ref } from 'vue'

// Each island creates its own isolated bus.
// Livewire and Vapor Chamber manage separate DOM scopes - no conflict.
//
// NOTE: register and dispatch directly on the LOCAL bus. useCommandGroup()
// always attaches to the shared getCommandBus() instance, which would defeat
// the per-island isolation this pattern is about - namespace by naming the
// actions instead ('analytics*').
function mountAnalyticsIsland(el: HTMLElement, endpoint: string) {
  const bus = createAsyncCommandBus()
  // `csrf: true` sends Laravel's token: the raw bridge leaves it off, where
  // the IIFE's connect() turns it on.
  bus.use(createHttpBridge({ endpoint, actions: ['analyticsLoad*'], csrf: true }))

  // Persist the selected period across page navigations: persist() saves
  // after each successful `analyticsSetPeriod`, on either bus.
  const period = ref<'day' | 'week' | 'month'>('week')
  const periodPersist = persist({
    key: 'vc:analytics:period',
    getState: () => period.value,
    filter: (cmd) => cmd.action === 'analyticsSetPeriod',
  })
  period.value = periodPersist.load() ?? 'week'
  bus.use(periodPersist)

  // Register local command handlers
  bus.register('analyticsSetPeriod', async (cmd) => {
    period.value = cmd.target.period
    // Trigger data reload - forwarded to the backend by the HTTP bridge
    return bus.dispatch('analyticsLoadMetrics', { period: period.value })
  })

  return { bus, period }
}

// Mount once the widget's element is on the page.
const el = document.getElementById('analytics-island')
if (el?.dataset.endpoint) mountAnalyticsIsland(el, el.dataset.endpoint)

/*
 * PHP: app/Filament/Widgets/AnalyticsWidget.php
 * ----------------------------------------------
 * class AnalyticsWidget extends Widget
 * {
 *     // Filament 4 and later: an instance property (a static one is Filament 3's).
 *     protected string $view = 'filament.widgets.analytics-island';
 *
 *     public function getViewData(): array
 *     {
 *         return ['endpoint' => route('api.vc')];
 *     }
 * }
 */

/*
 * Blade: resources/views/filament/widgets/analytics-island.blade.php
 * ------------------------------------------------------------------
 * <x-filament-widgets::widget>
 *   <x-filament::section>
 *     <div id="analytics-island" data-endpoint="{{ $endpoint }}">
 *       {{-- Vue Vapor mounts here; Livewire runs the rest of the panel --}}
 *     </div>
 *   </x-filament::section>
 * </x-filament-widgets::widget>
 *
 * <script>
 * document.addEventListener('DOMContentLoaded', () => {
 *   const el = document.getElementById('analytics-island')
 *   if (el) {
 *     // If using IIFE/CDN approach inside Filament
 *     const { bus, dispatch } = VaporChamber.mount('#analytics-island', {
 *       transport: VaporChamber.http({ endpoint: el.dataset.endpoint, csrf: true }),
 *       state: { period: 'week', metrics: [] }
 *     })
 *   }
 * })
 * </script>
 */

/*
 * Key constraint: each island manages its own DOM scope.
 * Livewire's wire:id and morphdom operate on their own elements.
 * Vapor Chamber's bus operates on the island's subtree.
 * They never touch each other's DOM nodes.
 *
 * This pattern scales:
 * - Single chart widget -> one island, one bus
 * - Full dashboard section -> multiple islands, each with its own bus
 * - Cross-island coordination -> emit a DOM event (emitDOMEvent) the other
 *   island listens to, or give the islands one shared bus for the facts they
 *   share. (createChannel() is cross-TAB, over BroadcastChannel.)
 */
export {}
