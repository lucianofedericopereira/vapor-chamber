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
// Livewire and Vapor Chamber manage separate DOM scopes — no conflict.
//
// NOTE: register and dispatch directly on the LOCAL bus. useCommandGroup()
// always attaches to the shared getCommandBus() instance, which would defeat
// the per-island isolation this pattern is about — namespace by naming the
// actions instead ('analytics*').
function mountAnalyticsIsland(el: HTMLElement, endpoint: string) {
  const bus = createAsyncCommandBus()
  bus.use(createHttpBridge({ endpoint, actions: ['analyticsLoad*'] }))

  // Persist the selected period across page navigations.
  // persist() is a sync plugin; on this async bus its save-on-dispatch hook
  // would see an unresolved Promise, so save explicitly via onAfter instead
  // and use the plugin object only for load()/save()/clear().
  const period = ref<'day' | 'week' | 'month'>('week')
  const periodPersist = persist({
    key: 'vc:analytics:period',
    getState: () => period.value,
  })
  period.value = periodPersist.load() ?? 'week'
  bus.onAfter((cmd, result) => {
    if (cmd.action === 'analyticsSetPeriod' && result.ok) periodPersist.save()
  })

  // Register local command handlers
  bus.register('analyticsSetPeriod', (cmd) => {
    period.value = cmd.target.period
    // Trigger data reload — forwarded to the backend by the HTTP bridge
    return bus.dispatch('analyticsLoadMetrics', { period: period.value })
  })

  return { bus, period }
}

/*
 * PHP: app/Filament/Widgets/AnalyticsWidget.php
 * ——————————————————————————————————————————————
 * class AnalyticsWidget extends Widget
 * {
 *     protected static string $view = 'filament.widgets.analytics-island';
 *
 *     public function getViewData(): array
 *     {
 *         return ['endpoint' => route('api.vc')];
 *     }
 * }
 */

/*
 * Blade: resources/views/filament/widgets/analytics-island.blade.php
 * ——————————————————————————————————————————————————————————————————
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
 *     const { analytics } = VaporChamber.mount('#analytics-island', {
 *       transport: VaporChamber.http({ endpoint: el.dataset.endpoint }),
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
 * - Single chart widget → one island, one bus
 * - Full dashboard section → multiple islands, each with its own bus
 * - Cross-island coordination → use sync() plugin with a shared channel
 */
export {}
