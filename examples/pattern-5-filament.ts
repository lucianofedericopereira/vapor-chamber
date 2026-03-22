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

import { createAsyncCommandBus, useCommandState, useCommandGroup } from 'vapor-chamber'
import { createHttpBridge } from 'vapor-chamber/transports'
import { persist, sync } from 'vapor-chamber'
import { ref } from 'vue'

// Each island creates its own isolated bus.
// Livewire and Vapor Chamber manage separate DOM scopes — no conflict.
function mountAnalyticsIsland(el: HTMLElement, endpoint: string) {
  const bus = createAsyncCommandBus()
  bus.use(createHttpBridge({ endpoint }))

  // Namespace all analytics commands
  const analytics = useCommandGroup('analytics')

  // Persist the selected period across page navigations
  const period = ref<'day' | 'week' | 'month'>('week')
  const periodPersist = persist({
    key: 'vc:analytics:period',
    getState: () => period.value,
  })
  bus.use(periodPersist as any)
  period.value = periodPersist.load() ?? 'week'

  // Register local command handlers
  analytics.register('setPeriod', (cmd) => {
    period.value = cmd.target.period
    // Trigger data reload
    return bus.dispatch('analytics.loadMetrics', { period: period.value })
  })

  return { bus, analytics, period }
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
