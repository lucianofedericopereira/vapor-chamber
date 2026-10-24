/**
 * Pattern 5: Filament panel + vapor-chamber islands
 * ==================================================
 * Filament uses Livewire for its own components.
 * Vapor Chamber coexists as reactive islands inside a Filament panel.
 *
 * Useful for: complex visualizations, real-time widgets, multi-step wizards,
 * or any section that benefits from reactivity without needing a full
 * Livewire component.
 *
 * The island: a period picker whose choice is saved across page loads, and the
 * metrics of that period, read from the server whenever it changes.
 *
 * resources/js/islands/analytics.ts
 */

import { bindCommands, bindDisplay, createAsyncCommandBus, createHttpClient, saveTo } from 'vapor-chamber'
import { defineChamberStore } from 'vapor-chamber/store'

type Period = 'day' | 'week' | 'month'
type Row = { label: string; value: number }

// Each island creates its own isolated bus.
// Livewire and Vapor Chamber manage separate DOM scopes - no conflict.
//
// NOTE: dispatch on the island's own bus. useCommandGroup() attaches to the
// shared getCommandBus() unless it is given `{ bus }`, which would defeat the
// per-island isolation this pattern is about.
function mountAnalyticsIsland(el: HTMLElement, metricsUrl: string) {
  const bus = createAsyncCommandBus()

  // The selected period is a store, saved across page loads: `persist` saves it
  // after each `analyticsSetPeriod` and reads it back on the next load.
  const analytics = defineChamberStore('analytics', {
    state: () => ({ period: 'week' as Period }),
    reducers: { setPeriod: (_s, target: { period: Period }) => ({ period: target.period }) },
    persist: saveTo({ key: 'vc:analytics:period' }),
  })(bus)

  // The metrics are the server's data, not a command, so they are a read.
  // Nothing of them is saved: a new page load reads them again.
  const metrics = defineChamberStore('metrics', {
    state: () => ({ rows: [] as Row[], loading: false, error: '' }),
    reducers: {
      start: (s) => ({ ...s, loading: true, error: '' }),
      done: (_s, rows: Row[]) => ({ rows, loading: false, error: '' }),
      fail: (s, message: string) => ({ ...s, loading: false, error: message }),
    },
  })(bus)

  // A client reads with a cache: a period read before is answered without a
  // request until its ttl ends, then revalidated with the server's ETag.
  const http = createHttpClient({ cache: { ttl: 30_000 } })
  let inFlight: AbortController | undefined

  async function load(period: Period) {
    inFlight?.abort() // a slow read of an earlier period must not land after this one
    const read = (inFlight = new AbortController())
    metrics.start()
    const res = await http.safe.get<Row[]>(metricsUrl, { params: { period }, signal: read.signal })
    if (read.signal.aborted) return
    if (res.error) metrics.fail(res.error.message)
    else metrics.done(res.data ?? [])
  }

  // `$onField` fires when the period changes, never for the state a load starts
  // with, so the first read is asked for.
  analytics.$onField('period', load)
  void load(analytics.state.value.period)

  // The island's markup (Blade below) names its commands and the fields it shows.
  bindCommands(el, { bus })
  bindDisplay(el, { bus })

  return { bus, analytics, metrics }
}

// Mount once the widget's element is on the page.
const el = document.getElementById('analytics-island')
if (el?.dataset.metrics) mountAnalyticsIsland(el, el.dataset.metrics)

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
 *         return ['metrics' => route('api.analytics.metrics')];
 *     }
 * }
 */

/*
 * Blade: resources/views/filament/widgets/analytics-island.blade.php
 * ------------------------------------------------------------------
 * <x-filament-widgets::widget>
 *   <x-filament::section>
 *     <div id="analytics-island" data-metrics="{{ $metrics }}">
 *       <p>Period: <strong data-vc-text="analytics.period"></strong></p>
 *       <button data-vc-command="analyticsSetPeriod" data-vc-target='{"period":"day"}'>Day</button>
 *       <button data-vc-command="analyticsSetPeriod" data-vc-target='{"period":"week"}'>Week</button>
 *       <button data-vc-command="analyticsSetPeriod" data-vc-target='{"period":"month"}'>Month</button>
 *       <p data-vc-show="metrics.loading">Loading...</p>
 *       <p data-vc-show="metrics.error" role="alert" data-vc-text="metrics.error"></p>
 *       <ul data-vc-each="metrics.rows">
 *         <template><li><span data-vc-text="label"></span>: <span data-vc-text="value"></span></li></template>
 *       </ul>
 *     </div>
 *   </x-filament::section>
 * </x-filament-widgets::widget>
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
