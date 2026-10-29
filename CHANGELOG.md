# Changelog

All notable changes to this project will be documented in this file.

## v1.34.0 - 2026-10-28

The second documentation release: no runtime, type, test or CI change. Only Markdown files changed.

- Added a manual, `docs/manual/`, in 14 chapters. Each chapter says how to do one thing, step by step. The chapters run from getting started and commands to testing, Laravel, sizes and a quick reference.
- Changed the README to a short entry page: what the library is, how to install it, a first command, and the manual's chapters. The how-to sections it carried are in the manual.
- Changed the prose of every hand-written page to short declarative sentences, one claim each, with its conditions and limits stated. The generated pages (`docs/api/`, `docs/errors.md`, `docs/BUNDLE-SIZES.md`, `docs/COVERAGE.md`) are unchanged. Every `vc:` marker, code block, anchor named by a test, and citation of a whitepaper section is kept.
- Changed where history sits. A page's body now describes the current shape only. How a rule came to be, and the measurement behind it, are footnotes. Longer history is in appendices of the same page.
- Added whitepaper section 15, Limitations: what the library does not do, each with the section that explains it. Core guarantee, File map and References are now sections 16, 17 and 18. Migrate: a link to `#15-core-guarantee`, `#16-file-map` or `#17-references-and-licence` takes the new number.
- Changed whitepaper section 14: the per-change findings and the build profile measurements moved to a new appendix D, and "Still open" is now 14.3.
- Changed ROADMAP.md to the current state. The freeze history, the corrected static-import argument and the released contract rows are appendices A to C. The feature matrix is appendix D.
- Changed the CHANGELOG entries for v1.26.0 and older to one line per change, starting with Added, Fixed, Changed, Improved, Removed, Updated or Security. Their full notes, with each fix's mechanism, measurements and tests, are in `docs/rc-alignment-log.md`, section 37, word for word. Undated entries carry their GitHub release's publish date. v1.17.0 and v1.7.0-Candidate had no release and carry none.
- Added to the manual what only the old CHANGELOG notes said and the v1.33.0 source still does, chapter by chapter below.
- Added to manual chapter 2: the buffer's options, matching a failure on its `code`, and letting a language model or an MCP client call commands.
- Added to manual chapter 3: logger levels, reaction loops, and validation with Zod, Valibot or ArkType.
- Added to manual chapter 4: the offline outbox, request headers from a plugin, the response a reply arrived in, `resolveNotModified` and a response's final `url`.
- Added to manual chapter 5: `useCommandQuery`, two forms on one bus, and a Vapor directive's argument getter.
- Added to manual chapter 6: route rows, typed params, the 404 row and navigation guards.
- Added to manual chapter 8: the browsers the IIFE bundles support.
- Added two limitations to whitepaper section 15. A vDOM `<Transition mode="out-in">` with the transition bridge needs an async bus (vuejs/core#15727). A dispatch an async undo handler makes after an `await` is recorded in history.
- Fixed whitepaper section 3.5 to state the cited study's findings in the study's own words.
- Changed two docs/router.md headings to "an HTTP client" and "Menus and breadcrumbs". Migrate: a link to `#menus--breadcrumbs-projected-never-authored-twice` becomes `#menus-and-breadcrumbs-projected-never-authored-twice`.

## v1.33.0 - 2026-10-27

A documentation and CI release: no runtime or type change. Every `dist/*.min.js` is byte-identical to v1.32.0, and the unminified files differ only in comment text. One test change, the git-history guard below.

- Fixed the docs that still described the pre-v1.32.0 plugin chain (`onBefore`, `core:refused:hook`, priority order, `(cmd, next, fail)` plugins, `buildRunner`): whitepaper sections 4, 5, 6 and 7 now describe `PluginParts` (`started`, `authorize`, `validate`, `reuse`, `admit`, `begin`, `settled`) and that `use()` refuses a function plugin. The removed passages are kept in whitepaper appendix C.
- Fixed names of removed or renamed API still quoted as current in README, CONTRIBUTING, SECURITY, ROADMAP, the store, router, performance, contract and Laravel guides: `persist`, `useCommandState`, `localStorageOutbox`, `createHttpBridge`, `createWsBridge`, `onMissing: 'buffer'` (it is the `buffer` option), `liveLanded`, the `coalesce` option of the removed `persist` plugin, the removed `optimistic` plugin (a store's `coalesce` option, the `optimistic` register option and `v-vc-optimistic` are current), and a WebSocket frame with no id (it is the server's push, not ignored).
- Fixed source comments that contradicted the code they sit on, which also corrects the generated `docs/api/`: `CommandMeta.origin` is stamped `'undo'` and `'redo'` by the core; `form.submit()` also answers `false` after a reset during validation or while a submit is in flight; `busToMcpTools` adds `target` and `payload` only when the action declares them, and refuses a non-object payload; `createTestBus` runs a registered handler only with `passthroughHandlers: true`; `registeredActions` lists only actions with a compiled handler; `defineWidget` also answers `false` with no `customElements`; the router's `locales` match is case-insensitive; `revalidateRoutes` reports a failure through `router:failed:revalidate`; the Vapor outlet's peer range is `>=3.5.0 || >=3.6.0-rc.13`; a transition `timeout` is also clamped at its maximum; the schema plugin's `'warn'` reports rather than logs.
- Fixed script headers and the CI workflow to state what each guard checks and what it does not: `check-size` fails on raw or brotli; `check-line-citations` reads test titles only; `check-doc-claims`, `check-ascii` and `stamp-docs` name the directories and extensions they walk; the `build.mjs` header names the `lib.entry` map as the source of the library entries; the `gate` header says its last step, `clean tree`, follows ten steps; the browser tests run on every push and pull request. The pull request template lists what CI runs, including `test:vapor`, the `docs/api` diff and the browser tests. The bug report template points security reports at SECURITY.md.
- Changed `engines.node` from `>=24.5.0` to `^24.5.0`, in the package and in `examples/exo-astro`: CI runs every job on Node 24 and no other major is tested, so the range now says what is supported. The README and CONTRIBUTING say the same, and CONTRIBUTING names npm 11, which Node 24 ships, in place of npm 10. The CI test job dropped its one-value Node matrix dimension, and the jobs were renamed: the Linux job is `check (Node 24, ubuntu)` and the macOS job is `test (Node 24, macos)`. A branch protection rule that requires the old check names must be updated to these.
- Changed the CI workflow so each check runs once per event. One `check` job runs on Linux: typecheck, the guards (`lint:check`), the generated docs diff (now over `docs/api`, `docs/errors.md`, `contract/` and the PHP fixture, where only `docs/api` was diffed), the build, the suite under coverage, the Vapor project, the size budgets and the LOC report. The local gate runs these in a different order and adds the `docs/BUNDLE-SIZES.md` diff and the clean-tree assertion, which CI does not run. The coverage floors now gate a pull request; before, CI ran them only in the post-merge auto-update step, which also ran the suite a second time. The macOS job runs the build, both test projects and the size budgets after `check` is green, so a change red on Linux costs no macOS minutes and nothing runs twice on the slowest runner. `bench` runs on a push to main and on demand, off the pull request path. Per push to main: six installs where there were eight, six builds, each the `prepare` build of an install, where there were eleven (eight `prepare` builds and three explicit `npm run build` steps; eight where there were thirteen, counting the two builds `perf-ab` makes), two suite runs where there were three.
- Fixed the suite failing three tests from an unpacked archive: `ab-ci` and `verify-contract-against` read this repository's `HEAD`, which a download has no way to produce. They now skip without history, by the capability rule the esbuild guard already follows (`tests/require-git.ts`). Of the scripts they drive, only `scripts/ab/base-ok.sh` is also asserted against a throwaway repository; from an archive, `scripts/verify-contract.mjs --against` is untested. A clone, and CI, run all of them as before.
- Removed release and version history from comments and docs (it belongs here), session and log citations that pointed at files or sections that no longer exist, and prose that restated the next line of code or the paragraph above it. Measured figures, declined alternatives, guard scopes and `MEASURED:` notes are unchanged.

## v1.32.0 - 2026-10-24

- Fixed `form.aria(field)` dropping an input's own `aria-describedby`: spread on an input that names a hint, it removed the hint, or the hint hid the error's id, in both renderers. `form.aria(field, 'hint-id')` names the hint, then the error's id while the error shows. Pass a static hint id as that argument. Fixed `form.aria()` and `firstInvalid()` never updating a render: they read the form's plain state, and now read its reactive fields.
- Fixed the documented app-wide Vapor registration, `createVaporApp(App).directive('vc-command', vcCommandVapor)`, which failed the type check: Vue's `App.directive()` takes no Vapor directive. `createVaporChamberApp()` now returns a typed `VaporChamberApp`, in place of `any`, whose `directive()` takes the Vapor directives, also after `use()`. Changed: `createVaporChamberApp` leaves the root, `vapor-chamber`, which cannot name Vue's types: change the import from `'vapor-chamber'` to `'vapor-chamber/vapor'`, which also carries the bus, plugins and composables. A page with no bundler that wires Vue by `configureVue(Vue)` calls `Vue.createVaporApp(App)`.
- Fixed an action losing its handler when two components register it and the newer one unmounts first: `dispatch` answered `core:missing:handler` while the older component was still on screen, with nothing in production. The action now runs the newest registration still live, with its own undo, `answer`, cache groups and `exclusive`, and the older one's come back with it. A newer registration no longer runs under the older one's undo. Two components registering one function no longer remove each other's handler. `defineVaporCommand` follows KeepAlive as `useCommand` does: the page on screen answers.
- Fixed no way to wait for a store's starting state. On an async storage such as `indexedDbStorage()`, or in a tab opened beside another tab of a shared store, the store holds `state()` until the read lands or the other tab answers. A wait on `$onField` never ended when nothing was saved or the saved state equalled the default, and an "is it empty" check run on `state()` added its items again over the saved or shared cart. `await store.$ready` resolves once the store holds the state it starts from (the saved state read, the tabs' state taken, or both), and at once for a store with neither. `$ready` is a store member: an action of that name is refused.
- Fixed a store's actions and `$reset()` typed `CommandResult | Promise<CommandResult>` on every bus: on a sync bus `cart.add(x).ok` failed the type check, though the call never returns a promise. They are now `CommandResult` on a sync bus, `Promise<CommandResult>` on an async bus and either on a bus typed only `BaseBus`. Remove casts made for it.
- Fixed `VaporChamber.mount(selector, options)`: its `state` came back as given and nothing read or wrote it, and the element was never bound. The island's state is now its stores: `stores: { name: defineChamberStore(id, options) }` creates each on the island's bus, the element's `data-vc-command` and display attributes are bound, and the result carries the stores under their names and `unmount()`, which unbinds the element and disposes the stores. A selector that matches nothing warns `mount:missing:element` in development. `state` is removed from the options and the result: move a plain object into a store whose `state()` returns it.
- Fixed a store with `answer` behind `httpTransport` when the server answers a 202: the store held the `Accepted` object as its state, and the job's final state never reached it. The `answer` and the reply's `stores` are now written when the `Accepted`'s `done` settles ok, with its value. A bus with no `answer` for the action and no store follows nothing until the app reads `done`.
- Fixed the package in an app with no `vue` installed: a Vite dev server answered 500 for it, even for an app using only the bus, and webpack failed with "Can't resolve 'vue'" for an app using `signal` or a composable. The root no longer names Vue to any bundler.
- Changed a Vue app that imports its composables from the root: on a Vite dev server without `vaporChamberHMR()`, and in an esbuild or webpack build, the runtime lookup finds no Vue, and the app gets `vue:missing:wiring`, as a Vite production build already did. Migrate: import the composables from `vapor-chamber/vue` (or `/vapor`), add `vaporChamberWire()`, or call `configureVue(Vue)`.
- Fixed a form and history's `undoAction` and `redoAction` on an async bus whose transport covers their actions, such as `'*'`: their commands went to the server, so the form never changed and undo was never pressed. They now run locally under any transport.
- Changed `register()` on an async bus or a test bus: a handler for an action a transport sends never ran, with no signal. It is now refused with `core:invalid:handler`, unless it is `optimistic` (the change shown) or the transport declares `localFallback`. Migrate a handler kept only for its options to `register(action, null, { answer, exclusive, undo, cacheGroups })`.
- Added `register(action, null, options)` on the async bus and the test bus: a sent action's options with no handler. `null` on an action no transport sends is refused, and so is `optimistic` with `null` (`core:invalid:option`).
- Added `defineTransport(send, { localFallback: true })` and `Transport.localFallback`: a transport whose `send` calls `local()` declares it, and only then may its actions have a handler. Migrate a `defineTransport` that calls `local()` by adding the option.
- Changed a store's reducer for an action a transport sends: it is `null` (`reducers: { add: null }`), which keeps `cart.add()` and takes the state from `answer` or the server's `stores`. A function there is refused at `useStore(bus)` unless the store is `optimistic`. Migrate a reducer written only to get the method, such as `add: (s) => s`, to `null`.
- Fixed an offline command lost across tabs: two tabs holding commands at the same moment both keep them, and neither caller hears `outbox:aborted:clear`. A `clear()` in any tab still drops every tab's records.
- Changed the outbox's `maxSize` to bound each tab's own records: the queue the tabs share holds at most `maxSize` per tab.
- Fixed an outbox record sent twice across tabs: a record one tab sent could come back in another tab's queue written before the removal reached it, and be sent again.
- Changed a `cacheGroupInvalidation` to listen only once the bus has a group hub (a transport's `httpClient` or `cache()`): a bus with neither keeps its bare dispatch.
- Added `register(action, handler, { cacheGroups, cacheGroupInvalidation })`: a cached result of the action joins `cacheGroups`, and its success makes `cacheGroupInvalidation` stale (an `Accepted` once its `done` settles ok). One group namespace, local or server: a local write reaches `cache()`, the client's stored reads and the router, as a server's `Cache-Group-Invalidation` does.
- Changed `cache()`: it drops the results of the actions in a group that goes, whatever named it: a local write, a transport's answer, the client's own write or `client.invalidateGroups()`. Its parts now list `attach` (`inspectBus().plugins`).
- Changed a transport without an `httpClient`: an answer's `Cache-Group-Invalidation` reaches the bus's `cache()`. Development warns `transport:missing:client` only when nothing on the bus reads the groups.
- Added `transport:conflict:client`, a development warning: two transports of one bus have different `httpClient`s, and the bus's groups reach the first one only.
- Fixed `bus.use(wsTransport(...))` installing the transport as a plugin: `use()` refuses any transport with `core:invalid:plugin`. Declare it at the bus: `createAsyncCommandBus({ transport })`.
- Added `Accepted` to the three IIFEs (`VaporChamber.Accepted`), so a page with no build can test `r.value instanceof Accepted`.
- Added `routerLoading` and `routerRevalidating` to `routerFacts(router, bus)`: a fact with `{ value }` each time `router.isLoading` or `router.isRevalidating` changes.
- Added `data-vc-router="loading"` (or `"revalidating"`) to `bindDisplay`: the element carries `vc-loading` while the router loads (or refreshes the page), as the bus hears it from `routerFacts`. Page markup outside the router's island shows navigation loading with no router import.
- Changed `history().getState()`'s and `useCommandHistory()`'s `past` and `future` to the history's own stacks, typed `readonly Command[]`, in place of copies. Each change writes new arrays, so a stack you hold does not change under you. Migrate: copy one before changing it (`[...past]`).
- Changed the outbox's queue to a store's saved state: `createOutbox({ name?, storage? })` saves it under `name` (default `'vc:outbox'`) in `storage`, a store's `PersistStorage` (default `localStorage`, `null` for this tab's memory). Migrate: `storage: localStorageOutbox(key)` to `name: key`, `storage: indexedDbOutbox()` to `storage: indexedDbStorage()`, a custom `OutboxStorage` (`load`, `save`, `clear`) to `getItem` and `setItem` over the queue's JSON. A queue saved by an earlier release is not read.
- Removed `localStorageOutbox`, `indexedDbOutbox` and the `OutboxStorage` type.
- Changed the outbox in a page: the origin's tabs share one queue, and `pending` counts every tab's records. Each tab sends the records its own callers wait on. When a tab closes, another tab sends its records, with no reload, and their final refusals go to that tab's `rejected`. Each record carries `tab`, the tab that sends it.
- Fixed two tabs on one saved outbox queue each sending a stored record: a record is sent by one tab only.
- Changed `outbox:aborted:clear`: a held command's `done` also settles with it when another tab's `clear()` or `maxSize` drops its record.
- Changed a corrupt saved outbox queue to load as empty with no warning, as a store's saved state does.
- Removed `HttpClient.invalidateCache(pattern)`. Migrate: the server names what a write made stale (`Cache-Group-Invalidation`), a read that must be current passes `cacheMode: 'no-cache'`, and `clearCache()` drops every entry. A write still drops its own URL.
- Removed `cache().invalidate(action, target?)`. Migrate: `clear()`.
- Fixed a `coalesce: true` store shared with `shareTabs()`: one write no longer goes back and forth between the tabs without end.
- Fixed a `coalesce: true` store and `seedStores()`: the store reads its seeded state when it is created, and `storeStates()` reads a write made in the same tick.
- Changed a `coalesce: true` store: a state from outside it (a reply's `stores`, a push, another tab's, a seed) is written at once, after the pending write lands. It no longer chains on the pending write.
- Removed `onBefore` from every bus, the `BeforeHook` and `AsyncBeforeHook` types, the `core:refused:hook` code and `inspectBus().beforeHookCount`. A gate is an `authorize` (or `validate`) rule: it refuses before the work and may be async. A rule runs for a dispatch and a query alike, so scope it to the actions it gates. An observer is a `started` part.
- Removed the plugin chain: `use()` takes a plugin's parts only, and refuses a function `(cmd, next) => result` with `core:invalid:plugin`. Migrate an app plugin to parts: an observer to `started` and `settled`, a refusal to `authorize` or `validate`, a limit to `admit`, a stored answer to `reuse`, work around the send to `begin` and its ticket. A value added to a command is the sender's: add it at the call.
- Removed `use()`'s `priority` option and `inspectBus().pluginPriorities`: no part has a position. `inspectBus().plugins` lists the plugins in install order, without `priority`.
- Removed the `Plugin`, `SyncPlugin`, `AsyncPlugin` and `PluginOptions` types and `buildRunner`: a plugin is `PluginParts`.
- Removed `wired()` from `vapor-chamber/testing`: install the plugin on `createTestBus()`.
- Changed `plugin:failed:plugin`: `context.part` names the part that threw, in place of `context.index`.
- Changed `revalidateRoutes()` to a parts object (`attach`, `dispose`, `isRevalidating`): `bus.use(revalidateRoutes(...))` is unchanged.
- Changed `cache`, `idempotent`, `rateLimit`, `circuitBreaker` and `supersede` to steps of the work, run in one order whatever the install order: a stored answer, then the limits, then the send. A cached read or an idempotent repeat spends no `rateLimit` slot, a `rateLimit` refusal is no failure to `circuitBreaker`, and a refused command never aborts the one in flight under `supersede`. They are parts objects: install them with `bus.use()`, never call them.
- Added the step parts `reuse(cmd)`, `admit(cmd, fail)` and `begin(cmd)`, with its `WorkTicket` (`signal`, `landed`, `answer`), for an app's own plugin.
- Fixed the sync bus's `request()` to a responder skipping the action's rules: a `validator` or `authGuard` refusal now answers before the responder runs, as on the async bus.
- Added `configureReport({ format, sinks, level })`, `consoleSink` and `formatReport`: every warning and error the library detects and does not return is a report with its code, formatted once and handed to every sink. `level` sets the floor: `'warn'` (the default), `'error'` or `'silent'`. `configureReport(null)` restores the defaults.
- Changed the console output of those warnings and errors: each line is `[vapor-chamber] [ WARN ] <code>: <message>` (`[ FAIL ]` for an error), and development adds a `docs:` line linking the code's section of docs/errors.md. A listener's throw now prints `[vapor-chamber] [ FAIL ] core:failed:listener: a listener threw on "cartAdd"` (was `[vapor-chamber] Listener error:`). Match on the code, or read it in a sink.
- Changed `Command`'s `action`, `target`, `payload` and `meta` to `readonly`: a handler, part or listener that assigns one is a type error. Build a new value instead of writing the command. The meta's own fields stay writable.
- Changed `use()` to refuse a plugin already installed on the bus with `core:invalid:plugin`: its parts would run twice. Take it out with the function `use()` returned first, or install a new instance.
- Added a development warning when two installed plugins share an `id`: their failures carry one owner.
- Added `parts` to each `inspectBus().plugins` entry: the parts the plugin declares, in the order the bus runs them.
- Fixed a plugin's `authorize` and `validate` rules running on every action: they now run only on the actions its `actions` and `actionFilter` cover, as its other parts do.
- Added a `started(cmd)` plugin part: a plugin hears each dispatch and query start, before its rules, on the actions its scope covers.
- Changed `metrics()` to a parts object (`started`, `settled`). It now also records a rule's refusal and a command aborted before it started (0 ms). It is no longer a chain function.
- Changed the place of a plugin's `settled` part: it runs after the app's `onAfter` hooks, before the listeners. A throw in it is logged with the plugin's id.
- Changed `authGuard`'s `protected`: a bare name now guards that action only. Write `admin*` to guard every action that starts with admin.
- Removed the `filter` option of `logger()`, `history()`, `useCommandHistory()` and `useCommandError()`. They take `actions` and `actionFilter`, as `metrics` and `cache` do. Migrate:
  - `filter: (cmd) => cmd.action.startsWith('cart')` to `actions: ['cart*']`.
  - `filter: (cmd) => cmd.action === 'cartAdd'` to `actions: ['cartAdd']`.
  - Any other test of the action name to `actionFilter: (action) => ...`, or `createActionFilter`. A filter that read the command's `target` or `payload` has no replacement: scope by the name and decide in your own listener.
- Changed `validator`, `authGuard`, `schemaValidator`, `validateSchemas` and `validateSchemasAsync` to rules of the action, run before every plugin and the work. They are still installed with `bus.use()`, but they return a parts object, not a function, so never call one. A refused command now never reaches `rateLimit`, `circuitBreaker`, `cache`, `idempotent`, the retry or the transport. `rateLimit` takes no slot for it and `circuitBreaker` counts no failure.
- Changed the order of refusals: every `authGuard` rule answers before every validator, whatever the install order.
- Changed a refused `register(..., { optimistic: true })` command: it answers the refusal, not an `Accepted`, and its change is never shown.
- Changed a refused `register(..., { exclusive })` command: it takes no turn.
- Changed a rule's throw or rejection: it answers `<plugin id>:failed:plugin` once, from the rule's own plugin. It is not re-sent.
- Changed a plugin of your own that sat outside a validator to see the refusal: it no longer sees it. Listen with `onAfter` or `on('*')`, which hear every outcome. `metrics` does not count a rule's refusal.
- Changed `logger()` and `schemaLogger()` to read the settled result. They log every outcome in any install order, a validator's refusal included, and hold no chain level.
- Changed the order of nested logs: a dispatch's group prints when it settles, so a nested dispatch's group prints before its parent's.
- Changed a throw inside `logger`'s `actionFilter`: it is logged and the dispatch keeps its result. It was `logger:failed:plugin`.
- Added a plugin made of parts: `bus.use({ settled(cmd, result) {}, actions })` runs `settled` where `onAfter` hooks run, on the actions its scope covers. `use()` refuses an object with no part it places (`core:invalid:plugin`). Migrate: `logger()` and `schemaLogger()` return such an object, so install them with `use()`, never call them.
- Added latest wins to `pace`: a run of an action and target aborts that key's run still in flight (`dispatch(..., { signal })`), so a stale answer settles aborted and never lands after a newer one. `dispose()` aborts what is in flight. A binding treats its own aborted run as silent.
- Added `v-model`'s IME rule to `v-vc-command` and `bindCommands` on a text control: nothing is sent between `compositionstart` and `compositionend`, and the end sends the composed value.
- Changed the signals `vapor-chamber/vapor` hands out to be typed as Vue's `ShallowRef`, which they are at run time: `signal()`, a composable's `pending()`, `useSharedCommandState()`'s and `commandState()`'s. A template unwraps them with no cast. Migrate: drop an `as unknown as ShallowRef` cast. A `configureSignal` backing passed in an app that imports this entry is typed `CreateSignal`, so a plain `{ value }` factory needs `as CreateSignal`.
- Added `defineWidget(tag, component, { when })`: `when` is `load` (the default), `visible` (when the tag's first element enters the viewport, one IntersectionObserver for every widget) or `idle` (`requestIdleCallback`). A component may be a loader, `() => import('./Cart.vue')`, imported at that moment. The other options go to `defineVaporCustomElement`. `defineWidget` and `emitDOMEvent` are exported from `vapor-chamber` too. Migrate: the third argument is that options object; `{ shadowRoot: false }` reads as before.
- Added `bindDisplay(root, { bus })`, from `vapor-chamber` and every IIFE: display bindings on plain HTML over a store of the bus. `data-vc-text="cart.count"` sets the text, `data-vc-show` hides an element unless its value is truthy and not an empty array, `data-vc-each` repeats its `<template>` per entry, each rendered at bind time and on each write of the field. `data-vc-pending="cartAdd"` sets `vc-loading` while that action is in flight on the bus. Returns `unbind()`.
- Added `defineChamberStore` (the core store) and `commandState` to the core and elements IIFEs, so a page defines the stores its display bindings read.
- Added a busy display that waits, as CSS on `vc-loading` (docs/accessibility.md). The library has no option for it.
- Added `bindCommands(root, { bus })`, from `vapor-chamber` and every IIFE: `v-vc-command`'s interaction on plain HTML. Every `[data-vc-command]` under `root` dispatches its action on `bus`, with `data-vc-target`, `data-vc-payload`, `aria-disabled` while in flight, `vc-loading`, `vc-error`, the failure announced and the keyboard for `role="button"`. Returns `unbind()`.
- Added `data-vc-debounce` and `data-vc-throttle` (ms) to `v-vc-command` and `bindCommands`: the element paces itself with `pace`. A call the pace refuses is silent: no `vc-error`, no announce.
- Changed `v-vc-command` on a form control to send on `input`, or on `change` for a select, a checkbox and a radio, as `v-model` chooses, with the control's value (a checkbox's `checked`) as the payload when none is given. It sent on `click`. Migrate: a control that should send on click is a button.
- Removed the `debounce` and `throttle` plugins, `register(action, handler, { throttle })`, `inspectBus().activeTimers` and the `ActionList` type. Pacing is the sender's: the bus no longer paces. Migrate:
  - `bus.use(debounce(['searchQuery'], 300))` to `const search = pace(bus.dispatch, { debounce: 300 })`, or `useCommand({ debounce: 300 })`. A paced call returns a promise of the real result of the run that happened. An earlier call of the burst answers `pace:aborted:dispatch` and never reaches the bus.
  - Pass what changes on each call, such as the typed text, as the payload. Calls are keyed by action and target, so text in the target makes a key per keystroke and nothing coalesces. The realtime-search example moves its text from the target to the payload.
  - `bus.use(throttle(['uiScroll'], 100))` and `register(action, handler, { throttle: 100 })` to `pace(bus.dispatch, { throttle: 100 })`, or `defineVaporCommand(action, handler, { throttle: 100 })`. A repeat inside the wait answers `pace:limited:dispatch` in place of `throttle:limited:handler` or `core:limited:handler`, with `context.retryIn` and `wait`.
- Added `pace(send, { debounce } | { throttle })`, from `vapor-chamber` and every IIFE: a dispatch paced at the sender, keyed by action and target. A `$` action runs at once. `useCommand` and `defineVaporCommand` take the same two options.
- Removed `loading` and `lastError` from `useCommand()` and `useVaporAsyncCommand()`, and `lastError` from `useCommandQuery()`. Both composables gain `pending(action, target?)`, the bus's command state for that key, released with the composable. Migrate:
  - `cmd.loading` to `cmd.pending(action, target)` for the key the button dispatches. Two buttons on one composable now go busy apart.
  - `cmd.lastError` to the dispatch's own result (`result.ok`, `result.error`), or to `useSharedCommandState().errors` filtered by action.
- Added `commandState(bus, { maxSize })`: what is in flight on a bus and what failed, with Vue or without. It gives `pending(action, target?)`, `anyPending`, `errors`, `lastError`, `clear()`, `subscribe(fn)` and `dispose()`. The full IIFE carries it as `VaporChamber.commandState`.
- Changed `useSharedCommandState()` to return `commandState` for the component's bus, released with its scope. Migrate:
  - `isLoading(action, target)` to `pending(action, target)`.
  - `isAnyLoading` to `anyPending`. It now counts every command in flight on the bus, not only those sent through its own `dispatch`.
  - `dispatch` and `inFlight` are removed. Dispatch through the bus or `useCommand`, and read `anyPending`.
  - `errorCount` is removed. Read `errors.value.length`.
- Changed the command state to listen to the bus itself, never to its hooks or listeners. A sealed bus is no longer unsealed for it, and `inspectBus` counts no hook or listener for it. A listener now reads its own command as settled. A subscriber that throws on a command-state write is logged, and the dispatch runs.
- Changed `commandState` and `useSharedCommandState` to refuse a bus this library did not make, with `core:invalid:bus`. Migrate: pass a bus from `createCommandBus()`, `createAsyncCommandBus()` or `createTestBus()`.
- Removed the `optimistic`, `optimisticUndo` and `serialize` plugins, and the types `OptimisticUndoOptions` and `SerializeOptions`. Migrate:
  - `bus.use(optimisticUndo(bus, ['cartAdd'], opts))` to `register('cartAdd', handler, { undo, optimistic: true })`. The caller reads `value.done` in place of `predict`'s value, and `done`'s failure in place of `onRollback`. A failing undo is logged as before.
  - `bus.use(optimistic({ cartAdd: { apply } }))` to the same option: the handler makes the change, and `undo` takes it back.
  - `bus.use(serialize({ key, scope, lockPrefix }))` to `register(action, handler, { exclusive: { key, scope, lockPrefix } })` on each action it ordered. A Web Lock is now named `vapor-chamber:exclusive:<key>`.
  - A `serialize` lane keyed to a store goes to the store's `exclusive: true`.
- Added the store options `optimistic` and `exclusive`. With `optimistic: true` a store action a transport sends applies its reducer at once: a failure rolls it back (the later steps rebased), the answer replaces it, and a plugin's refusal never shows it. The dispatch answers an `Accepted`. History undoes it only when the store also declares `undo`, and `coalesce` refuses it. With `exclusive: true` the store's sent actions go one at a time, in order, reads included, and its local actions run at once.
- Added `register(action, handler, { exclusive: { key?, scope?, lockPrefix? } })`. Commands with one key never overlap: one at a time, first in first out. The turn is taken at dispatch and held for the work and every retry, so a retried command keeps its turn, and the plugins run at once, so a refused command never waits. A failure never stalls the key. `key` defaults to the action, several actions may share one, and `null` runs a command at once. `scope: 'cross-tab'` holds the key across every tab of the origin through Web Locks, and on this bus where the API is absent. A query of the action waits for its key too. A sync handler already runs to its end before the next.
- Added `register(action, handler, { undo, optimistic: true })`. On the async bus the dispatch answers an `Accepted` at once, whose `done` settles with the result, and listeners, after-hooks and history hear that result when it lands. For an action a transport sends, the handler is the change shown: it runs when the plugins hand on, before an `exclusive` turn is waited for, and is the transport's local fallback, never run twice. A failure of the work runs the action's undo first. A plugin's refusal runs nothing, so nothing is shown or undone. On the sync bus and the test bus, a throw runs the undo and the failure returns. Without `undo` it is refused at register with `core:invalid:option`.
- Fixed a hot update (development, `vaporChamberHMR`) matching a store's state to its edited `state()` at the top level only: a key an edit added inside a nested object was `undefined` until a reload. Every level of plain objects now matches. A key the edit adds gets its declared value, a key the edit removes goes, and a key the app added at runtime stays, so a dictionary declared `{}` keeps its entries. Before, an edit emptied a store whose whole state was such a dictionary. Production is unchanged.
- Added `liveStores(bus)` (from `vapor-chamber` and `vapor-chamber/ssr`): the stores in use on a bus, in the order they were created, as a new array, so a loop may dispose or create stores. A disposed store and a seeded id with no store are left out. Nothing else pays for it.
- Fixed an `undo: true` store in development applying twice a reducer that changes its state in place and returns it: development held `[1, 1, 2, 2]` where production held `[1, 2]`. The development double run now skips its second run when a reducer returns the state it was given. Production is unchanged.
- Fixed a redo applying twice a command a handler dispatched. A handler that passes `__causationId: cmd.meta.id` on its child now has the child undone with it, and a redo applies it once. A child that declares nothing is its own step, as before.
- Fixed a refused undo or redo putting its step back on top of its stack: it goes back where it was, so the next press reads the order the commands ran in.
- Changed the outbox to a bus option: `createAsyncCommandBus({ transport, outbox: createOutbox({ ... }) })`. It holds the commands it covers at the work step, below every plugin, so it has no install order. A held command answers `{ ok: true, value }` with `value` an `Accepted`, whose `done` settles with the replay's result. Migrate `outbox.install(bus)` and `bus.use(outbox.plugin)` to the option, `value.queued` to `value instanceof Accepted`, `flush(bus)` to `flush()`, and drop `hydrate()`: the stored queue loads when the outbox is created.
- Changed the outbox's events: `outboxQueued`, `outboxRejected` and `outboxFlushed` are gone. A held caller hears its refusal in `done`. A stored record's final refusal goes to `outbox.rejected`. `flush()` returns the summary.
- Changed an outbox replay: it is sent through its action's transport, not dispatched. No plugin or listener sees it, and `idempotent` cannot answer it from memory. A store's `answer` and a reply's `stores` still apply.
- Changed the outbox to hold only an action that has a transport: a local handler runs offline as online. Migrate a local handler that calls the server itself to `defineTransport(send)`, and the outbox holds it.
- Changed the outbox's online check: `navigator.onLine` is read once, then the window's `online` and `offline` events keep it. An `isOnline` option is still read on every send.
- Added `outbox:exceeded:queue` and `outbox:aborted:clear`: a held caller's `done` settles with them when `maxSize` drops its record or `clear()` empties the queue.
- Changed `history`: a command answered with an `Accepted` (held by the outbox, or a 202) is not recorded. Before, an undo of a held command ran its inverse locally for a write the server never got.
- Changed buffering to a bus option: `createCommandBus({ buffer: createBuffer({ maxSize, ttl, onDrop }) })`, on either bus. Migrate `onMissing: 'buffer'` to `buffer: createBuffer()`, `maxBufferSize` to `maxSize`, `bufferTTL` to `ttl` and `onBufferOverflow` to `onDrop`.
- Changed a buffered dispatch's answer: `{ ok: true, value }` with `value` an `Accepted`, whose `done` settles with the handler's result once it registers. Before, the answer was `{ ok: true, value: undefined }` and the result was lost. `buffer.pending` counts the held commands.
- Added `buffer:exceeded:queue`, `buffer:timeout:queue` and `buffer:aborted:clear`: a held caller's `done` settles with them when `maxSize` or `ttl` drops its command, or when the bus is cleared or disposed. Before, the caller heard nothing.
- Changed `wsTransport` while its socket is down: a dispatch answers `{ ok: true, value }` with `value` an `Accepted`, whose `done` settles with the reply once the socket opens and the command is sent. The transport's own outbox, `ws.outbox`, holds the commands in memory: 100 at most, each for at most `timeout`. `disconnect()` and a close with no reconnect left settle them with `outbox:aborted:clear`. Migrate `maxQueueSize` (gone) to an app outbox with its own `maxSize`, code that read the dispatch's result while down to `value.done`, `transport:lost:command` to `outbox:exceeded:queue`, and a held command's `transport:timeout:reply` to `outbox:timeout:queue`.
- Changed the outbox to hold a WebSocket action while its socket is down, not only while the browser is offline, and to flush when the socket opens. With `storage`, those commands survive a reload.
- Added `createOutbox({ ttl })`: a command held this session longer than `ttl` ms is dropped, and its caller's `done` settles with `outbox:timeout:queue`.
- Added `Transport.isConnected()`: an app transport that can be unable to send declares it, and an outbox over it holds its commands while it answers false. Added `transport:limited:socket`: a send while the socket is not open is refused unsent, and the outbox keeps it.
- Fixed `outbox.clear()` during a flush. The command being sent had its caller told it was dropped before it was sent, and a command held after the clear was removed when that send landed: never sent, its `done` never settled. The command being sent now settles with its send's answer, and the commands held after stay.
- Changed undo and redo: one undo reverses a command and the recorded commands it caused, such as a reaction's follow-up, and one redo replays them. Before, each was its own step. `undo()` and `redo()` return the command the user dispatched.
- Fixed a redo running a reaction's follow-up again: it applied twice on the sync bus and emptied the redo stack on the async bus. A reaction no longer runs on an undo (a `cart*` pattern matched `cartAdd$undo`), a redo or a mirrored command (origin `'sync'`), the origins history does not record.
- Changed `history()`: it records the bus's commands itself, from the call on, and is no longer a plugin. `bus` is required. It records what the caller got, wherever plugins sit; before, a plugin installed outside it that answered in place of the handler was not recorded. It installs on a sealed bus, as `useCommandHistory` does. Migrate `bus.use(history({ bus }))` to `history({ bus })`.
- Changed how a backend is reached: the transport is declared at the async bus, `createAsyncCommandBus({ transport })`, one for every action or a map by action pattern (an exact name, then the longest prefix, then `*`). It is the work for the actions it covers, where a local handler would run. `createHttpBridge`, `createBatchingHttpBridge` and `createWsBridge` are now `httpTransport`, `httpTransport({ batch: { window } })` and `wsTransport`. Their `actions` and `actionFilter` are the map's patterns. Migrate `bus.use(createHttpBridge({ endpoint, actions: ['cart*'] }))` to `createAsyncCommandBus({ transport: { 'cart*': httpTransport({ endpoint }) } })`.
- Fixed a plugin installed after a bridge never seeing the commands the bridge sent: with the transport declared at the bus, `logger`, `history`, `validator`, `cache`, `idempotent` and every other built-in behave the same on a sent command as on a local one, wherever they are installed.
- Added `defineTransport(send)` for an app's own transport: `send(cmd, local)` answers the command, and `local()` runs the action's local handler as its fallback.
- Changed a transport's throw to `transport:failed:send` (it was `transport:failed:plugin`). It is never re-sent. A transport that answers with `local()` is re-sent whole.
- Changed `inspectBus()`: `transports` lists each pattern and its transport's id, and a `plugins` entry no longer has `transport`.
- Added `transport` to `createTestBus()`: a covered action is sent, by the bus's own rule, and its dispatch answers a Promise.
- Changed the IIFE bundles: `VaporChamber.http` and `VaporChamber.ws` are `VaporChamber.httpTransport` and `VaporChamber.wsTransport`, and `createApp({ transport })` takes a map too.
- Changed `bus.dispose()` to dispose its transports: a `wsTransport` disconnects.
- Changed the HTTP transport to send `Accept: application/json, application/problem+json` in place of `X-Requested-With`. Laravel still answers JSON. A cross-origin backend can drop `X-Requested-With` from its CORS allowlist unless it serves the HTTP client's reads, which keep sending it.
- Changed where a command's idempotency key travels: only as `Idempotency-Key`, the header on a single request and that name in a batched command's or a WebSocket frame's `headers` member. The body's `meta` no longer carries it. Migrate a backend that read `meta.idempotencyKey` to read the header, or the batched command's `headers`, as the example controller does.
- Changed the `Idempotency-Key` the library sends to an opaque id, never command content: `idempotent()` sends the dispatch's `meta.id`, the outbox its record's id.
- Changed what a backend sees for the same command sent again after a reload, in another tab or past `idempotent`'s `ttl`: a new key, so it runs again. Inside one bus's `ttl`, `idempotent()` still collapses identical commands by their content. A re-send of one dispatch keeps its key.
- Changed `meta.idempotencyKey` to hold that id, or an app's own `key` as given. Migrate code that read it as `action:target` to read `cmd.action` and `cmd.target`. An app's key of letters, digits, `-`, `_`, `.` and `~` goes out as it is. Any other is percent-encoded on every send, about 110 ns a command.
- Fixed an outbox replay sent under `idempotent()`'s key when `idempotent` was installed inside the outbox: the record's key wins wherever `idempotent` is installed.
- Changed a batched result and a WebSocket frame to stand for their own response with `status` beside `headers`: a problem with no status of its own reads the result's.
- Changed a 202 with a `Location`: the dispatch answers `{ ok: true, value }` with `value` an `Accepted`, whose `done` polls the status monitor, waiting each declared wait, and settles with the job's end. Nothing is polled until `done` is read. `pollWith` and its `<action>$done` event are removed. Migrate `bus.use(pollWith({ bus, interval, maxWait, httpClient }))` and `bus.on('reportExport$done', (e) => e.target.result)` to `httpTransport({ endpoint, poll: { interval, maxWait }, httpClient })` and `if (r.value instanceof Accepted) await r.value.done`. A listener reads the same from `bus.on('reportExport', (cmd, r) => ...)`.
- Changed the failure past `maxWait` from `pollWith:timeout:job` to `transport:timeout:job`, and `isRetryableCode` reads it as false: dispatching again starts the job again.
- Changed an abort of the dispatch's signal, and `bus.dispose()`, to settle `done` aborted. `pollWith` stopped with no event.
- Changed a poll to carry the transport's `headers` and call its `onSessionExpired`.
- Fixed a monitor answering a body that is not JSON, such as a sign-in page, ending the job as a success with no value. It ends as `remote:unexpected:json`.
- Fixed a batched 202 never being followed: a batched result's own status and `Location` are read, as a single response's.
- Changed the example `ProcessCheckout` action to answer 202 with its status monitor in place of a 200 with `status: 'queued'`. Copy it again.
- Changed the HTTP client's `retry`, and `postCommand`'s, from a count of re-sends to the async bus's bound: `retry: { maxAttempts }`, attempts in total, 3 by default, or `false`. A GET is re-sent by default as before, a write is not, and `retry: {}` turns a write on. Migrate `retry: 0` to `retry: false` and `retry: n` to `retry: { maxAttempts: n + 1 }`.
- Changed the router's `http` option to serve every request the router makes: `fetchLoaders()` and `bladeFetcher()` read through it unless given their own `http`, so a write through the app's client reaches a loader's cached read. Their requests carry that client's headers, and `bladeFetcher()` marks it with `X-Vapor-Router`. With no client anywhere, each builds its own as before.
- Added `routerHttp({ http })`: the app's own client marked as router traffic, sharing its cache, its reads in flight and its interceptors.
- Added `LoaderContext.http` and a second argument to `fetchBlade`: the router's client, undefined when it has none.
- Fixed `fetchLoaders({ headers, http })` dropping `headers`: they go on every loader request, through any client.
- Added the hold: after a 429 or 503 that declares a wait (`Retry-After`, a `RateLimit` field with no quota left, `X-RateLimit-Reset`), `httpTransport` and `wsTransport` send no command for that action until the wait ends. Each fails at once, unsent, as `transport:limited:held` with the time left in `retryIn`. The bus's retry waits it and sends the command then, as it waits a 429's. `maxDelay`, `retry: false` and the outbox read it as they read a 429. Other actions, and the same action on another transport, are sent as before. Migrate code that matched a rate limit by `remote:limited:<code>` to `conditionOf(error) === 'limited'`.
- Added the push: a server's event is applied without a dispatch, so no plugin runs and no transport sends it back. Each store state under its data's `stores` is written to the store with that id, on any bus, then the event is emitted on the bus by its name.
- Added it to `createSseBridge`: without `onEvent`, each event is a push, its `data` read as JSON. `events` lists the event types read, since Laravel's `eventStream()` names every event (`update` by default). Data that is not JSON, such as Laravel's closing `</stream>`, is ignored. `onEvent` works as before.
- Added it to `wsTransport`: a frame with no `id`, `{ event, data }`, is a push to the bus that declares the transport. A frame with an `id` is a reply, as before.
- Changed `createEchoBridge` without `onBroadcast` to write the store states under a broadcast payload's `stores` before it emits the payload as before. Migrate a payload that carries a `stores` member of its own by renaming it, or pass `onBroadcast`.
- Added `attach(bus)` to `Transport`: the bus gives each transport it declares itself, once, at its creation.
- Fixed the transports examples dispatching a server push, which on a bus whose transport covers the action sent it back to the server. They use the push.
- Changed the example Laravel controller: it reads the key from `Idempotency-Key`, and every batched result carries its `status` and `headers`. Copy it again with the client.
- Fixed the example Laravel controller dropping the `type` and `title` of an exception's rendered problem. They are kept, as docs/contract.md says.
- Fixed the example `CancelOrder` action answering a guest 403, which the outbox drops as a verdict. A guest gets 401, kept for after sign-in.
- Fixed docs/integrations/laravel.md naming `useOriginOnly()` without its answer: Laravel refuses a cross-origin write with 403, not 419, so no token refresh helps.
- Added cache groups (RFC 9875) to the HTTP client: a write's answer naming groups in `Cache-Group-Invalidation` drops the cached reads whose `Cache-Groups` names one, and `onInvalidateGroup(listener)` hears each group. `invalidateGroups(groups)` does it by hand. A read on the wire at that moment is not stored.
- Added `httpClient` to `wsTransport`. `httpTransport` and `wsTransport` given the app's client pass a batched result's or a frame's `Cache-Group-Invalidation` to it. Without a client, development warns once when an answer names groups.
- Added the router's refresh by cache group: a loader read's `Cache-Groups` reaches the router through `LoaderContext.cacheGroups`, which `fetchLoaders()` calls, and a group its client invalidates refreshes the records on screen in it. `router.isRevalidating` is true meanwhile. Give the transport the router's client.
- Changed a stale cached read's refresh: with a stored `ETag`, it asks `If-None-Match`, and a 304 keeps the copy, the same data object, for a new window. The router writes no snapshot for it, so nothing re-renders. Cross-origin, allow `If-None-Match` and expose `ETag`.
- Changed the HTTP client's cache to keep no response that says `Cache-Control: no-store`, and to drop the copy a refresh answered so.
- Added `cacheMode` to a client request: Fetch's cache mode, for the browser's cache and the client's own store alike. `'no-cache'` asks the server before a stored copy is used, `'reload'` reads past it, `'no-store'` neither reads nor stores. A loader's refresh reads with `'no-cache'`.
- Changed `revalidateRoutes` to listen to settled results, one bus listener per pattern, instead of wrapping each dispatch. An action two patterns match now refreshes both targets. It refreshed the first key's only. Migrate a map with overlapping patterns by removing the overlap where the first key alone was meant. An `Accepted` answer refreshes when its `done` settles ok.
- Fixed `bus.use(revalidateRoutes(...))` failing to type-check without a cast.
- Added `attach(bus)` to a plugin's parts: `use()` calls it once with the bus, and the function `use()` returns runs what it returned.
- Changed the example Laravel controller to answer an action's `CACHE_GROUP_INVALIDATION` groups as `Cache-Group-Invalidation`, per result on the batch endpoint. The example routes add a read with `ETag` and `Cache-Groups`. Copy them again.
- Changed the bundle sizes: every entry's 1.32 size is in docs/BUNDLE-SIZES.md. Most of the growth over 1.31 in a bundle that sends over HTTP is `httpTransport`'s `batch` and its following of a 202, then the hold and the push. `vapor-chamber/router/remote` and `vapor-chamber/router-fetch` grow a little for the one client.
- Changed the Laravel demo's `examples/laravel-app/setup.sh`: the skeleton's `AGENTS.md` and `CLAUDE.md`, when they carry the Laravel Boost guidelines (which ask a coding agent to install Boost, and PHP through an installer in the user's home), are replaced by a note scoped to the demo. Files of your own are left as they are.
- Fixed `commandKey` giving a target that holds NaN or Infinity the key of one that holds null, so `idempotent`, `cache` and `supersede` could collapse two different commands. Each keys apart now, and the same NaN target twice keeps one key. A function or symbol target no longer shares the key of an `undefined` target, and a Number, String, Boolean or BigInt object inside a target keys as its value, as JSON sends it, not as `{}`. A wrapper object that also carries fields of its own still keys by those fields.
- Fixed a bridged command's failure, and the HTTP client's, carrying only `Retry-After` as its wait (`context.retryIn`). A 429 with only a `RateLimit` field or `X-RateLimit-Reset` was re-sent by the bus after its own backoff, inside the server's window. The failure now carries the wait the docs name, the bus waits it, or returns the failure when it is over `maxDelay`, and the outbox keeps the record and flushes after it. A batched result's own headers, an app's own `httpClient` with header names in any case, and a 202's next poll are read the same way.
- Fixed an `X-RateLimit-Reset` sent as a Unix timestamp, as Laravel and GitHub send it, being dropped. Digits too large for a timer are read as Unix seconds. A Laravel 429 also sends `Retry-After`, which still wins.
- Changed the HTTP client's dedupe and cache key to read header names in any case and order, so the same request on the wire shares one read in flight and one cached answer.
- Added the wire contract as Pact V4 files in `contract/`.
- Added a check for any backend with `pact-verifier`: `node scripts/verify-contract.mjs`. Laravel apps get its development routes from the Composer package `lucianofedericopereira/vapor-chamber`, which also skips `TrimStrings` and `ConvertEmptyStringsToNull` under `api/vc`. The Laravel demo requires it in place of its `bootstrap/app.php` lines.
- Changed the example Laravel controller: a key's scope, slot, stored answer and lock are public static methods, which the contract's state route calls. A controller copied before this fails the idempotency cases with 400.
- Fixed the example Laravel controller answering a reused Idempotency-Key with the first request's answer when the target or payload differs. It answers 422 `key_reused` (Idempotency-Key draft-07 2.7). The same request again still replays, with its object members in any order.
- Changed the example Laravel controller to replay a 4xx verdict (409, 422, 404, 403) to a re-sent key, not only a success, as Idempotency-Key draft-07 2.6 asks. A transient answer, 401, 419 or an answer with `Retry-After` still runs again on a re-send.
- Changed the example Laravel controller's replay window from 60 s to the config value `idempotency_ttl`, default 24 hours, so an outbox re-send after a reload replays instead of running the action again. A copied config without the key gets 24 hours.
- Changed the example Laravel controller's stored answer to hold the fingerprint of the request it answered.
- Added `--against <git ref>` to `node scripts/verify-contract.mjs`: it replays that ref's contract, such as the last release's, against a backend, so a case that changed shows before the release.
- Fixed the two Vapor examples failing to build under Vite's native config loader, planned as Vite's default: `vite.config.ts` imported `../vite.base` with no file extension. Each imports `../vite.base.ts` now.
- Changed `commandKey` and the HTTP client's request key to cost less per call, with the same keys. On Node 24.21.0, a tracked dispatch of an object target is 7 to 8 ns faster, and a key of a string or number 1.1 ns.
- Updated the Vue peer range to `>=3.5.0 || >=3.6.0-rc.13`. The Vapor examples build on Vue 3.6.0-rc.13 and Vite 8.3.4, and `vapor-chamber/vitest` is tested on Vitest 5.0.5.
- Updated happy-dom, the suite's test DOM, from 20.14.6 to 21.0.4 for GHSA-834v-8h66-3h79, a code injection in its module compiler. The package ships no happy-dom, so an app sees no change.
- Improved with Vue 3.6.0-rc.12: the transition bridge on a Vapor `<Transition mode="in-out">` around `<KeepAlive>` dispatches the leave commands, and the old view leaves the DOM.
- Improved with Vue 3.6.0-rc.13: a widget made by `defineWidget` has its template refs set and its children mounted before the host's `mounted` hook runs, in the tick the tag is placed. On rc.12 the hook ran first and read `null`.
- Improved with Vue 3.6.0-rc.13: `defineVaporAsyncComponent` with a `loadingComponent` and no `delay` waits Vue's default 200 ms before showing it. On rc.12 it showed at once.
- Improved with Vue 3.6.0-rc.13: `app.config.performance = true` on a Vapor app with a `v-if` or `v-for` renders and no longer reports `The "vue-renderEffect-N" performance mark has not been set`.
- Changed with Vue 3.6.0-rc.13: a Vapor component held in a deep `ref` warns once in development (`markRaw` or `shallowRef` avoids it). The library holds no component in a `ref`.
- Changed with Vue 3.6.0-rc.13: a bundle that references `vaporInteropPlugin` grows by 73.0 KB raw and 23.1 KB brotli, from 97.1 and 30.3 (BUNDLE-SIZES.md, `+ vaporInteropPlugin`). Vue now keeps the interop code of Transition, KeepAlive and Suspense out of a bundle that imports none of them. The Vapor outlet's saving over the vDOM outlet falls with it, 24.80 to 17.97 KB brotli.
- Added `onError(error, action)` to `createFastLane`: a listener's throw goes there and the emit goes on to the next listener. Without it a throw still reaches the caller of `emit`.
- Changed persistence to a store option: `defineChamberStore(id, { ..., persist: saveTo({ key }) })` reads the saved state when the store is created and saves after any of its writes. `persist()` is removed. Migrate `bus.use(persist({ key, getState }))` and its `load()` to a store with `persist: saveTo({ key })`; `storage`, `validate`, `serialize` and `deserialize` keep their meaning.
- Removed `persist()`'s `getState`, `filter`, `actions`, `actionFilter`, `coalesce`, `load()`, `hydrate()`, `save()` and `clear()`. A store saves all its own writes, reads at creation, and `$reset()` saves the fresh state. Keep a state you do not want saved in a second store.
- Changed when storage holds a write: one microtask after it, once per burst of writes, not inside the dispatch.
- Changed a store on an async storage (`indexedDbStorage()`): it starts on `state()`, takes the saved state when the read lands, and replays the writes made before then on top. Nothing is saved before the read lands.
- Fixed a state another command's reply declares, or the server pushes, not reaching storage until a later command. A store saves every write, whatever wrote it.
- Changed `PersistStorage` to two methods, `getItem` and `setItem`.
- Changed the full IIFE: `VaporChamber.defineChamberStore` and `VaporChamber.saveTo` in place of `VaporChamber.persist`.
- Changed a schema bus's types: a key written in another style (`cart_add`) is typed under its camelCase name only (`cartAdd`), the name the bus validates. Migrate `register('cart_add')` and `dispatch('cart_add')` to `cartAdd`.
- Removed `version` from `RoutesPayload`: nothing read it. A payload may still carry fields of the app's own.
- Removed `signal()`'s read of a Vue namespace parked on `globalThis.__VUE__`. Hand Vue over with `configureVue(Vue)`.
- Changed tab sharing to a store option like `persist`: `defineChamberStore(id, { ..., share: shareTabs() })` opens one `BroadcastChannel` for the store, `vc:store:<id>`, or the name given to `shareTabs('name')`. It opens only in a page or a worker: on a server, where Node, Deno and Bun define `BroadcastChannel` too, nothing opens. Migrate `createChannel({ channel, lane, events: ['cart$state'] })` with `share: lane` to `share: shareTabs()`. `shareTabs` comes from `vapor-chamber`, `vapor-chamber/store`, `vapor-chamber/store/core` and the full IIFE.
- Changed what crosses between tabs: each write's command, applied by every other tab with the store's own reducer and no dispatch. `<id>$sync` is gone, so no plugin, listener, reaction or transport runs another tab's write. `persist` still saves the state. Migrate a `bus.on('cart$sync')` listener to `cart.$onField(...)` or a watch on `cart.state`. A shared store's reducer runs in every tab: mint ids and times in the call.
- Fixed undo across tabs: an undo in any tab undoes the command in every tab, and a redo redoes it. Each tab's `history` and `useCommandHistory` record another tab's command, and `canUndo` turns false when a server's state from another tab moves the store. Before, tab B could not undo tab A's add, and its Undo stayed enabled and did nothing.
- Fixed two tabs writing a shared store at once ending on different states, such as one field set to two values, two appends or a `$reset` against an add. The tab the browser grants the store's Web Lock runs every tab's command and posts it on, and every other tab follows it, both writes kept. A write still shows at once in its own tab. Every tab's `history` and `useCommandHistory` then hold the same commands, so Undo and Redo take the same step in every tab. Without Web Locks a store does not share, and development warns `store:missing:locks`.
- Changed a shared store in a tab with no other tab open: it sends its ask and, granted the lock, its `lead`, then nothing, so its write costs what a plain store's does. With another tab open, a write sends its command whatever the state's size.
- Changed the message between tabs to `{ kind, value, tab }`: `kind` is `ask`, `answer`, `cmd`, `undone`, `state`, `bye` or `lead`. The tab holding the lock answers an ask with its state, and the tab that asked applies nothing that tab sent before it. A `state` crosses as `{ id, state }`. With one other tab open, the lock's tab posts that tab's write back as `{ id }` alone.
- Changed a hot update under `vaporChamberHMR()` to keep a store's state when its module re-runs, whether the store was created at module load or held by a component. A key the edited `state()` adds starts fresh, and a key it drops goes. Outside a hot update, a second definition of an id still builds from `state()`.
- Fixed a hot update under `vaporChamberHMR()` warning `core:already:handler` once per action the re-run module registers again: inside the update the handlers and store actions it registers replace the old ones quietly. A handler registered over another outside a hot update still warns. Production is unchanged.
- Removed `useCommandState`, `useDeepCommandState` and `UseCommandStateOptions`: state reduced by commands is a store. Migrate `useCommandState(initial, { cartAdd: (s, cmd) => ... })` to `defineChamberStore('cart', { state: () => initial, reducers: { add: (s, target, payload) => ... } })(bus)`: each action name splits into the store id and the reducer key, the reducer takes the command's target and payload, and a state that is not an object goes in one (`{ n: 0 }`). An action name that does not split as `<id><Key>` is renamed. `deepSignal` stays in `vapor-chamber/reactive`.
- Added `coalesce: true` to a store: every write chains on the pending state, the state is written once a microtask later, and an action's result is the pending state. It is refused with `undo: true` as `store:invalid:coalesce`.
- Added `deep: true` to the Vue store: `state.value` is Vue's reactive view, so a nested field mutated in place, as a `v-model` does, is tracked by Vue readers. The store keeps the raw state, so a mutation in place is not a write: persist, tab sharing and field events follow the store's actions.
- Fixed `useStore(bus)` after `bus.clear()` on the async bus returning the old store, whose actions `clear()` had removed. It builds a new store.
- Changed a store method call (`cart.add()`) to build no string per call: about 46 ns faster.
- Changed the async bus's `onAfter` hooks to run outside an async function: a dispatch or query whose hooks return nothing settles one microtask turn sooner. On Node 24.22.1, an async dispatch with two hooks is about 60 ns faster. A hook that returns a promise is still awaited before the hooks after it and the listeners.
- Changed the async bus's retry on a success: an action with no work steps settles as on a bus with `retry: false`, one microtask turn sooner, with no closure built for a re-send it does not need. On Node 24.22.1, a local async operation is about 65 ns faster. A failure is re-sent by the same rule as before.
- Changed a handler that returns a value on the async bus, such as every store reducer, to answer with no async function around it: about 70 ns less per local async operation on Node 24.22.1. A handler that returns a promise, or throws, answers as before.
- Changed a command sent by `httpTransport`: its POST no longer resolves through an extra promise, two microtask turns fewer per sent command. On Node 24.22.1, about 100 to 200 ns less per sent command. A throw while the request is prepared is still a rejection.
- Changed `useCommand().dispatch` on an async bus that cannot reject, one without `onMissing: 'throw'` or a naming rule with `onViolation: 'throw'`: it returns the bus's own promise, with no promise added to turn a rejection into a failed result. A bus that can reject still settles every outcome as a result.
- Changed a sync query to build its command before it counts its depth, as a dispatch does: on Node 24.22.1 a query on a bus with no plugins is about 3 ns faster.
- Changed `supersede()` to refuse a sync bus at `use()`, with `supersede:invalid:bus`: a sync command lands before the next starts, so nothing was ever superseded there. Migrate: install `supersede` on `createAsyncCommandBus()`.
- Fixed a plugin whose `attach` throws staying installed, its rules and steps still running: `use()` calls `attach` before it places the plugin, so the throw reaches the caller and nothing of the plugin stays.
- Changed every command to carry a `signal` field, `undefined` where nothing sets it: a sync command and an async one share one shape, so code that reads commands from both buses stays fast. `Object.keys(cmd)` now lists `signal` on a sync command. A sync `request()`'s own signal still never reaches the command.
- Changed the async bus's handler type to take a value or a promise of it, as `useCommand().register` does: `bus.register('save', (cmd) => ...)` type-checks without `async`, and answers sooner than an `async` handler. No migration.
- Changed `createFormBus`'s `values`, `errors`, `touched`, `isDirty` and `isValid` to read-only cells: `set()`, `touch()`, `reset()` and `setErrors()` write them. Migrate a direct write (`form.values.value = next`) to `set()` per field.
- Fixed a form subscriber that throws on `errors` or `isDirty` leaving `isValid` stale: the form's state is one store, written once per command, and a reader still re-runs only when the cell it reads changes.
- Changed a form on a shared bus to check its id against the bus's stores: a second form, or any store, with the id throws as before, and the bus no longer carries a `__vcFormIds` field. The bus lists the form's `<id>$reset`.
- Changed a form's `set()` to run its rules before the write, so a subscriber sees the values and their errors together.
- Changed SSR to carry the stores' states, not commands: `storeStates(bus)` on the server and `seedStores(bus, states)` on the client, from `vapor-chamber/ssr`. The page holds only the stores the request wrote, so a store the server never touched keeps the client's own saved state. A reducer that mints an id or reads a clock now ends on the server's state in the browser. Migrate `createSSRPlugin()` with `rehydrate(bus, window.__VAPOR_COMMANDS__)` to `storeStates(bus)` embedded with `serializeForScript`, and `seedStores(getCommandBus(), window.__VAPOR_STATES__)` before mount.
- Removed `createSSRPlugin`, `rehydrate`, `rehydrateAsync`, `SSRPlugin`, `SSRPluginOptions`, `RehydrateOptions`, `DehydratedCommand` and the `ssr:invalid:bus` failure. State a plain handler built moves into a store.
- Changed the example Laravel controller to run the middleware an action declares (`#[Middleware]` or `HasMiddleware`), as a route runs a controller's. Rate limits are an action's `throttle` middleware: the example config's `rate_limits` map is gone. Copy the controller again.
- Changed the example Laravel controller to answer a command from an old page with `{ redirect }`: the page sends its build as `X-App-Version`, the controller compares it with `config('vapor-chamber.app_version')` and sends back the page's own path, which the page's `onRedirect` loads. A server with no `app_version` checks nothing. Copy the controller and `config/vapor-chamber.php` again, and send the header from the page.
- Changed the Node floor to 24.5.0 (`engines.node` `>=22.12.0` -> `>=24.5.0`): the stores and the outbox shared across tabs, and `exclusive` across tabs, take Web Locks from `navigator.locks`, which Node has from 24.5.0. CI runs Node 24 only. Migrate: run Node 24.5.0 or later.

## v1.31.0 - 2026-10-13

- Updated the Vue peer range to `>=3.5.0 || >=3.6.0-rc.11`. The Vapor examples build on Vue 3.6.0-rc.11.
- Improved with Vue 3.6.0-rc.11: `v-vc-command` on a component keeps working after a hot reload of that component.
- Improved with Vue 3.6.0-rc.11: the transition bridge drives a vDOM `<Transition>` whose child is Vapor slot content.
- Improved with Vue 3.6.0-rc.11: a `useCommand()` listener in a vDOM component inside Vapor components stops when a vDOM `v-if` removes them.
- Fixed `v-vc-command` dispatching when its action is empty (`v-vc-command=""`, a bare `v-vc-command` on vDOM, or a value that is `undefined`, `null`, `''` or `false`). A press dispatched `undefined`, or the string `"undefined"` on Vapor from Vue 3.6.0-rc.11, and on a default bus showed `vc-error` and announced "No handler registered". It now does nothing, with one development warning per element. An action set after mount works as before.
- Fixed the transition bridge's `onMove`, documented as called by Vue on a TransitionGroup move. Vue has no move hook, so `*Move` never fired. `v-bind="t"` no longer passes `onMove` on, which removes a dead `move` listener and Vue's warning on a fragment child. Call `t.onMove(el)` yourself to dispatch `*Move`. `Object.keys(t)` and `{ ...t }` no longer include `onMove`.
- Fixed the example Blade mock server (`examples/sprinkled-blade/mock-server.mjs`) stopping when a page asked for a `dist/` file that is not built. It answers 404 "Not built" and keeps serving. It also takes a port argument.
- Fixed the example Blade mock server serving any readable file to a request for `/dist/../<path>`. It answers 403 outside `dist/`.
- Fixed the example Blade mock server running `toString` or `constructor` as a command. A name `Object.prototype` carries now answers 404 `unknown_command`.
- Fixed the example Blade mock server answering 500 to a body that is not JSON or has no command. It answers 400 `missing_command`, as the reference controller does.
- Fixed the example static server (`examples/static-server.mjs`) running `toString` or `constructor` as a command. A name `Object.prototype` carries now answers 404 `unknown_command`.
- Fixed the example static server answering 500 to a body that is not JSON or has no command. It answers 400 `missing_command`, as the reference controller does.
- Fixed the example `transformPlugin` (`examples/custom-plugins.ts`) running `Object.prototype` methods as transforms for an action named `toString` or `valueOf`. It reads its own keys only.
- Fixed the custom plugins example refusing every request in its rate-limit demo, and its optimistic demo, which always printed "rolled back". The rate limiter is installed just before its own demo, so it shows three requests passing and the fourth refused.
- Fixed the Vue todo example (`examples/vue-vapor-component.vue`) adding one more validator to the shared bus on each mount. It removes its validator when it unmounts.
- Fixed the HMR example (`examples/feature-vite-hmr.ts`), whose handler was replaced by the `useCommandState` handler for the same action and never ran. The handler has its own action, `cartCheckout`.
- Fixed the Astro example's directives reading `valueOf` or `toString` from a `v-scope` that never declared them. A binding reads a scope's own keys only, and anything else from the bus state.
- Fixed the Astro example's `v-each` keeping the bindings of removed rows alive. A row binding that reads the bus state or an enclosing `v-scope` is removed with its row. `addEffect` returns a function that removes the effect.
- Fixed the Astro example's `v-each` taking a nested list's `<template>` as its own row. It reads its row from its own `<template>` child only.
- Fixed the island cart example (`examples/vapor-island-cart/src/main.ts`) rejecting unhandled on a `<constructor client:load>` element, which found `Object.prototype.constructor` in its island map. It looks a tag up by own key.
- Added docs/retry.md, the async bus's retry rule on one page. It replaces the finished plan docs/plan-shape.md, whose section 4 called a declared wait transient: a verdict with `Retry-After` (a 409) is re-sent only for an identified command.
- Fixed a cancel with your own reason (`ac.abort(new Error('x'))`) counting as a failure: it opened `circuitBreaker` and spent the async bus's retry budget, so later real failures were not re-sent. `failureCondition(error, signal)` takes the command's signal and reads such a cancel as `aborted`.
- Fixed the router's `*` splat (`params.pathMatch`): it came back still URL-encoded, a link built from a decoded value broke at `#` or `?`, and a route's `load` sent its slashes as `%2F` (or `%2520` from an encoded value). It is now decoded like every param and encoded segment by segment with its slashes kept, as in vue-router. Migration: code that read `pathMatch` as encoded, or passed it encoded, now uses the decoded text.
- Fixed `onMissing: 'buffer'` dropping every early dispatch when `maxBufferSize` was `Infinity`, NaN or above 2^31-1. `Infinity` now means no bound and NaN takes the default 256, as every count option does.
- Fixed `request()` and `createWsBridge` failing every request or command after about 1 ms when `timeout` was NaN, `Infinity` or above 2^31-1. NaN now takes the default (5000 ms for `request()`, 10000 ms for the bridge), and a larger value waits the timer's maximum, about 24.8 days, as the HTTP client's `timeout` does.
- Fixed a throttle wait of NaN or `Infinity`. `throttle(list, NaN)` refused every call for good, while `register(action, handler, { throttle: NaN })` throttled nothing, and `Infinity` refused even the first call. A NaN wait now falls back to the default, no throttle, in both. `Infinity` and any wait above 2^31-1 are the timer's maximum, about 24.8 days: the first call runs, later ones wait.
- Fixed `debounce(list, wait)` running the handler after about 1 ms when `wait` was `Infinity` or above 2^31-1. Such a wait is now the timer's maximum, about 24.8 days. NaN is no delay, as before.
- Fixed `createBatchingHttpBridge({ window })` with a window of NaN, `Infinity` or above 2^31-1, which flushed after about 1 ms. NaN now takes the default, one microtask, and a larger window is the timer's maximum.
- Fixed a `v-vc-command` timeout modifier of 10 or more digits (for example `.9999999999`) timing out at once. It is capped at the timer's maximum.
- Fixed a command or request holding a value JSON cannot encode (a BigInt, a cycle). The HTTP bridges answered `transport:lost:reply`, though nothing was sent, so the async bus re-sent an idempotent action for nothing, and a batched one failed its neighbours too. The WebSocket bridge answered `transport:failed:plugin`. `createHttpClient` and `postCommand` threw the raw `TypeError`, which `safe` returned as its `error`. All now fail with `transport:invalid:json`, the `TypeError` as its `cause`, never re-sent, and a batched command fails alone.
- Fixed the router not announcing the first page change to a screen reader when the initial navigation did not complete (for example a guard refused it). The page the browser loaded is still not announced; every later page change is.
- Fixed `problemOf(error)` throwing a `TypeError` when the HTTP bridge got a 2xx reply that is JSON but not the envelope (`remote:unexpected:json`). It returns `{ detail }`.
- Fixed RxJS's `from(observe(bus, pattern))` throwing "You provided an invalid object where a stream was expected" on every runtime without `Symbol.observable` (Node and all browsers). `observe()` now also answers the `'@@observable'` key RxJS reads there. The call also type-checks now: `observe()` declares both interop members in its return type.
- Fixed the `remote:unexpected:json` entry in `ERROR_CODE_REGISTRY` and docs/errors.md naming only a body that is not valid JSON. The HTTP bridge also raises it for a 2xx reply that is JSON but not the command envelope.
- Fixed the router docs saying `vapor-chamber/router` needs Vue 3.6. It follows the package peer range and loads on Vue 3.5, as does `vapor-chamber/router/vdom`. Only `vapor-chamber/router/vapor` needs 3.6.
- Fixed the IIFE decision tree in docs/performance.md sending a widget page to the `elements` bundle when it also needs WebSocket, persistence or undo. Only the `full` bundle carries those.
- Fixed the README's HTTP client docs. A `{ silent: true }` request marks its error as `error.context.silent`, not `error.silent`, and `http.create()` gives a client with its own interceptors, not the parent's.
- Fixed a `csrf: true` request throwing `URIError: URI malformed`, before anything was sent, when the `XSRF-TOKEN` cookie was not valid percent-encoding. Such a cookie now reads as no cookie, and the token comes from the next source.
- Fixed the router's `focusOnNavigate` taking an editable focus target (`contenteditable`) out of the tab order by giving it `tabindex="-1"`. Chromium reports such an element's `tabIndex` as -1 though it is focusable. It is now left as it is.
- Added docs/contract.md (failure codes, conditions, the wire shapes) and docs/accessibility.md (what the library guarantees). They replace the finished plan docs/plan-failures-and-contract.md, whose open items moved to ROADMAP.md.
- Fixed the docs saying every failure is a `BusError`. A handler's own throw and an `Error` given as the abort reason come back as themselves.
- Fixed the docs saying the async bus re-sends every `limited` and `timeout` failure. A 504 or a transport timeout is re-sent only for an idempotent action or a keyed command, and a plugin's or a throttle's refusal never.
- Fixed the example static server and Blade mock server answering 404 to the browser's `/favicon.ico` request, a console error on the first page of each. Both serve the project icon.
- Fixed the IIFE `connect({ retry })` docs naming the old key `actions`. The key is `actionPolicies`, for example `{ actionPolicies: { cartAdd: 'idempotent' } }`.
- Fixed the docs' template examples reading `.value` on a ref taken from `useCommand()` or `useSharedCommandState()`. A template unwraps it, so `:disabled="isAnyLoading.value"` never disabled. Write `:disabled="isAnyLoading"` and `{{ lastError?.message }}`.
- Fixed the docs saying every abort is a `BusError` named `AbortError`. An `Error` given as the abort reason comes back as itself, before the call and mid-flight.
- Fixed the docs saying a bundler reaches Vue's Vapor runtime only through a per-app alias. A bundler's `vue` entry re-exports it. It is a separate file only in Node and on a no-build page.
- Fixed the docs saying `vaporChamberHMR()` injects its shim into every file that imports vapor-chamber, `.vapor.vue` included. It injects into scripts only, never a `.vue` file.
- Fixed the whitepaper saying the HTTP cache key ignores headers. The cache and the dedupe key by the request headers, so only users told apart outside them share a slot.
- Fixed the whitepaper's SSR example embedding dehydrated commands with `JSON.stringify`. It uses `serializeForScript`, so a `</script>` in a payload cannot close the element.
- Fixed the Laravel example routes (`examples/laravel-backend/routes-web.php`) saying the 419 retry re-reads a stale meta tag. It reads the `XSRF-TOKEN` cookie first. `csrfCookieUrl: ''` only skips a refresh request that has no endpoint without Sanctum.
- Fixed the Vapor island cart page saying its products are plain HTML. Both `<vc-products>` and `<vc-cart>` are Vapor custom elements.
- Fixed the router demo saying a `useQueryParam()` handle is not a ref. It is a real ref, and a template unwraps it.
- Fixed the docs saying `vaporChamberHMR()` keeps state across a hot update. It keeps the shared bus and its handlers. A re-run module builds its `useCommandState` state again from the initial value.
- Fixed the Blade CDN example (`examples/pattern-1-blade-cdn.html`) saying no local plugin sees a command the HTTP transport sends. A plugin in `createApp`'s `plugins` is installed before the transport and sees each dispatch.
- Fixed the Laravel Vite example (`examples/pattern-2-laravel-vite.ts`) saying only unhandled commands go to the server. With no `actions`, the bridge sends every command and a local handler never runs.
- Fixed the Next.js example (`examples/pattern-4-nextjs.tsx`) saying `logger()` sees an unresolved Promise on the async bus. It prints the settled result.
- Removed seven `ERROR_CODE_REGISTRY` rows that nothing raises: `core:already:handler`, `core:failed:handler`, `core:failed:hook`, `core:failed:listener`, `workflow:failed:step`, `workflow:failed:compensation` and `core:unknown:error`. `getErrorEntry()` and `isRetryableCode()` answer `undefined` for them, and `describeErrorCodes()` and docs/errors.md no longer list them. No dispatch result changes.
- Fixed cancelling on browsers without `AbortSignal.any` (Chrome before 116, Firefox before 124, Safari before 17.4), which every IIFE targets. Disposing a bridge's scope, a bridge's own signal and a `supersede` caller's own signal now cancel the request, and a batch whose every command aborted is cancelled on a bridge with its own signal. The abort carries the reason it was given, as with `AbortSignal.any`.
- Fixed the router leaving the address bar on the page Back or Forward moved to, with the previous page still on screen, when a guard redirected that navigation and the redirect was refused, failed, matched no route or led back to the page on screen. It walks the history back, as a refused Back does.
- Fixed the stream parser's `end()` on input that stops inside a number. It emitted `1` for `1.` and `NaN` for `1e` or `1e+`, and nothing for a lone `-`. Such a number is now an `onError` ("Unexpected end: incomplete number") and no value, as `JSON.parse` rejects it.
- Fixed `silent` on a 419 whose CSRF refresh finds no token (`transport:missing:csrf`). Through `postCommand` the failure was not marked `context.silent`. Two such requests at once shared one failure, so a silent one marked the other one's silent too, in the HTTP client as well. Each request now gets its own failure, marked by its own `silent`.
- Fixed `silent` on the HTTP client's shared reads. A loud GET that joined a silent one in flight got a failure marked `context.silent`, and a silent one that joined a loud one got none. A silent read aborted by its own signal while sharing a read was not marked. A silent and a loud read now never share one request, as with `resolveNotModified`, and every abort is marked.
- Fixed a persist or outbox write on IndexedDB (`indexedDbStorage()`, `indexedDbOutbox()`) reporting saved before the browser committed it. It now settles when the write is committed, a little later than before. A write the browser fails to commit now fails: persist warns, and the outbox warns and keeps the record in memory.
- Changed the wait before a `createHttpClient` or `postCommand` re-send that the answer does not time. It is now the async bus's: random under 200 ms, doubling per re-send, capped at 20 s, so clients that failed together do not come back together. It was 1 s doubling to 30 s. A declared wait (`Retry-After`) is unchanged. The bridges send once (`retry: 0`) and are unaffected.
- Fixed `createHttpClient` and `postCommand` sending nothing when `retry` was negative or NaN: the call rejected with a plain `Error('unreachable')`. A fractional `retry` made its last re-send and then failed the same way. `retry` now follows every count option: NaN takes the default (2 for a GET, else 0), a negative is 0 and a fraction is truncated.
- Fixed the router's hover preheat missing a link inside an open shadow root, such as a web component's link. A click on it already went through the router. It is now preheated on hover too.
- Fixed `v-vc-optimistic` undoing its update when the `v-vc-command` timeout gave up on a slow dispatch that then succeeded. The timeout still shows `vc-error`, reports `directive:timeout:dispatch` and releases the button. The rollback now waits for the dispatch: it runs if the dispatch fails, and never if it succeeds.
- Fixed the router calling a lazy component's loader twice when its page was opened while its code was still loading: a click during a hover or idle warm-up, or two navigations to the page. It runs once. A failed load is loaded again by the next navigation, as before.
- Fixed the router's hover warm-up inside an open shadow root, such as a web component's menu: moving between two of its links warmed the first, never the one under the pointer, and a link in a component nested in another could be missed. The link under the pointer is warmed.
- Fixed the router's hover warm-up missing a route added during the hover delay (`setRoutes`). The route is read when the warm-up fires.
- Router warm-up skips a user saving data (Save-Data or 2G, where the browser reports it) and a `download` link. `meta.preheat: false` on a route: a link to it no longer warms its component.
- Router warm-up: a link that takes focus warms its page as hover does.
- Fixed the router's hover warm-up starting its delay again when the pointer moved from a link onto an icon or other element inside it. The page warms 100 ms after the pointer reached the link.
- Fixed a store `$onField` subscriber that throws failing the write's dispatch after the state had changed, so history did not record it, a persist did not save it, and the later subscribers missed it. The throw is logged, the dispatch returns ok, and the other subscribers run.
- Fixed a store `$onField` subscriber that unsubscribes while a write is delivered making the next subscriber of that field miss the write. Subscribing and unsubscribing during a write now work as for a `bus.on` listener: one added during a write is called from the next write, not that one.
- Fixed a write made inside a `$onField` subscriber of the Vue store (`vapor-chamber/store`) never reaching the subscribers or `fieldRef`, which showed the value before it until a later write.
- Fixed a write made inside a `$onField` subscriber of the core store (`vapor-chamber/store/core`) reaching the later subscribers before the write that caused it, so they ended on the old value. On both stores such a write is now delivered after the current one, in order.
- Fixed a store's `$dispose()` stopping at a cleanup that throws (such as a `share` lane's unsubscribe). The store stayed in the registry, so the next `useStore(bus)` returned the disposed store and every action failed with `core:missing:handler`. The throw is now logged and disposal completes.
- Fixed two tabs sharing a store (`share`) on the async bus ending on different states when an async plugin delayed the received `<id>$sync` past the next message. The delayed write was sent back as the receiving tab's own.
- Fixed a store `answer` that returns something other than an object (`null` from a server answering `state: null`, or `undefined` from a mapper that forgot to return) replacing the store's state with it, so every reader threw. With `version`, the dispatch failed instead. Such a result is now not written, and development warns once, as for a state declared under `stores`.
- Fixed `createChamber().install(bus)` leaving the handlers it had already registered on the bus when a later one threw (a sealed bus, a naming rule, a `$` in a name). It removes them, then rethrows.
- Fixed docs/store.md saying `persist` saves a state a reply declares under `stores`. Only an unscoped persist does. One scoped by `actions` saves it only when the replying command is in its list.
- Fixed `createSchemaCommandBus` and `createAsyncSchemaCommandBus` keeping only one of two schema keys that name the same action (`cart.add` and `cart_add` are both `cartAdd`). The other definition was lost without a word. They throw `schema:already:action` at creation.
- Fixed `scripts/generate-laravel.mjs` writing rules that disagree with the client's schema. A generated stub accepted `"5"` for a number, `"1"` for a boolean and an object for an array, and refused `""` and `[]`. It writes `present` with `numeric:strict`, `boolean:strict` and `list`. Regenerate a stub with `--force` to take the new rules.
- Fixed generated stubs' validation messages naming the rule key ("The payload.qty field ..."). They name the field ("The qty field ...").
- Fixed the example Laravel controller pointing a generated stub's field errors at `/payload/payload/<field>` and `/payload/target/<field>`, so `FormBus` marked nothing. It points at `/payload/<field>` and `/target/<field>`. An action that validates `$payload` keeps `/payload/<field>`. docs/contract.md section 4 names `/target/<field>`.
- Fixed the example Laravel controller dropping the `Retry-After` header, the field `errors` and any other member of an exception that renders its own response. The client waited on its own schedule and `FormBus` got no errors. It sends all three, in a single answer and in a batch result.
- Fixed the Laravel demo app handing a command `"a"` for `" a "` and `null` for `""`: Laravel's `TrimStrings` and `ConvertEmptyStringsToNull` ran on the command routes. `setup.sh` now skips both for `/api/vc` and below, and docs/integrations/laravel.md shows the lines for any app.
- Fixed docs/integrations/laravel.md and the HTTP bridges' docs leaving `meta`, `stores` and a batch result's `headers` out of the wire shapes they show.
- Fixed the example Laravel controller's docs on key scope: a key belongs to the user, else the session, else the address. The Idempotency-Key draft leaves a key's uniqueness to the server, and this controller makes it per client.
- Changed docs/performance.md's speed table from multiples of a direct function call, which doubled between two machines, to the time per call and the calls that fit in one 60 fps frame, stamped beside the machine that measured them. The bench provenance now names the CPU and OS.
- Fixed 49 buttons in the examples that had no `type`. Inside a form a button with no type submits it. Each now says `type="button"`; none of them submits a form.

## v1.30.0 - 2026-10-11

- Fixed the HTTP client's cache answering one request with another's response when only the headers differed. The cache key was the URL alone, so after a sign-in as another user one client served the first user's `GET /me` to the second, and a language switch got the earlier language. The key now holds the request's headers, as the dedupe key already did, and `invalidateCache` still matches by URL. A header that changes on every request, such as a trace id, makes those reads miss the cache.
- Added `serializeForScript` to `vapor-chamber/ssr` and the root. The SSR docs embedded dehydrated commands with `JSON.stringify` inside a `<script>`, which leaves `</script>` in a target or payload as it is, so user text could close the element and run script. `serializeForScript` escapes `<`, `>`, `&`, U+2028 and U+2029. Its output is still JSON and parses to the same value. The docs now use it.
- Fixed `idempotent()` cancelling a duplicate that never aborted. A concurrent duplicate joined the first dispatch's run, so the first caller's abort cancelled the handler and settled both. Each caller's abort now settles that caller alone, as the HTTP client's joined GETs already do. The run is cancelled once every caller holding it has aborted, and a caller with no signal holds it until it lands.
- Fixed `cache()` storing an answer that an `invalidate()` or `clear()` overtook. A read still running when the app invalidated its key stored its answer from before the write, so later reads were served it until the TTL ran out. That read still answers its own caller, but is no longer stored. The HTTP client's cache already closes this window the same way.
- Fixed `pollWith` ending a running job as failed when the monitor answered a 503 or 429, or any answer declaring `Retry-After`. The finished state was then never read. Those answers now wait and poll again, within `maxWait`. A verdict, an abort or a lost reply still ends the job.
- Fixed `createStreamParser` refusing every empty array: `[]`, `{"items":[]}` and `[1,[]]` all ended with "Unexpected end: unclosed structure", while `{}` parsed. `]` is accepted directly after `[`, and a trailing comma (`[1,]`) is still refused.
- Fixed `commandKey` giving every circular target the same key, and likewise every target holding a BigInt. JSON could not serialize them, and the fallback `String(target)` is `[object Object]` for all of them. So `idempotent`, `cache`, `serialize` and `supersede` collapsed two different commands into one, and the second never ran. A BigInt is now tagged in the key, and a circular target keys by its identity. A target still keys by its value otherwise: `1` and `'1'` share a key, as before. Size: the Blade consumer bundle grows 60 B brotli (8,374 -> 8,434), and the IIFEs grow raw/brotli by full +155/+5, core +141/+65 and elements +141/+68 B.
- Added a development warning for an action name that holds `:`. `commandKey` joins the action and the target with `:`, so `('a:b', 'c')` and `('a', 'b:c')` share a key. Escaping the name on every call measured 25-30% of a primitive key (docs/V8-RULES.md rule 3), so it is a naming rule instead. The warning is folded out of production builds and costs nothing there.
- Fixed `createFormBus` showing errors for values it no longer held after `reset()` during `submit()`. A reset while the async rules ran was followed by their verdict on the discarded values. When those were valid, `onSubmit` sent them. A reset now cancels a submit that has not reached `onSubmit`: its validation is dropped, `onSubmit` does not run, and `submit()` returns `false`. A submit already in `onSubmit` is unchanged.
- Fixed typed `int` route params past `Number.MAX_SAFE_INTEGER` being rounded to another number. `/orders/9007199254740993` reached the loader as order 9007199254740992, and `resolve()` built links to it. Such a path param no longer fits `int`, so the URL falls through to the next row, and a typed query param reads its declared default, as a malformed value does. Declare the param `string` to receive it whole.
- Fixed `circuitBreaker` never opening again after a failed half-open probe. Past `resetTimeout` the circuit lets one dispatch through to probe the backend. A failed probe left it half-open, which is not open, so every later dispatch went to the failing backend until one succeeded. A failed probe now opens the circuit for another `resetTimeout` and calls `onOpen` again.
- Fixed `rateLimit({ max: 0 })` making the outbox flush in a loop. The refusal computed `retryIn` from the oldest dispatch in the window, and an empty window has none, so `retryIn` was `NaN`. The outbox read that as a declared wait and flushed again with no delay, re-saving its queue each time (31 times in 50 ms, measured). With no slot to free, the refusal now declares no `retryIn`, and the record waits for the next flush. Size, with the fix above: full IIFE +34/+10 B raw/brotli; core and elements are unchanged.
- Fixed `createWsBridge` treating a replaced socket's close as its own. After `disconnect()` then `connect()`, the first socket's close event arrives late, and `connect()` had already cleared the intentional mark. With `reconnect: false` it failed the commands queued for the new socket with `lost:reply` and emptied the queue. With `reconnect: true` it set `connected` to false under an open socket and scheduled a reconnect. A replaced socket's close now only calls `onDisconnect`.
- Fixed the example Laravel controller (`examples/laravel-backend/VaporChamberController.php`) answering one user's command with another user's response. Its Idempotency-Key replay was keyed by command and key alone, and the `idempotent()` plugin's default key is the command itself, so two users adding the same product within the TTL sent the same key: the second user's add never ran and returned the first user's cart. The key is now scoped to the user (else the session, else the address) and hashed. Hashing also keeps a key that carries a payload within the 255-character key column of the `database` cache store, Laravel's default, where a longer key failed the insert on MySQL and PostgreSQL.
- Fixed the example controller answering 500 `internal_error` to the exceptions Laravel's own handler answers with a status: `abort(404)` and other HTTP exceptions (now their status and headers, so `abort(429, ..., ['Retry-After' => 30])` carries its wait), `AuthenticationException` (401 `unauthenticated`), a policy's own status (`denyAsNotFound()` now answers 404 `not_found` instead of 403, which said the resource exists), and a `ValidationException` given its own status.
- Updated the development dependencies within their ranges: vite 8.3.4, @vitejs/plugin-vue 6.0.10, vue-tsc 3.3.13, playwright 1.64.0, happy-dom 20.14.6, @types/node 26.6.5, and astro 7.3.8 in the Astro example. Vue stays on 3.6.0-rc.10 until its rc.11 alignment, and TypeScript on 6.0.3 until vue-tsc supports 7.
- Fixed `v-vc-command` leaving its control busy for good when the `v-vc-optimistic` function threw. The optimistic call ran before the `try` whose `finally` releases the control, so `vc-loading`, `aria-disabled` and the in-flight guard stayed and every later press was swallowed. A throw is now that press's failure: `vc-error`, announced, and the control is released.
- Fixed a store with `undo: true` keeping every undone step for its lifetime. A redo reads only the newest undone steps, and `history` drops its redo list on a new action, so older ones could never be redone, yet each held two whole states: 1,000 rounds of an action and its undo with 80 KB states held 89 MB, against 29 MB without the undos. They are now bounded like the 256-step ring. The bound runs on the undo path; an action's path is unchanged.
- Fixed the MCP handler giving no answer to a tool whose value JSON cannot hold (a BigInt id, a cycle). The encoding threw outside the call's `try`, so the whole reply rejected, and over stdio the client's request was never answered. It is now that call's error result, with its id.
- Fixed `createWsBridge` stranding queued commands behind one whose envelope JSON cannot hold (a BigInt in the payload). Queued while disconnected, it threw out of the flush on reconnect: the commands behind it were already off the queue and never sent, and `onConnect` was skipped. A command is now encoded before it is queued or sent, so such a command fails its own dispatch, as it already did on an open socket. Each envelope is still encoded once.
- Fixed `toTools()`, `toAnthropicTools` and `toOpenAITools` emitting a field typed `'any'` as `{ type: 'any' }`, which is not a JSON Schema type and made the whole tool schema invalid. It is now `{}`, as `busToMcpTools` already emits it. The property type in `AnthropicTool` and `OpenAITool` is now `{ type?: string }`.
- Fixed `createSseBridge` leaking its first stream when `install()` ran twice. The first EventSource stayed open, out of `dispose()`'s reach. A second install now replaces it.
- Fixed an unsubscribe on `createFastLane({ removal: 'snapshot' })` reaching other registrations. It removed every registration of the same function, and one kept from before `remove()` or `clear()` removed a later registration. It now removes its own, as the default live mode does. The emit path is unchanged.
- Fixed `createTestBus().inspect()` always reporting no `responderActions`. It now lists the actions `respond()` registered, as the real bus does.
- Fixed a declared wait that no timer can keep (`retryIn` of NaN, Infinity or below 0) being taken as one. The outbox, the async bus's retry and `pollWith` read any number as a wait, so a plugin or app failure declaring NaN or Infinity made the outbox re-flush with no wait, forever (32 saves in 50 ms), and a NaN made the bus's retry re-send at once instead of backing off. All three now apply one rule (`isDelay`: a number from 0 to the timer maximum), on their failure paths.
- Fixed `useCommand`, `useCommandQuery` and `useVaporAsyncCommand` with dispatches overlapping. `loading` was written per dispatch, so the first to settle set it false while another still ran: a button bound to it read idle mid-request. `useCommandQuery`'s `data` took every answer in the order it landed, so an older query answering last overwrote the latest (search-as-you-type showed the results for "ab" under "abc"). `loading` now holds while any dispatch is in flight, and `data` is the latest query's answer. `lastError` stays the last failure to arrive, so an older failure is not hidden. The counts are made at a composable's first dispatch, so creating one runs the code it ran in 1.29. Measured against 1.29 (`npm run ab`, two call lengths): creation reads no difference, and dispatch through `useCommand` reads 4.5-6.2 ns faster. A dispatch that never settles now keeps `loading` true.
- `toTools()`, `toAnthropicTools` and `toOpenAITools` build their schemas with the generator `busToMcpTools` uses, so the three agree. They now declare `required`: `target` and `payload` when the action has them, and each typed field (an `'any'` field stays optional). A model was told nothing was required, and the validator then refused what it left out. The output changes shape: a test that compares it exactly will see `required`.
- Fixed `fromToolCall` handing a handler `payload: undefined` when a tool call left out the payload its action declares. Validation skips an absent payload, which stays app code's choice on `dispatch()`; a model's input is not app code. Such a call is now checked as an empty payload, so the validator names the missing fields.
- Size against 1.29, raw/brotli: the full IIFE +404/+100 B, core +191/+79, elements +191/+76. The Blade consumer bundle grows 60 B brotli, all `commandKey` (above).

## v1.29.0 - 2026-10-08

- Added the root's whole surface to `vapor-chamber/vue` and `vapor-chamber/vapor`: the bus, plugins, transports and the HTTP client. A Vue app now imports from one entry, `import { createCommandBus, useCommand } from 'vapor-chamber/vue'`. They are the root's own functions, so code that imports the bus from the root is unchanged and shares the same bus.
- Fixed a bundle that inlines Vue and runs in Node, such as a Vite SSR build with `ssr.noExternal`. The root's runtime lookup loaded a second Vue and replaced what `vapor-chamber/vue` wired at build time. Composables lost reactivity and cleanup, and `untracked()` went back to tracking. Composables on a bundled page with an import map for `vue` hit the same. The lookup now wires only the Vue the app already has, and keeps what `vapor-chamber/vue` wired.
- Fixed the README's elements IIFE example, which registered no widget: it now hands Vue over with `configureVue` first. The README names one entry per kind of app, and says that `untracked()` cannot suspend tracking on a page with no build step.
- Fixed the store guide on ordering a store's answers with `serialize`. Its default key is the action, so two different actions of one store were both in flight. One lane per store, keyed to the commands that reach the server, now orders the store's writes and its reads. The guide and `serialize`'s docblock say to key the store's local reducers to `null`: in the lane, a read that awaits one waits for ever. They also say that a command waiting in the lane already reads as loading in `isLoading()`.
- Vue 3.5 is now tested on every run. Every entry that uses Vue loads and works on it, except `vapor-chamber/vapor`, `vapor-chamber/transitions/vapor` and `vapor-chamber/router/vapor`, which need Vue 3.6.
- Fixed `useSharedCommandState().dispatch` throwing when a subscriber of `inFlight` or `isAnyLoading` throws. `isAnyLoading` then stayed true for every reader. The dispatch now fails with that error and the count returns to 0, as `useCommand`'s does.
- Changed `dispatch` and `query` of `useCommand`, `useCommandQuery`, `useCommandGroup`, `useSharedCommandState` and `defineVaporCommand` to be typed by the bus they run on. A sync bus gives a `CommandResult`, an async one a promise of it, and the shared bus a `CommandResult`. A cast or a narrowing written for the old types can go. On an async bus, `useCommand`'s `dispatch` now returns a promise even when a subscriber throws.
- Added `bus` to the options of `useCommand`, `useCommandState`, `useCommandHistory`, `useCommandQuery`, `useCommandGroup`, `useCommandError`, `defineVaporCommand` and `useDeepCommandState`. Each runs on the bus it is given, sync or async. A concurrent SSR server can now pass a bus per request, as `setCommandBus` advises. Without it they use the shared bus, as before. `useSharedCommandState` now accepts an async bus too.
- Fixed the retry example, which stated the rule from before 1.27. Fixed the README row for `isLoading()`, which left out when counting starts and stops.
- Fixed three docs. The SSR examples set the shared bus per request, which their own warning calls unsafe: they now give each request its own bus. `src/signal.ts` and the whitepaper now say what a read of `__VUE__` finds. The whitepaper's script-tag recipe loaded the core IIFE, which never reads the parked Vue: it now loads the full IIFE.
- Fixed the examples to match this release. The Vue examples import from `vapor-chamber/vue` alone, and drop an `instanceof Promise` check on a dispatch result. Two retry comments now state the current rule. `feature-vite-wire.ts` says a root-only app needs the plugin on Vite.

## v1.28.0 - 2026-10-07

- Fixed `createRouter()` throwing a TypeError on a route row whose `params` is `null`. The row now compiles as one without param types.
- Added `headers` to a batched result and a WebSocket frame, as OData's JSON batch response has them. Their `Retry-After` sets the wait as a response's does, so an idempotent batched command now waits and is sent again.
- Changed the reference Laravel controller's `batch()` to send each result the headers its own response would have had, such as `Retry-After: 1` on `in_progress`.
- Improved the development message when a store or history from a second copy of vapor-chamber registers on a bus. It now names the two copies instead of asking the app to rename the action.
- Fixed the README schema example, which imported `CommandsOf`. The type is `InferMap`.
- Added `plugins` to `inspectBus()`: each installed plugin's declared `id`, `priority`, `actions`, whether it has an `actionFilter`, and whether it is a `transport`, in execution order. A hand-built `BusInspection` now needs the field.
- Fixed `persist` failing every dispatch with `persist:failed:plugin` when the browser blocks site data, so reading `localStorage` throws. It now warns and the dispatch succeeds, and `load()` returns null instead of throwing.
- Fixed a before- or after-hook that unsubscribes itself, or another hook, during a dispatch skipping the next hook. In `onBefore` the dispatch also failed with `core:refused:hook` and its handler never ran. Hooks now follow the listeners' rule: a dispatch runs the hooks that existed when it started and skips one removed during it, on both buses and in `createTestBus()`. Calling one unsubscribe twice now removes only its own subscription.
- Fixed a navigation failing with `router:failed:guard` when one guard removed itself and a later guard, and the same case in `afterEach` logging a TypeError. Calling one unsubscribe twice now removes only its own guard or hook. A guard added during a navigation still runs in it.
- Changed the development check of `undo: true` stores to compare the two reducer runs without serializing the whole state. A part the reducer left unchanged is not read, and the same states warn as before. Production builds are unchanged.
- Added `actions` and `actionFilter` to `persist`, as on other plugins. The bus then runs it only for those actions: `actions: ['cart*']` saves on `cartAdd`, `cart$reset` and an undo of `cartAdd`. Without them it saves after every successful dispatch, as before.
- Added `indexedDbStorage()` and `persist().hydrate()`. `persist({ storage: indexedDbStorage() })` saves to IndexedDB, and `await hydrate()` reads the saved state from any storage. `load()` still reads a synchronous storage, and throws a TypeError naming `hydrate()` on one that answers promises. The outbox's `indexedDbOutbox` uses the same code, with unchanged behaviour.
- Changed `PersistOptions.storage` to `PersistStorage`, whose three methods may answer promises. `localStorage`, `sessionStorage` and any storage typed against 1.27 still fit.
- Added `routerFacts(router, bus)` to `vapor-chamber/router`. It emits `routerNavigated` after a committed navigation and `routerFailed` after a failed one, so bus listeners see navigations. It never dispatches.
- Added the `facts` option to `setupDevtools`, which shows the named emitted facts on a Facts timeline layer, such as `{ facts: ['router*'] }`.
- Improved the wording and order of the README, CONTRIBUTING and the store, router, performance, V8 rules and whitepaper docs, with no fact removed. The router guide now counts six loader rules, not five, and CONTRIBUTING no longer allows emoji in docs, which the ASCII check rejects.

## v1.27.0 - 2026-10-06

- Added `createActionFilter(expressions)`, which compiles CloudEvents filter expressions (`exact`, `prefix`, `suffix`, `all`, `any`, `not`) into an action-name predicate. It throws `core:invalid:filter` on what the spec rejects.
- Added the `actionFilter` option to every plugin that takes `actions` and to `PluginParts`. Given both, both must match, and `actions` is unchanged.
- Added `ActionScope`, the type of a plugin's `actions` filter, where absent or `[]` is every action, as before. It and `ActionList` are `string[]`, so code typed against 1.26 compiles unchanged.
- Added `ActionList`, the type of the mandatory list of `debounce`, `throttle` and `optimisticUndo`, where `[]` is none.
- Changed the store option `actions` to `reducers`, as in `defineChamberStore(id, { state, reducers: { add: (s, id) => ... } })`. Each key names an action, so `add` on store `cart` is `cart.add` and `cartAdd`.
- Changed `ChamberStoreOptions` to hold the map under `reducers`. Rename the key in typed options.
- Changed `StoreAction` to `StoreReducer`.
- Fixed `debounce([])`, `throttle([])` and `optimisticUndo(bus, [])` acting on every action since v1.26.0. An empty list acts on none again, as in 1.25.
- Fixed `cache`, `idempotent` and `debounce` answering a `$` command, such as `store.$reset()` or an undo, from memory. `throttle`, `rateLimit` and `circuitBreaker` may still refuse one, as before.
- Updated `RegisterOptions.undo` to state that the original command it receives carries that dispatch's signal, which `supersede` may have aborted.
- Fixed the Vue todo example giving a todo a new id on redo. The id is now sent with the command.
- Fixed an abort of a dispatch having three shapes. A handler or plugin that rethrows the signal's reason now gets `core:aborted:dispatch`, not the raw DOMException or `plugin:failed:plugin`, and every abort is a BusError named `AbortError` with the reason as `cause`. Code that checked `instanceof DOMException` after a mid-flight abort reads `e.cause`.
- Fixed a transactional batch rolling back a copy of each command instead of the command that ran. A store with `undo: true` in the batch now returns to its state before the batch, where before the command object became its state, and the `$undo` command's `causationId` names the command that ran.
- Fixed an `undo: true` store erasing every later write when an older step is rolled back, as `optimisticUndo` and a failed batch do. The store now re-applies the later steps, writes from other tabs included.
- Fixed an undo for a step a store does not hold writing a command object into its state. It now changes nothing.
- Fixed a redo of an `undo: true` store step running the reducer again, so a minted id came back different. The store now writes the state the action produced, the same object.
- Fixed history undoing locally a command a bridge sent, and sending it again on redo. Such a step now reads `canUndo` false. Reverse a server write with a compensating command.
- Added a development check to `undo: true` stores: each reducer runs twice, and two different results warn once per action. Mint ids and times in the call.
- Updated `RegisterOptions.canUndo` to state that a rollback, by `optimisticUndo` or a transactional batch, does not consult it.
- Fixed the async bus and the HTTP client re-sending a write when nothing identifies it, after no reply, a 502 or 504, or a verdict with `Retry-After`. It now fails once, no reply marked `context.outcome: 'unknown'` with a development warning. Key the command or declare the action idempotent to keep the re-send. The client also waits the `RateLimit` header's `t` when a policy has no quota left.
- Fixed a request header sent in two spellings, such as an app `idempotency-key` beside the bridge's `Idempotency-Key`, going out once with both values joined. Each name now goes out once, under its first spelling with the last value, and a FormData upload or a 419 refresh deletes a name in every spelling.
- Fixed a `share` store opened later losing its first writes to a tab that had written before. A tab now asks for the current state when it opens, and its next write builds on it.
- Security: fixed `authGuard({ protected: ['admin*'] })` protecting nothing. A trailing `*` now reads as the prefix it names, and `'*'` protects every action.
- Fixed one idempotency key standing for two requests. `idempotent()` now adds the payload to its default key, and the outbox gives each queued record its own key, so a second write is never answered or dropped as the first. Keys without a payload, custom keys and stored records are unchanged.
- Fixed the async bus's `request()` answering two requests with different payloads with one result, and a joined caller waiting on another caller's timeout and abort. Each caller now keeps its own wait, and the responder receives the command the plugins saw.
- Fixed the batching bridge sending a dispatch aborted while it waited for its window, and reporting it `ok`. An aborted dispatch now settles `core:aborted:dispatch` at once and is never sent, and a sent batch is cancelled once every command in it has aborted.
- Fixed a GET made after a write to its URL joining a read already in flight from before the write. A write, or `invalidateCache`, again stops new reads joining it.
- Fixed `circuitBreaker` opening on the caller's own cancels, such as `supersede` cancelling a search. An abort no longer counts as a backend failure.
- Fixed `createReaction`'s `maxHops` missing an indirect cycle such as `a -> b` plus `b -> a`. Every reaction on a bus now shares one hop count.
- Fixed the MCP handler against the 2025-06-18 spec: `initialize` answers only a version it speaks, an unknown or not allowed tool is the JSON-RPC error -32602 instead of an `isError` result, and a request with `id: null` gets -32600. In tests, `mcpClient().call` of an unlisted tool now rejects with `code: -32602`.
- Fixed `useCommandError` and `useCommandHistory` throwing on a sealed bus. Like `useSharedCommandState`, they now observe it, and the bus stays sealed.
- Fixed a `NaN` option failing open in `rateLimit` (`max`, `window`), `createReaction` (`maxHops`), `pollWith` (`interval`, `maxWait`), `useCommandError` and `useSharedCommandState` (`maxSize`) and `createSSRPlugin` (`maxSize`). A `NaN` now behaves like the missing option.
- Fixed a schema key written as `cart_add` typing only that name while the bus validates and lists `cartAdd`. The camelCase name is now a typed name too, the raw one still compiles, and the development warning says to use the camelCase name. It no longer prints in production.
- Fixed `createTestBus().dispatchBatch` ignoring `transactional` and `continueOnError`. It now runs the bus's own batch rule, rollback included.
- Changed `optimisticUndo` to accept an async bus in its types, as its example and `history()` do. Fixed the docs of `ErrorCodeEntry.retryable`, the `inspectBus` example and a test-helper example to say what the code does.
- Added `ActionSchema.annotations`, MCP's `ToolAnnotations` (`readOnlyHint`, `idempotentHint`, `destructiveHint`, `openWorldHint`, `title`). The MCP handler lists them on each tool, and `readOnlyHint` or `idempotentHint` makes the async bus treat the action as idempotent when `retry` is unset.
- Changed the async bus's `retry: { actions }` to `retry: { actionPolicies }`, and `RetryDeclaration` to `RetryPolicy`. The most specific match now wins (an exact name, then the longest prefix, then `*`), whatever the written order, so `cartAdd: false` is never re-sent because of an earlier `'cart*'`. Rename the key and the type.
- Changed `createMcpHandler`'s allowlist from `actions` to `actionFilter`, its one selection. Replace `actions: ['cart*']` with `actionFilter: createActionFilter([{ prefix: { action: 'cart' } }])`, and `['*']` with `createActionFilter([])`. To expose nothing, do not mount the handler. A leftover `actions` is ignored, so every schema action is exposed.
- Fixed a redo doing nothing when `cache` or `idempotent` had kept the command's first answer: the store stayed undone and history read it as redone. Once an undo lands, the bus calls the new `PluginParts.forget(cmd)` on every plugin, and those two drop that answer.
- Fixed a custom `key` on `cache` or `idempotent` answering a `$` command, such as `store.$reset()`, with an app command's stored answer when the two keys matched. A `$` command now always takes the default key.
- Fixed `idempotent` joining a second `$reset` or undo to the first one still in flight, so the second never ran. A `$` command now always runs.
- Added the store option `answer(state, value, cmd)`: a bridged store action writes the server's answer as one step of that command. Without it, nothing changes.
- Added `RegisterOptions.answer(cmd, value)`, called when a transport answered in place of the handler, before the plugins outside it.
- Added the store option `version(state)`: an answer older than the held state is not written. An answer with no `state` writes nothing.
- Added `stores` to the wire answer, store states by store id: `{ state, stores: { cart: {...} } }`. Each store with that id takes its state, over its own `answer`. A state that is not an object is not written. The Laravel example controller returns it.
- Fixed the HTTP client serving a stale GET after a write named that URL in `Location` or `Content-Location`. A write now drops those URLs too, on its own origin only.
- Changed `idempotent`'s `maxKeys` to `maxSize`.
- Changed `metrics`' `maxEntries` to `maxSize`.
- Changed `createOutbox`'s `maxQueue` to `maxSize`.
- Changed `createSSRPlugin`'s `maxCommands` to `maxSize`.
- Changed `errorCap` to `maxSize` on `useCommandError` and `useSharedCommandState`.
- Changed the bus option `bufferLimit` to `maxBufferSize`.
- Changed `teardown()` to `dispose()` on `createSseBridge` and `createEchoBridge`.
- Changed `createChannel()`'s `close()` to `dispose()`.
- Changed `destroy()` to `dispose()` on the router and its history.
- Changed `VitestMcpServer.close()` to `disposeAsync()`.
- Fixed the README's `optimisticUndo` example calling the server from its inverse. The inverse now reverses the local change only.
- Fixed docs that named what the code lacks: an `onReceive` hook on `createWsBridge`, an LRU in `matchesPattern`, and a `vitest-pure` subpath (it is `vitest/pure`).
- Improved a sync `dispatch` on a bus with no plugin, hook or listener: 7 to 12 ns faster, it no longer allocates a meta nothing reads. A dispatch through plugins or listeners measures about 3 ns slower.

## v1.26.0 - 2026-10-04

The full notes, with each fix's mechanism, measurements and tests, are in docs/rc-alignment-log.md, section 37, under v1.26.0.

- Fixed esbuild and webpack shipping all of Vue to every app that uses the composables. Migrate: an esbuild or webpack app that imports its composables from `vapor-chamber/vue` (or `/vapor`) adds `define: { __VC_WIRED_BUILD__: 'true' }`. `vaporChamberWire()` defines it in a Vite build.
- Fixed `getCommandBus()` loading Vue in a Vue-less app. Every import path is unchanged.
- Fixed `router.destroy()` letting a navigation in flight commit: it now answers `cancelled`, and a cancelled Back walks no history.
- Fixed the HTTP client's cache keeping a read across `invalidateCache()`, `clearCache()` or a successful write to its URL.
- Fixed `revalidateRoutes` putting the pre-command data back on the page with `fetchLoaders({ cache })`. Added `refresh` to the loader context.
- Fixed `useSharedCommandState().isLoading` reading false for a key still in flight after a route change, and throwing on a sealed bus.
- Fixed `Retry-After` values outside RFC 9110's grammar (`-5`, `1.5`, `1e1`) being read as waits. They are ignored.
- Fixed `persist()` without `getState` failing every save: it throws a `TypeError` at setup.
- Changed the IIFE size budgets to the measured sizes (owner, 2026-10-01).
- Improved `useCommand().dispatch` and `useCommandQuery().query`: no closure per call, 2.7-3.9 ns less per dispatch.
- Improved a scoped plugin's `actions` filter: nothing allocated per dispatch, 4.6-6.6 ns less on a chain of four.
- Improved per-key `isLoading` tracking, about a quarter cheaper per dispatch (about 192 -> 146 ns).
- Fixed `isLoading` keys colliding across the `:` (action `'a:b'` with target `'c'` against action `'a'` with target `'b:c'`).
- Added the build profile: `vaporChamberWire({ profile: 'lean' })` trades speed for memory, and the default, `'performance'`, memory for speed. In performance, an unread `isLoading` key keeps its slot for reuse.
- Changed `vaporChamberWire()` to define `__VC_LEAN__: 'false'` by default, in a build and under the dev server, unless the app defines `__VC_LEAN__` itself.
- Improved a tracked dispatch on a sync bus: 0.645x, 44 ns less.
- Improved composable creation back to v1.25.0's speed.
- Fixed `useSharedCommandState().dispose()` called twice by one holder releasing the shared state under the next holder.
- Fixed one HTTP cache invalidation or write keeping unrelated reads in flight from being stored.
- Changed the full IIFE budget to the measured size again (owner: speed over size).
- Fixed an async bus refusing concurrent dispatches as nested (`core:exceeded:depth` on the 17th of 17 parallel ones). Depth is nesting, on both buses.
- Fixed a sync `query()` that queries itself overflowing the stack: it stops at depth 16.
- Changed listeners that change during a dispatch: a dispatch calls the listeners that existed when it started. Migrate: a listener added during a dispatch no longer runs in that same dispatch.
- Changed the IIFE budgets and the Blade-consumer ceiling to the measured sizes (owner: correctness first).
- Fixed a deduped GET obeying another caller's signal: each caller's signal rejects its own promise only.
- Fixed a store's `$reset()` being seen by no plugin: it dispatches `<id>$reset` and returns the dispatch result.
- Changed `$reset()` on an async bus to land when its promise settles. A plugin can refuse it, and `inspectBus().actions` lists it. Action names containing `$` are the library's, and the `naming` rule skips them.
- Added a development warning when `setCommandBus()` replaces a shared bus that `getCommandBus()` already handed out.
- Added `ok(value)`, `err(error)` and `countOption(value, fallback, min?, max?)` to the root, for app plugins.
- Fixed `schemaValidator`'s rejection and `rehydrate()`'s refusal returning a result of their own shape.
- Changed every built-in plugin to name itself in its failures (`serialize:failed:plugin`). The bridges are `transport`, and a plugin with no `id` stays `plugin:failed:plugin`.
- Changed four uncoded failures to carry a code: `schemaValidator:invalid:payload`, `ssr:invalid:bus`, `schema:missing:adapter`, `directive:timeout:dispatch`.
- Changed a 401 or 419 to read `unauthenticated` (was `refused`), and a 409 or 412 `conflict` (was `already`). Migrate: a rule that matches `remote:already:...` or a 401's `remote:refused:...` follows the new codes.
- Changed a failure's RFC 9457 problem to carry `type`, the URI of its condition in `docs/errors.md`. Added `docs/errors.md`, generated from `ERROR_CODE_REGISTRY`.
- Improved a sync dispatch with listeners and no plugin: 235 -> 207 ns.
- Changed (breaking) a scoped plugin to declare `actions`, and the bus to run it only on those. Migrate: a plugin of your own declares `actions` the same way. `debounce`, `throttle` and `optimisticUndo` take patterns.
- Added `pollWith`, which follows a command answered 202 to its end and emits `<action>$done`.
- Added `meta.request`: headers a plugin sets for the HTTP bridges to send.
- Changed (breaking) the command envelope to one shape on every wire, `{ id?, command, target, payload?, meta? }`. Migrate: a backend reads the idempotency key from `meta`, since the batch's top-level `idempotencyKey` is gone.
- Removed (breaking) `CommandsOf`: use `InferMap`. Removed the `window.__VUE__` fallback: use `window.__VAPOR_CHAMBER_VUE__` or `configureVue()`.
- Added `meta.response`: the status, headers, `url` and `redirected` of the 2xx a bridged reply arrived in.
- Changed (breaking) the HTTP client's failures to the core's `BusError`, and removed `HttpError`. Migrate: `error.response.status` is `error.context.status`, and `problemOf(error)` reads the problem. The full mapping is in the full notes.
- Added `undo: true` on a store, so `history` can undo a store action.
- Added `vapor-chamber/store/core`, the store with no Vue.
- Added `share` on a store, to share it across tabs.
- Added a store's field events, `$onField` and `fieldRef`.
- Removed `csrf: 'inertia'` on the HTTP bridges. Migrate: use `csrf: true`.
- Fixed `vaporChamberHMR()` tripping the shared-bus warning on every dev server start.
- Added `problemOf(error)`, the backend's RFC 9457 problem behind a failure.
- Changed a query change to win over a page navigation still in flight: the pending `push` answers `router:aborted:navigation`.
- Changed `authGuard`'s refusal to `authGuard:unauthenticated:action`. Migrate: a rule matching `authGuard:refused:action` follows.
- Changed `register()` and `createTestBus` to refuse an action name containing `$` (`core:invalid:name`), and a store to refuse one in its id or keys (`store:invalid:name`).
- Changed a history the app supplies that throws writing the URL to fail as `router:failed:history`.
- Improved a store with `undo: true`: about +800 ns -> +60 ns per action.
- Changed the routes reader to read plain JSON, and renamed `unwrapRoutesPayload` to `readRoutesPayload`. Migrate: a backend that wrapped its routes table in `{ state }` returns the table itself.
- Changed every undo to run as a command, `<action>$undo`, which a plugin can refuse. On an async bus a `redo()` in the same tick as an `undo()` does nothing.
- Added `canUndo` beside `undo` in `register()`.
- Changed (breaking) the router's failures to the core's model, owner `router`. Migrate: every code changes (`unmatched` is `router:missing:route`), `isRouterError` takes the full code, and the target is `error.context.to`. The full mapping is in the full notes.
- Changed `HARD_NAV_CODES` to add `router:missing:component`. A guard that throws no longer hard-navigates.
- Changed `vapor-chamber/vapor` so a Vite build with `vaporChamberWire({ entry: 'vapor' })` ships Vue's async Vapor code only when the app defines an async component.
- Improved a keyed command: `meta.idempotencyKey` is a slot of every `meta`, so keyed and plain commands share one shape. `'idempotencyKey' in cmd.meta` is always true.
- Added `HttpResponse.url` and `redirected`.
- Added `resolveNotModified`, so a 304 resolves. Fixed a GET joining another in flight with different headers.
- Fixed two quick Backs during a slow page ending a page off.
- Fixed a navigation to the page on screen letting a pending one commit after it.
- Fixed `router.destroy()` during `start()` leaving a live router behind.
- Fixed inline routes that are not JSON failing with a plain `SyntaxError`.
- Fixed `RouterError` coming in up to four shapes: `to` and `cause` are always own properties.
- Fixed the router docs: the Vapor outlet's retained bindings list `createIf`, and `RouteLocation.path` is the path as in the URL.
- Changed `OutboxRecord.queuedAt` to an RFC 3339 string. Migrate: `Date.parse(record.queuedAt)` gives the milliseconds.
- Changed the outbox to drop a record a validator rejects at replay, and report it as `'outboxRejected'`.
- Fixed the outbox looping on `Retry-After: 0`, and dropping a `409` that declared a `Retry-After`.
- Changed the outbox to back off while a backend keeps answering `Retry-After`: the wait doubles up to 30 s.
- Fixed three silent store failures: an action named like a store member, `url` fields without a router, and a stale `$dispose()` removing a newer store.
- Changed the store's setup refusals to carry codes: `store:missing:bus`, `store:missing:router`, `store:already:member`.
- Fixed a `Retry-After` over 30 seconds being ignored, and a long one being cut short.
- Fixed a `Retry-After` date being read as local time: only the three HTTP-date forms are read, each as GMT.
- Fixed a store defined again returning the first store: a different definition takes over.
- Changed the store's refusals to state the fact, with the advice in development only.
- Fixed the store docs: saved state enters a store through an action it declares.
- Updated the development dependencies within their ranges.
- Fixed the whitepaper to describe the library as it is, with its history moved to an appendix.
- Fixed the peer bench ratios, now a min-max band from `npm run bench:bands`. Removed nanoevents from the docs and the bench.
- Changed CI: the bench job reports only, and a new `perf-ab` job fails on a measured regression against the base.
- Added `VcTransition` (`vapor-chamber/transitions/vapor`), a transition for Vapor driven by the bus. Experimental.
- Updated to Vue 3.6.0-rc.10 (peer `>=3.5.0 || >=3.6.0-rc.10`).
- Improved with Vue 3.6.0-rc.10: `createDirectivePlugin()` on a Vapor child of a vDOM parent follows the root.
- Improved with Vue 3.6.0-rc.10: a function set on a widget property arrives as the function.
- Improved with Vue 3.6.0-rc.10: `:onClick="fn"` beside `v-vc-command` in a Vapor template is a listener.
- Fixed the Vapor `RouterOutlet`'s default slot going dead after a child route.
- Fixed a conditional default slot on the Vapor `RouterOutlet` never appearing if it started off.
- Fixed the docs: a function as a root prop of `createVaporChamberApp` is a getter.
- Fixed a throwing sync subscriber leaving `useCommand`'s `loading` stuck on true.
- Fixed the same throwing subscriber at five more sites: `useVaporAsyncCommand`, `createFormBus` `set()` and `submit()`, the router's commit and background lanes, `createWsBridge`, and both histories.

## v1.25.0 - 2026-09-29

The full notes, with each fix's mechanism, measurements and tests, are in docs/rc-alignment-log.md, section 37, under v1.25.0.

- Changed (breaking) every failure's code to `owner:condition:subject`, the owner bound by the wiring (`core`, a plugin's `id`, `transport`, `remote`). Migrate: compare the new strings. The full table is in the full notes.
- Changed (breaking) `RETRYABLE_CODES` to `RETRYABLE_CONDITIONS` (`limited`, `timeout`). Added `ownerOf(e)`, `conditionOf(e)` and `failureCondition(e)`.
- Removed (breaking) `BusError.severity`, `BusError.emitter` and the `BusEmitter` type. Migrate: whoever logs a failure picks its level, and the owner is in the code.
- Changed a plugin to declare its owner as `id` and to receive its `fail` as a third argument.
- Fixed a backend making a permanent refusal retryable with a library code string in a 2xx body. `code` is read-only.
- Changed `toJSON()` to the failure as an RFC 9457 problem. Only a `failed` condition captures a stack.
- Improved failures that captured a stack: 4-12x faster. The happy path is unchanged.
- Changed (breaking) the wire to one answer shape: `{ state }`, `{ redirect }`, or an RFC 9457 problem. Migrate: `{ ok: false, error, code }` and the `ok` flag are gone on both sides.
- Changed (breaking) `FormBus.setErrors` to take `[{ pointer: '/payload/<field>', detail }]`. The reference controller sends them for a `ValidationException`.
- Changed (breaking) retries to live in the async bus, by class, bounded and budgeted per bus. Removed `retry()` and `retrying()`. Migrate: use the bridge alone and declare actions in `createAsyncCommandBus({ retry })`.
- Changed a 500 or a handler's throw to be re-sent only for an action declared `'idempotent'` or a command with an idempotency key.
- Changed the bridges' `retry` and `noRetry` options to the bus's declaration. The IIFEs' `connect()` and `createApp()` take the bus's `retry` option.
- Changed the outbox to keep a record whose answer declared a `Retry-After`, and flush again after that wait.
- Changed the reference controller to answer `409 in_progress` with `Retry-After: 1`.
- Changed the IIFE bundles to target Chrome 100, Firefox 100 and Safari 16. Migrate: an older browser keeps the previous release's IIFE.
- Improved the async bus's `request()`: one promise settles, 2,958 -> 2,293 ns.
- Changed (breaking) `http.safe.*` to resolve `error` to the contract's problem. Migrate: read `error.detail` where you read `error.message`.
- Removed (breaking) `HttpError.status`. Migrate: read `error.response?.status`.
- Changed (breaking, types only) `Plugin` to be generic over either bus. Added `SyncPlugin`, `AsyncPlugin`, `PluginParts`, `onSettled` and `MaybeAsyncResult`.
- Changed `circuitBreaker()` and `rateLimit()` refusals to carry `context.retryIn`.
- Removed (breaking) `agentOrigin()` from `vapor-chamber/mcp`. Migrate: delete the `bus.use(agentOrigin())` line.
- Added `failureCondition` to the package root.
- Changed (breaking, reference controller) an `Idempotency-Key` that is not a Structured Field String to be ignored.
- Fixed the examples to teach the current shapes, with accessible buttons, live regions and 4.5:1 text contrast.
- Fixed the sprinkled-Blade example: `aria-disabled`, text in place of `innerHTML`, and a live status line.
- Changed source comments to state the current reason. The history stays in this file.
- Fixed the router's typed params: `int` and `bool` match only their type.
- Fixed `decodeQueryParam` handing out the location's own array, and `usePagination()`'s `page` reading as a string.
- Fixed `revalidateRoutes` failing the command it follows. Its error goes to `onError`.
- Changed (breaking, router) a routes endpoint to answer by the wire contract.
- Fixed `authGuard` refusing with a plain `Error`. It refuses with a code.
- Fixed a backend's 5xx never opening the circuit breaker.
- Fixed a history cleared during an undo coming back.
- Fixed `retry()` building an `Error` on every successful dispatch.
- Fixed `register()`'s cleanup removing a newer handler (KeepAlive with `max`).
- Fixed a store held outside any scope being disposed under its owner.
- Fixed `useCommand().register` answering from a deactivated KeepAlive page.
- Fixed `validator()` refusing with a plain `Error`. It refuses with `validator:invalid:payload`.
- Fixed the `Idempotency-Key` header: it is a quoted, percent-encoded Structured Field String. Migrate: upgrade the backend first.
- Changed error advice to development builds only. Migrate: match on `.code`, never on `.message`.
- Changed `register({ throttle })` and the `throttle()` plugin to share one gate.
- Changed the IIFE budgets down to the measured sizes.
- Added `announce()` and `setAnnouncer()`: status messages for assistive technology. A failed `v-vc-command` announces its failure.
- Fixed an undo the server refuses reading as undone. Both histories share one ledger.
- Added `form.setErrors()`, `form.aria()`, `form.errorId()` and `form.firstInvalid()`. `submit()` lands a field-carrying failure.
- Fixed a `role="button"` element with `v-vc-command` not working from the keyboard.
- Added route-change announcements and the router options `announce` and `focusOnNavigate`.
- Added `aria-current="page"` on the exactly active link.
- Fixed `v-vc-command` taking keyboard focus away: a button in flight gets `aria-disabled`, not `disabled`. Migrate: CSS keyed on `:disabled` uses `.vc-loading`.

## v1.24.0 - 2026-09-24

The full notes, with each fix's mechanism, measurements and tests, are in docs/rc-alignment-log.md, section 37, under v1.24.0.

- Fixed RFC 9457 problems losing their `code` and `detail`: the client parses `application/json` and any `+json` suffix, and sends `Accept: application/json, application/problem+json`.
- Fixed `application/json-seq` being parsed as JSON. It stays text.
- Fixed a batched or WebSocket result carrying `problem` resolving as a success. Added `ProblemDetails`.
- Changed the reference controller to answer every failure as `application/problem+json`. Migrate: upgrade the client first.
- Changed the mock backends to answer failures as problems, and their 500 to log the exception's text instead of sending it.
- Fixed the outbox's last uncovered branch, back to 100% coverage on all four axes.

## v1.23.0 - 2026-09-23

The full notes, with each fix's mechanism, measurements and tests, are in docs/rc-alignment-log.md, section 37, under v1.23.0.

- Fixed the backend's `code` being dropped when a failure arrived as data (`{ ok: false, code }` in a 200).
- Fixed a backend's `VC_` code choosing whether a failure was retried. Provenance comes from `emitter`.
- Changed seven codeless transport failures to `BusError`s with codes: `VC_TRANSPORT_REDIRECT`, `_PROTOCOL`, `_QUEUE_FULL`, `_CLOSED` and `_TIMEOUT`.
- Fixed a refusal inside a 2xx being re-sent.
- Removed `VC_CORE_HANDLER_THREW` from `RETRYABLE_CODES`: nothing minted it.
- Changed `HttpError` to a class. Its fields are unchanged.
- Changed (breaking) `sync` to `createChannel`, `SyncOptions` to `ChannelOptions` and `SyncLane` to `ChannelLane`. Migrate: rename the import and the call.
- Changed `buildRunner` to `@internal`. The export stays.
- Fixed the API reference listing `globalExpect` for `expect`, and its dead links to underscored names.
- Fixed the ASCII guard racing the A/B tests' generated tree.
- Removed the `--expect-stamp-drift` flag from `gate.mjs`'s usage line.
- Fixed fourteen false claims in ROADMAP, CONTRIBUTING, the Laravel and Vitest guides and three example READMEs.
- Added an upgrade note: from Vue rc.9 a Vapor directive's argument is a getter. Migrate: call `argument?.()`.
- Fixed one refused command holding the outbox forever. Added `'outboxRejected'`, `createOutbox({ isRetryable })` and `rejected` in the flush summary.
- Fixed `onRedirect` never firing with the reference controller, and the batching bridge ignoring it.
- Fixed the ASCII guard's test failing outside a git checkout.
- Fixed three whitepaper claims and one Laravel guide claim.

## v1.22.0 - 2026-09-21

The full notes, with each fix's mechanism, measurements and tests, are in docs/rc-alignment-log.md, section 37, under v1.22.0.

- Updated to Vue 3.6.0-rc.9 (peer `>=3.5.0 || >=3.6.0-rc.9`).
- Added `vcPayloadVapor` and `vcOptimisticVapor`: all three directives work on Vapor. Alias them `vVcPayload` and `vVcOptimistic`.
- Fixed a payload or optimistic binding written before `v-vc-command` being dropped on the first click on vDOM. Directive order does not matter.
- Changed (breaking) `v-vc:command` to `v-vc-command`, registered as `vc-command`. Migrate: rename the attribute, the registration and the local binding (`vVcCommand`).
- Fixed `v-vc:payload` doing nothing: the working spelling is `v-vc-payload`.
- Fixed `v-vc:command` doing nothing in every compiled Vapor template on rc.9.
- Fixed teardown following the latest binding instead of what was mounted.
- Changed the directive to hand one listener-options object to both `addEventListener` and `removeEventListener`.
- Added fixtures that run compiler output: KeepAlive, hydration, keyed and unkeyed `v-for`.
- Added a development warning when `createDirectivePlugin()` is installed on a Vapor app.
- Changed, from rc.9: a template `@click` on the same element runs before `v-vc-command` and can veto the dispatch.
- Changed (breaking) `sync` to carry facts on a fast lane, outside the dispatch chain: about twice as fast. Migrate: `sync({ channel, lane, events })`, no longer passed to `bus.use()`. `filter` is gone.
- Changed the Vapor directive's argument guard to development builds only.
- Fixed `createSSRPlugin()` recording nothing on an async bus, and `schemaLogger()` printing the error branch for every command.
- Added sweep tests for the `onSettled` rule, the prototype-key rule and the console-argument shape.
- Removed `check:tsc-gap`: a directive with no argument gives `vue-tsc` nothing to mistype.
- Added `npm run gate`, the whole check chain in order, failing fast.

## v1.21.0 - 2026-09-16

The full notes, with each fix's mechanism, measurements and tests, are in docs/rc-alignment-log.md, section 37, under v1.21.0.

- Added `vapor-chamber/vitest`: one setup-file line gives the dispatch matchers, a recorded shared bus per test, and a failed test's dispatches in its error.
- Added the `bus` and `asyncBus` fixtures, through `it` and `test` from `vapor-chamber/vitest`.
- Added `vc.tap`, `vc.stubGlobal`, `vc.stubEnv` and `vc.mcp`. The stubs return a disposable, so `using` restores them.
- Added `vapor-chamber/vitest/pure`: the same helpers and matchers with no side effect.
- Added `VcTestError`, with a code, a reason, a fix and a docs link for each diagnostic.
- Added `vaporChamberTest()` in `vapor-chamber/vite`: the setup file, `sharedBus.exclude` and an island project with a DOM.
- Added `vc-vitest-mcp`, an MCP server with `runTests`, `getTestResults` and `getCoverageGaps`. Added `createVitestMcp` in `vapor-chamber/vitest/mcp`.
- Added the exports `./vitest`, `./vitest/pure` and `./vitest/mcp`, and `vitest >=5.0.0` as an optional peer dependency.
- Changed this repository's suite to run on the plugin and its fixtures.

## v1.20.0 - 2026-09-15

The full notes, with each fix's mechanism, measurements and tests, are in docs/rc-alignment-log.md, section 37, under v1.20.0.

- Updated to Vue 3.6.0-rc.8 (peer `>=3.5.0 || >=3.6.0-rc.8`).
- Added `vaporChamberWire()` in `vapor-chamber/vite`: a Vite build wires Vue for an app that imports its composables from the root. Under the dev server it defines `__VC_WIRED__` only.
- Fixed the ESM build's development warnings being silent in a dev-server page. Fixed a code-split app shipping development-only strings.
- Fixed the probe-path hint firing on a server.
- Changed the Vapor outlet size guard to measure with Vite, against two limits.
- Added `vcCommandVapor`: `v-vc:command` in Vapor components.
- Added `useSharedCommandState().isLoading(action, target?)`, a per-key loading flag for the whole bus.
- Changed a plugin's throw or rejection to a `VC_PLUGIN_THREW` result. It is not retried, and `circuitBreaker` does not count it.
- Fixed `onMissing: 'throw'` skipping after-hooks and listeners: they see the failure, then the caller gets the throw.
- Fixed the HTTP client calling `onSessionExpired` on a 419 that survived the CSRF refresh. Only a 401 is session expiry.
- Fixed a stale meta CSRF token: on a 419 the token is read again from the `XSRF-TOKEN` cookie.
- Improved every IIFE: `BusError`'s fields are declared, so no class-field helper ships.
- Fixed `history()` recording a redo twice on an async bus. A redone command carries `meta.origin: 'redo'`.
- Changed a sealed bus to refuse `clear()`. Migrate: for HMR, call `unsealBus()` first.
- Changed `dispose()` to settle waiting `request()`s as aborted. The sync `request()` honours its `signal`.
- Changed the `VC_CORE_ABORTED` message to "was aborted".
- Fixed `coverage:doc` stamping low counts.
- Changed `alien-signals` to an optional peer dependency.
- Changed every ESM size row to a Vite production build of the built export: about 10% lower.
- Changed a before-hook's throw to a `VC_CORE_BEFORE_CANCEL` result. Migrate: what the hook threw is `result.error.cause`.
- Changed `dispose()` to run each installed plugin's `dispose()`.
- Changed what an undo handler or a redo dispatches to carry `meta.origin` `'undo'` or `'redo'`, never recorded.
- Fixed `v-vc:command` twice on one element stranding the first listener: the last binding wins.
- Added a development hint on `VC_CORE_NO_HANDLER` when a transport's `actions` filter missed the action.
- Added a guard that a `vapor-chamber/vapor` consumer imports no vDOM name from `vue`.
- Changed `retry()` to retry an error carrying an HTTP status only for 408, 429 and 5xx. Migrate: a handler that throws a 4xx and relied on a retry passes its own `isRetryable`.
- Fixed `createBatchingHttpBridge` dropping `status`, `code` and `response` from its error.
- Fixed `retry()` backing off on a user's abort.
- Fixed an HTTP `timeout` of `NaN` or `Infinity` aborting every request at once.
- Added `isRetryableStatus` and `classifyError` to the root, one rule each.
- Improved every result: one hidden class at every site.
- Improved async dispatch and query: one async frame fewer, about 13% faster.

## v1.19.0 - 2026-09-09

The full notes, with each fix's mechanism, measurements and tests, are in docs/rc-alignment-log.md, section 37, under v1.19.0.

- Updated to Vue 3.6.0-rc.7.
- Fixed `logger()`, `history()`, `circuitBreaker()`, `metrics()` and `persist()` reading a promise as the result on the async bus. Added `src/settled.ts`, the one rule they share.
- Fixed numeric options set to `NaN` failing open. A bad option falls back to its documented default.
- Fixed the router hanging the tab on a cyclic parent chain: development throws `cyclic_parent`.
- Fixed two router base normalizers disagreeing on `'admin/'`.
- Fixed `decodeQueryParam` handing out the declaration's own array, and route `meta` being the table's own object.
- Fixed `START_LOCATION` being a writable module global shared by every router.
- Fixed `usePagination` rendering a "NaN" page link.
- Fixed `revalidateRoutes` cancelling refreshes of unrelated records.
- Fixed `matchPrefix` depending on the order its keys were written.
- Fixed the Vite plugin's transform never reaching a `.vue` file. `transformIndexHtml` reaches an app whose entry never names the package.
- Fixed a store dying with the component that created it: the last holder out disposes.
- Fixed two forms on one bus writing into each other. Added the form `id` prefix and `form.dispose()`.
- Fixed `buildFullUrl` treating `httpbin/get` as absolute.
- Fixed `generate-laravel` merging schema keys that normalize alike and emitting `class 2faVerify`. Both refuse.
- Changed `src/` to plain ASCII, checked by inversion.
- Fixed `createFormBus().submit()` running `onSubmit` twice on a double-click.
- Fixed four more prototype-key sites: `validator()`, `optimistic()`, `validateSchemas()` and `validateSchemasAsync()`.
- Fixed `defineVaporCommand()` and `useVaporAsyncCommand()` leaking reactive dependencies into a render effect.
- Fixed the router re-running a guard or `afterEach` hook that removed a later sibling.
- Fixed `createReaction`'s `maxHops` cap for payloads that are not objects.
- Fixed `preheatIdle()` leaving its abort listeners attached.
- Removed four pass-through wrappers in `command-bus.ts`: one microtask fewer per async query.
- Fixed two benchmarks that measured nothing.
- Changed the migration guides' peer ratios to stamped numbers.
- Fixed `configureVue` missing from every IIFE. It is on `elements` and `full`.
- Added a `/widget` page to the runnable Laravel example: a Vapor custom element on the `elements` bundle.
- Fixed the no-build widget snippets: they build the DOM node, since `h` is not on the global.
- Fixed the docs on `onRedirect`: it fires on the `{ redirect }` body field. `fetch` follows a 3xx itself.
- Changed the examples to npm workspaces: one install, one copy of `vue`.
- Fixed every development-only string shipping in production ESM bundles: about 10% of a small app.
- Changed the Vapor outlet's accepting bar to one stamped value.
- Fixed `measure-size.mjs` missing `./devtools` and `./stream-parser`. The list derives from `exports`.

## v1.18.0 - 2026-08-31

The full notes, with each fix's mechanism, measurements and tests, are in docs/rc-alignment-log.md, section 37, under v1.18.0. The date is the GitHub release's publish date.

- Added `vapor-chamber/router/vapor`, a Vapor-native `RouterOutlet` with no `vaporInteropPlugin`: about 20 KB brotli off a pure-Vapor app. Experimental.
- Added `mode_mismatch`: the Vapor outlet refuses a route component that is not `defineVaporComponent` output. Blade rows keep the vDOM outlet.
- Changed runtime error messages to use a plain hyphen.
- Fixed `setQuery()` returning a query that inherited from `Object.prototype`.
- Fixed a component key from the routes payload resolving inherited names such as `constructor`.
- Fixed `?tag=a&tag=b` and `?tag=a,b` comparing equal, so the loader never refetched.
- Fixed a guard redirect chain never settling: it stops at 10 hops as `redirect_loop`. A redirect during a `popstate` replaces.
- Fixed idle-preheat teardowns piling up after each bfcache restore.
- Fixed `createSseBridge`'s `reconnect` option doing nothing: `reconnect: false` closes on error.
- Added `revalidateRoutes`, which refreshes the loaders a command invalidates, from `vapor-chamber/router`.
- Changed (breaking) `vapor-chamber/router` to build no HTTP client: 12.4 to 9.6 KB brotli. Migrate: pass `http: routerHttp()` for a `{ url }` table and `fetchBlade: bladeFetcher({ http })` for blade rows, from `vapor-chamber/router/remote`.
- Added the `first load` and `on demand` columns to `docs/BUNDLE-SIZES.md`.
- Added the router codes `redirect_loop`, `no_router` and `http_unconfigured`.
- Added `vapor-chamber/store`: state whose every mutation is a command, 0.6 KB brotli. Experimental.

## v1.17.0

The full notes, with each fix's mechanism, measurements and tests, are in docs/rc-alignment-log.md, section 37, under v1.17.0. This version has no GitHub release, so it carries no date.

- Updated to Vue 3.6.0-rc.6 (peer `>=3.5.0 || >=3.6.0-rc.6`).
- Fixed, by Vue rc.6: `useCommand()` listeners piling up across HMR reloads.
- Added `vapor-chamber/vapor`, a static entry: a Vapor app needs no `configureVue()` call. It leaves out `defineVaporCustomElement` and `vaporInteropPlugin`. Migrate: add either with `configureVue({ ... })`.
- Removed the `vue-with-vapor` shim from both Vapor examples: Vue's own entry carries Vapor since rc.5.
- Fixed `vapor-chamber/vue` omitting `hasInjectionContext`, so the KeepAlive guard was inert in production.
- Changed the docs to say `configureVue()` merges: an entry left out stays as it was.
- Improved wildcard listener fan-out: 1.14-1.32x, 0 B brotli.
- Improved router active-link stamping: 1.77-1.86x.
- Fixed ROADMAP: all four wrapped Vapor APIs import statically from `vue`.

## v1.16.0 - 2026-08-24

The full notes, with each fix's mechanism, measurements and tests, are in docs/rc-alignment-log.md, section 37, under v1.16.0. The date is the GitHub release's publish date.

- Updated to Vue 3.6.0-rc.5 (peer `>=3.5.0 || >=3.6.0-rc.5`).
- Fixed `<Transition v-bind="t">` writing `phase` and `dispose` onto the element as attributes. They are not enumerable.
- Changed `meta.ts` to be read once per microtask turn: about 1.4x on a dispatch. No option.
- Fixed four sites that used an outside string as a key on a plain object: `parseQuery`, `defaultAffects`, `form.ts` and `commandKey`. Added `src/dict.ts`.
- Changed the KeepAlive gate on `hasInjectionContext()` to permanent: Vue keeps `getCurrentInstance()` null in Vapor by design.
- Fixed a blank line breaking the whitepaper's alignment table.
- Fixed the rc.4 log row holding the live count markers.
- Fixed the router's Vapor interop measurement: re-verified on rc.5.

## v1.15.0 - 2026-08-17

The full notes, with each fix's mechanism, measurements and tests, are in docs/rc-alignment-log.md, section 37, under v1.15.0. The date is the GitHub release's publish date.

- Updated to Vue 3.6.0-rc.4 (peer `>=3.5.0 || >=3.6.0-rc.4`).
- Fixed KeepAlive pause and resume being inert in every Vapor component: the gate reads `hasInjectionContext()`.
- Security: fixed an MCP `tools/call` accepting names `tools/list` never listed (`constructor`, `__proto__`, `toString`, `hasOwnProperty`, `valueOf`).
- Added two limits to the stdio MCP transport: `maxLineLength` (1 MiB) and `maxInFlight` (32). Replies go out as each call completes.
- Added a coverage pass: 99.9 / 97.8 / 99.6 / 99.9, with higher enforcement floors.
- Added stamped test counts and coverage in the README and whitepaper.
- Removed three branches that had no producer.
- Removed (breaking) `useCommandBus()`. Migrate: rename it to `getCommandBus()`.
- Improved the transition bridge: action names resolve once per bridge, 1.77x per hook dispatch.
- Improved `useCommandGroup`: namespaced names are cached, up to 256.
- Changed three developer-mistake warnings to development builds only.
- Changed `defineVaporComponent`, `defineVaporCustomElement` and `defineVaporAsyncComponent` to warn in development when they return `null`.
- Added `npm run ab:vue`, an interleaved A/B of two Vue builds.
- Added tests running the router composables inside real Vapor components, and `npm run test:vapor`.
- Added coverage for the router's scroll, inline routes and idle preheat, and the outbox's storage failures.
- Added gates that check the plain-HTML examples' imports and IIFE globals.
- Fixed `pattern-1-blade-cdn.html` loading a path above the repository.
- Added `scripts/stamp-docs.mjs`: `vc:` markers in the docs, rewritten from `package.json`. CDN snippets read `vapor-chamber@<version>`.
- Added a fixture running eight composables inside a real Vapor component.
- Fixed two drifted figures in source comments: `uid()` against `crypto.randomUUID()`, and `shallowRef` against `ref`.
- Fixed the whitepaper on `onUnmounted()` in Vapor: it fires.
- Fixed ROADMAP naming withdrawn build-flag work as pending.

## v1.14.0 - 2026-08-15

The full notes, with each fix's mechanism, measurements and tests, are in docs/rc-alignment-log.md, section 37, under v1.14.0. The date is the GitHub release's publish date.

- Added `{ signal }` to `on()` and `once()`: the listener leaves when the signal aborts.
- Added `Symbol.dispose` on every unsubscribe function, so `using off = bus.on(...)` works.
- Fixed coverage gaps in `command-bus.ts`, now 100% on all four axes.
- Fixed two whitepaper asides that described current code as history.

## v1.13.0 - 2026-08-12

The full notes, with each fix's mechanism, measurements and tests, are in docs/rc-alignment-log.md, section 37, under v1.13.0. The date is the GitHub release's publish date.

- Updated to Vue 3.6.0-rc.3 (peer `>=3.5.0 || >=3.6.0-rc.3`).
- Added `vapor-chamber/vue`, a static entry, which fixes `untracked()` doing nothing in production bundles. Added `enableVueReactivity()` for code that keeps importing from the root.
- Added `@vue/reactivity` as an optional peer dependency.
- Fixed Vapor detection missing a Vue that is on the page: added the `__VAPOR_CHAMBER_VUE__` global and `configureVue(vue)`.
- Changed the detection error to name its cause: Vue absent, Vue without Vapor, or Vue present but unreachable.
- Fixed the docs: Vapor supports custom directives (`withVaporDirectives`).
- Fixed the router docs' instruction to remove `tryKeepAliveHooks`: the guard stays.
- Changed the Node floor to 22.12.
- Fixed `tests/router/typed-names.test-d.ts` never being compiled.
- Security: cleared two development-only advisories (`nanoid`, `brace-expansion`). `npm audit` reports 0.
- Removed `typedoc-plugin-markdown`: nothing used it.
- Added the build flags `__VC_IIFE__` and `__VC_DEV__`: every IIFE got smaller.
- Fixed a dispatch from inside a Vue effect making the caller depend on what the handler read. The composables suspend tracking, and `untracked(fn)` covers a raw bus.
- Updated the examples on rc.3, at 0 audit findings.
- Removed `.npmignore` again: `files` decides what ships.

## v1.12.0 - 2026-08-10

The full notes, with each fix's mechanism, measurements and tests, are in docs/rc-alignment-log.md, section 37, under v1.12.0. The date is the GitHub release's publish date.

- Added coverage tests and raised the floors: 1421 tests, 91.0% branches.
- Fixed the API reference covering 6 of about 18 public subpaths. It covers all of them.
- Fixed a redo with a primitive payload being recorded twice.
- Changed (breaking) the HTTP response cache and in-flight dedupe to one per client. Migrate: on a server, create a client per request.
- Changed (breaking) `invalidateCache(string)` to match a literal substring. Migrate: pass a `RegExp` for a pattern.
- Fixed the plugin runner's `next` skipping every plugin after `retry()` on a second attempt.
- Fixed a 4xx re-entering the HTTP retry loop: a 422 on a POST was re-sent.
- Fixed `stream-parser` crashing on a long string value.
- Fixed a throwing `afterEach` hook un-committing a navigation.
- Fixed a self-removing guard, hook or listener skipping or re-running its neighbour.
- Added `createFastLane({ removal: 'snapshot' })`, copy-on-write removal for faster fan-out.
- Fixed `form.submit()` validating one set of values and submitting another, and running twice on a double-click.
- Fixed `createWorkflow` compensating with the original arguments instead of the step's own.
- Fixed `cache()`'s `invalidate()` deleting nothing with a custom `key`.
- Fixed `schemaValidator` passing a `null` or scalar target, and a scalar for an `'object'` field.
- Fixed four flags that did not hold across an await on the async bus: `agentOrigin`, `redo()`, `createReaction` and the test bus's `meta`.
- Changed `agentOrigin` to a no-op: the core stamps MCP origin.
- Changed `createReaction` to refuse a reaction that matches its own action unless `allowSelfMatch: true`. Added `maxHops` (default 8).
- Fixed `sync()` never broadcasting on an async bus.
- Fixed the `BatchOptions.signal` docs: an abort reads `VC_CORE_ABORTED`.
- Added loader caching: `fetchLoaders({ cache })`, with `meta.cache` per route row.
- Added `router.isRevalidating`, for a stale page refreshing behind the scenes.
- Added `rehydrateAsync()`, and a refusal when `rehydrate()` meets a promise.
- Added `ssr.dropped()` and a warning when the SSR command cap drops commands.
- Changed cached values to be frozen in development.
- Added development warnings: `setRouteData` on an unknown record, `createMcpHandler` with no `actions`, and `dispatchBatch` with `transactional` and `continueOnError`.
- Added `scripts/check-env-guards.mjs`: no unguarded `process.env` reads in `src/`.
- Fixed a fresh clone failing `npm test`.
- Fixed two bare `process.env.NODE_ENV` reads crashing the router with no bundler.
- Fixed `v-vc:command.delegate` in a second document and inside shadow DOM.
- Fixed `usePagination({ key })` losing Back through pages.
- Changed `vaporChamberHMR` to declare `apply: 'serve'`, with a correct sourcemap.
- Fixed `MCP_SERVER_VERSION` advertising an old version.

## v1.11.0 - 2026-07-31

The full notes, with each fix's mechanism, measurements and tests, are in docs/rc-alignment-log.md, section 37, under v1.11.0. The date is the GitHub release's publish date.

- Changed (breaking) `RouterOutlet`, `makeBladeComponent` and `BladeHooks` to `vapor-chamber/router/vdom`, with no global registration. Migrate: import `RouterOutlet` from the new subpath and register it where you use it.
- Fixed a query change during a navigation dropping the navigation without an error.
- Fixed `isLoading` clearing while a refetch was in flight.
- Improved static routes: they resolve through a map, about 240x faster for a late static row.
- Added the Vapor interop section to `docs/router.md`.
- Changed the README: rewritten against the docs, 1651 to 1300 lines.
- Added the router subpaths to `scripts/measure-size.mjs`.

## v1.10.0 - 2026-07-31

The full notes, with each fix's mechanism, measurements and tests, are in docs/rc-alignment-log.md, section 37, under v1.10.0. The date is the GitHub release's publish date.

- Updated to Vue 3.6.0-rc.2.
- Added `.delegate` on `v-vc:command`: one shared document listener for a large `v-for` list. Slower to mount, fewer listeners while mounted.
- Updated `vue-tsc` to 3.3 in both Vapor examples, clearing four development-only advisories.
- Fixed a flaky DevTools test.
- Fixed two API misuses in `pattern-6-vapor-router.ts` and a sync handler on an async bus in `feature-transports.ts`.
- Added a type-check of every top-level example script.
- Added branch coverage: 88.92% to 90.39%.
- Added the whitepaper's note on Vapor detection in no-bundler pages.

## v1.9.0 - 2026-07-22

The full notes, with each fix's mechanism, measurements and tests, are in docs/rc-alignment-log.md, section 37, under v1.9.0. The date is the GitHub release's publish date.

- Updated to Vue 3.6.0-rc.1.
- Changed the coverage gate to measure only the library, `devtools.ts` included, with higher floors.
- Added `usePagination()` in `vapor-chamber/router`: pagination driven by the URL.
- Added `createBatchingHttpBridge`: the commands of one microtask go in one POST.
- Added `ActionSchema.authorize`: `generate-laravel.mjs` emits a Gate check.
- Added the `supersede` plugin: a newer dispatch of a key cancels the one in flight.
- Added `vapor-chamber/router` and `vapor-chamber/router-fetch`: a router over a server catch-all, with a loader SPI.
- Added `vapor-chamber/stream-parser`, an incremental JSON parser for streamed responses.
- Added `cache.staleTtl` and `cache.serveStaleOnError` on the HTTP client.
- Added `classifyError`, the one rule for a transient failure.
- Added `config.silent`, which marks a request's errors for a global handler to skip.
- Fixed a timeout skipping the HTTP retry.
- Removed `.npmignore`: `files` decides what ships.
- Fixed every IIFE global being nested as `VaporChamber.VaporChamber`.
- Changed (breaking) `useQueryParam()` to return a real `Ref`. Migrate: `{{ page.value }}` in a template becomes `{{ page }}`.
- Fixed `{ inline }` route tables ignoring the payload's `base`, so no link was intercepted.
- Fixed an unmatched URL reloading forever behind a catch-all.
- Fixed a malformed path segment compiling to a dead route: development throws `invalid_path`.
- Changed (breaking, development tooling) `setupDevtools` to `vapor-chamber/devtools`. Migrate: change the import.
- Fixed the optional `@vue/devtools-api` peer breaking every Vite and Astro app.
- Fixed `exo-astro`'s nested bindings never updating. Added `v-each`, `scopeOf(el)` and an idempotent `scan()`.
- Fixed every example running a stale copy of the library. Added `examples/ensure-lib.mjs` and `examples/static-server.mjs`.
- Added `examples/router-demo/`, the first runnable router.
- Fixed `feature-directives.html`, `sprinkled-blade` and `pattern-1-blade-cdn.html`, which did not run as documented.
- Added a CORS section to the Laravel guide.

## v1.8.0 - 2026-07-04

The full notes, with each fix's mechanism, measurements and tests, are in docs/rc-alignment-log.md, section 37, under v1.8. The date is the GitHub release's publish date.

- Added the typed command contract: augment `GlobalCommands` once, and every `useCommand()` and `getCommandBus()` is typed.
- Added `defineSchema` and `CommandsOf<S>`: one schema gives typed dispatch, validation and LLM tools.
- Added `scripts/generate-laravel.mjs`: the Laravel registry and action stubs from the same schema.
- Added `vapor-chamber/outbox`: commands queue offline and replay in order with their original `Idempotency-Key`.
- Added `vapor-chamber/mcp`: an MCP server from a schema bus, with `busToMcpTools`, `createMcpHandler` and `serveMcpStdio`.
- Added `CommandMeta.origin`: `'user'`, `'remote'`, `'sync'`, `'replay'` or `'agent'`.
- Added `logger({ level, badges })`.
- Added `retryable` and `category` to every registry entry, `isRetryableCode()` and `RETRYABLE_CODES`.
- Improved ESM bundles: `ERROR_CODE_REGISTRY` tree-shakes, 7.0 to 6.1 KB brotli on the reference app.
- Added a development warning for an async plugin on a sync bus.
- Changed `setCommandBus` to accept an `AsyncCommandBus`.
- Fixed the HTTP bridge reporting `"HTTP 422"` instead of the backend's message.
- Fixed copy-paste bugs across every example folder.
- Fixed the Laravel Sanctum snippets routing to `/api/api/vc`.
- Fixed `setupDevtools` running in production browser builds.
- Fixed the `iife-core` and `iife-elements` exports pointing at files the build never made.
- Fixed a 401 firing `onSessionExpired` twice.
- Fixed retry sleeps and the `AbortSignal.any` fallback leaving abort listeners attached.
- Fixed concurrent 419 refreshes polling: they share one promise.
- Fixed a `json` and a `blob` request for one URL sharing a cache entry.
- Fixed the WebSocket bridge losing messages on a close mid-flush and opening a second socket.
- Fixed the directive leaving a 30 s timer after every click.
- Fixed `idempotent()` growing without bound: added `maxKeys` (500).
- Fixed `useCommandError` growing without bound: added `errorCap` (50).
- Fixed the README's first example and several stale claims.
- Changed `CommandResult` to a union on `ok`: `if (result.ok)` narrows.
- Improved the async bus: fewer microtask hops with sync hooks.
- Improved `schemaValidator`: per-action checks compile at creation.
- Changed `form.submit()` to run async field validators together.
- Changed packaging: `types` first, a `default` condition, a `sideEffects` array, `src/` in the tarball, and `vite >=5.0.0`.

## v1.7.0 - 2026-06-27

The full notes, with each fix's mechanism, measurements and tests, are in docs/rc-alignment-log.md, section 37, under v1.7.0. The date is the GitHub release's publish date.

- Updated to Vue 3.6.0-beta.17 (peer `>=3.5.0 || >=3.6.0-beta.17`).
- Updated the two Vapor SFC examples to Vite 8. Added `asRef()` so `vue-tsc` unwraps a signal in a template.
- Improved the dispatch path: the naming check is skipped on every path when no convention is set.
- Fixed in-flight WebSocket requests hanging until their timeout after a disconnect: they fail at once.
- Added event modifiers on `v-vc:command`: `.stop`, `.prevent`, `.self`, `.left`, `.middle`, `.right`, `.capture`, `.once` and `.passive`.
- Removed (breaking) `useVaporCommand`: `useCommand` carries its whole API. Migrate: rename the call.
- Added `examples/README.md`, an index of every example.
- Removed `useVaporAsyncCommand`'s listener array: nothing could fill it.
- Changed, by Vue beta.16: `onLeave` fires for a root removed after a `v-show` branch.
- Changed, by Vue beta.16: `createVaporChamberApp(...).mount('#missing')` returns `undefined` with a warning, and `.unmount()` works in production.
- Fixed two Vue version attributions in the docs.
- Added tests that take `command-bus.ts` to 100% coverage.
- Improved buffer-mode buses: the buffer is created on first use.
- Fixed the docs' coverage and dispatch-depth claims (the depth limit is 16).
- Changed the performance docs to the measured ratios, in both directions.
- Added `disposeAll(fns)`: one teardown helper for five sites.
- Fixed `commandKey` dropping nested object keys, so different targets collided. Migrate: a cache key built from it changes shape once.
- Security: cleared three development-only advisories. `npm audit` reports 0.
- Updated the toolchain: Vite 8 (rolldown), TypeScript 6.0, Biome 2.5 and Vitest 4.1.
- Added `docs/BUNDLE-SIZES.md`, generated by `npm run size:doc`, and `npm run loc`.
- Changed CI: a lint and typecheck job, and every action pinned to a commit.

## v1.7.0-Candidate

The full notes are in docs/rc-alignment-log.md, section 37, under v1.7.0-Candidate. This candidate was never released, so it carries no date. Its changes shipped in v1.7.0.

- Updated to Vue 3.6.0-beta.16 (peer `>=3.5.0 || >=3.6.0-beta.16`).

## v1.6.0 - 2026-06-14

The full notes, with each fix's mechanism, measurements and tests, are in docs/rc-alignment-log.md, section 37, under v1.6.0. The date is the GitHub release's publish date.

- Updated to Vue 3.6.0-beta.15 (peer `>=3.5.0 || >=3.6.0-beta.15`).
- Fixed `useSharedCommandState` missing failures from other dispatch paths: it records every failed command on the bus.
- Fixed `vaporChamberHMR()` making Vue detection impossible in Vite dev.
- Changed `v-vc:command` to skip a dispatch on a disabled or `aria-disabled` element, or one already in flight.
- Added `history({ undoAction, redoAction })`: the plugin registers its own triggers and never records them. Added `dispose()`.
- Added `bufferTTL` and `onBufferOverflow` for `onMissing: 'buffer'`.
- Added a development warning when a `signal()` was created before Vue was detected.
- Added an opt-in return type on the Vapor wrappers: `defineVaporComponent<MyComp>(opts)`.
- Added a `prepare` script, so an install from GitHub builds `dist/`.
- Added an SSR concurrency warning: create a bus per request.
- Changed the per-beta source headers to one line per version.
- Changed the README's opening and the bench labels.
- Added `examples/laravel-app/`, `examples/exo-astro/` and `examples/vapor-island-cart/`.
- Fixed `examples/vapor-sfc` building without the Vapor runtime.

## v1.5.0 - 2026-06-07

The full notes, with each fix's mechanism, measurements and tests, are in docs/rc-alignment-log.md, section 37, under v1.5.0. The date is the GitHub release's publish date.

- Updated to Vue 3.6.0-beta.14 (peer `>=3.5.0 || >=3.6.0-beta.14`).
- Changed `signal()` to wire Vue's `shallowRef()`: array state about 3.4x faster. Migrate: mutating `state.value.x` in place no longer triggers. Use `vapor-chamber/reactive` for deep state.
- Changed the out-of-scope composable warning to fire once per module, worded as a hint.
- Improved `onMissing: 'buffer'`: the buffer is created only when that mode is set.
- Changed `npm test` to run once and exit. Added `npm run test:watch`.
- Added coverage of `chamber.ts` and the saga compensation paths.
- Changed ROADMAP to a feature-lock posture with a Vue support matrix, and the whitepaper's beta addenda to one alignment table.
- Added `createEchoBridge`: Laravel Echo and Reverb broadcasts onto the bus.
- Added `onMissing: 'buffer'`: a command dispatched before its handler waits and runs when the handler registers.
- Added the `idempotent` plugin: duplicates run once. The HTTP bridge sends the key as `Idempotency-Key`.
- Added the `serialize` plugin: same-key async commands run one at a time, across tabs with `scope: 'cross-tab'`.
- Added `vapor-chamber/reactive`: `deepSignal()` and `useDeepCommandState()`.
- Changed the IIFE size budgets for the buffer and the shared state core.

## v1.4.0 - 2026-05-30

The full notes, with each fix's mechanism, measurements and tests, are in docs/rc-alignment-log.md, section 37, under v1.4.0. The date is the GitHub release's publish date.

- Updated to Vue 3.6.0-beta.13 (peer `>=3.5.0 || >=3.6.0-beta.13`).
- Changed, by Vue beta.13: `onMove` fires for Vapor and vDOM component moves in a Vapor `<TransitionGroup>`.
- Added bench groups for the transition bridge, `useCommandState` and Vue's reactive path.
- Improved the `signal()` fallback: a plain `{ value }` object.
- Improved the alien-signals adapter: one class, one hidden class.
- Changed `alien-signals` to a dependency.

## v1.3.0 - 2026-05-16

The full notes, with each fix's mechanism, measurements and tests, are in docs/rc-alignment-log.md, section 37, under v1.3.0. The date is the GitHub release's publish date.

- Updated to Vue 3.6.0-beta.12 (peer `>=3.5.0 || >=3.6.0-beta.12`).
- Added `useCommandState(initial, reducers, { coalesce: true })`: one signal write per microtask burst.
- Improved `bus.query()` on a bare bus: it calls the handler directly.
- Changed `stampMeta` to take only the payload.
- Improved the wildcard prefix cache: it evicts the oldest entry, not all of them.
- Changed `tryAutoCleanup` to check `getCurrentScope()`.
- Changed ten duplicate sync and async functions in `command-bus.ts` to shared ones.
- Changed `debounce` and `throttle` to key on `commandKey`.
- Added tests for `cache`, `circuitBreaker`, `rateLimit`, `metrics`, `createChamber`, `createWorkflow` and `createReaction`.

## v1.2.0 - 2026-05-09

The full notes, with each fix's mechanism, measurements and tests, are in docs/rc-alignment-log.md, section 37, under v1.2.0. The date is the GitHub release's publish date.

- Updated to Vue 3.6.0-beta.11 (peer `>=3.5.0 || >=3.6.0-beta.11`).
- Changed the build to Vite: one pass for ESM and the IIFEs, `tsc` for types only.
- Added three IIFE variants by audience: `core`, `elements` and `full`, with `connect()` and `defineWidget()`.
- Improved ESM bundles without Vue: `signal` moved to its own module, about 9% smaller.
- Improved listener fan-out: exact and wildcard listeners are kept apart.
- Added `persist({ coalesce: true })`: one save per microtask burst.
- Changed the default `meta.id` to a counter with a random prefix: 2.26x faster. Added `configureUid(fn)`.
- Added CI, Biome, `scripts/check-size.mjs`, the tree-shake test, CONTRIBUTING.md, SECURITY.md and the issue and PR templates.
- Added `{ signal }` on async dispatch: `cmd.signal` reaches the handler and the HTTP bridge, and an abort reads `VC_CORE_ABORTED`.
- Changed the sync bus to accept `{ signal }` and ignore it.
- Added a coverage floor in CI.
- Added `emitDOMEvent(el, name, detail)`: a widget's event reaches the host page as a DOM event.
- Added `vapor-chamber/alien-signals`: `configureAlienSignals` backs every signal with alien-signals.
- Added the migration guides from mitt and from EventEmitter.
- Added `csrf: 'inertia'` and `onRedirect` on the HTTP bridge.
- Added `vapor-chamber/observable`: `observe(bus, pattern)` and `dispatchFrom(bus, action, observable)`.
- Added `vapor-chamber/standard-schema`: `validateSchemas` and `validateSchemasAsync` for Zod, Valibot, ArkType and others.
- Added four peers to the comparative bench.
- Added the API site on GitHub Pages and `npm run docs`.
- Added `examples/sprinkled-blade/` and `examples/vapor-sfc/`.
- Added `createFastLane()` in `vapor-chamber/fast-lane`: a narrow dispatcher for hot loops.
- Improved sync dispatch on a bare bus: 18% faster.
- Improved `bus.emit`: 9.9x with listeners, 52x with none. An emitted command carries no `meta`.
- Added `useSharedCommandState()`: one loading and error state shared across a bus.
- Added `{ signal }` on `bus.request()` and `bus.dispatchBatch()`, and abort on the WebSocket bridge.
- Added the Laravel guide and the drop-in PHP files in `examples/laravel-backend/`.
- Added ROADMAP.md.
- Removed `scripts/build-iife.mjs` and a stale version string in `src/iife.ts`.

## v1.1.0 - 2026-04-14

The full notes, with each fix's mechanism, measurements and tests, are in docs/rc-alignment-log.md, section 37, under v1.1.0. The date is the GitHub release's publish date. This section also holds the v1.0 work, which has no section of its own.

- Updated to Vue 3.6.0-beta.10 (peer `>=3.5.0 || >=3.6.0-beta.10`).
- Added `defineVaporCustomElement`, `defineVaporComponent` and `defineVaporAsyncComponent` wrappers. Each returns `null` without Vapor.
- Added `useVaporAsyncCommand()` for Vapor components under Suspense.
- Changed the Vite HMR plugin to keep the bus across a Vapor and vDOM mode switch.
- Added `createTransitionBridge()` and `useTransitionCommand()` in `vapor-chamber/transitions`.
- Added `useCommandQuery()`, a read-side composable over `bus.query()`.
- Added `createSSRPlugin()` and `rehydrate()` in `vapor-chamber/ssr`.
- Added `createHttpClient()`: every method, GET dedupe, an LRU cache, interceptors, `safe` mode, downloads and `create({ baseURL })`.
- Added `<meta name="xsrf-cookie">` to name the CSRF cookie.
- Added the `httpClient` option on `createHttpBridge`.
- Added `persist({ validate })`, which rejects stale saved state.
- Fixed `useCommand()`'s `loading` flashing on an async handler.
- Changed `useCommandHistory` and `useCommandError` to pause under a deactivated `<KeepAlive>`.
- Added `onMove` on the transition bridge.
- Added `query()` and `emit()` on `useCommandGroup()`.
- Changed `useCommandHistory().redo()` to dispatch the command again.
- Added `createFormBus({ bus })`, so form commands reach the shared bus.
- Added `dispatchBatch(commands, { transactional: true })`: a failure rolls back the commands that succeeded.
- Added the `optimisticUndo` plugin.
- Changed `createSchemaCommandBus` to validate by default. Opt out with `{ validate: false }`.
- Added `inspectBus(bus)`, `createCommandPool(size)`, `bus.seal()`, `unsealBus(bus)` and `bus.dispose()`.
- Added a dispatch depth guard, `VC_CORE_MAX_DEPTH`.
- Improved the dispatch path for V8: one result shape and index loops.
- Added `BusError`, `BusErrorCode`, `ERROR_CODE_REGISTRY`, `getErrorEntry()`, `describeErrorCodes()` and `busApiSchema()`.
- Changed every error message to state its fix.
- Added `createChamber`, `createWorkflow` and `createReaction`.
- Added the `cache`, `circuitBreaker`, `rateLimit` and `metrics` plugins.
- Added `Command.meta`: `ts`, `id`, `correlationId` and `causationId`.
- Added `bus.query()`, `bus.emit()` and `bus.registeredActions()`.
- Added `bus.onBefore()`, `bus.offAll()` and `bus.once()`.
- Added `successCount` and `failCount` on a batch result.
- Added `HttpError.code`, `noRetry` on the HTTP bridge and `maxQueueSize` on the WebSocket bridge.
- Added an `adapter` for `synthesize()`, so any LLM provider works.
- Added `BaseBus`, `commandKey`, `buildRunner` and `matchesPattern` to the exports.
- Added WHITEPAPER.md.
- Fixed throttle timers shared between buses, `BusError` dropping `cause`, `history` re-recording its own replays and `cache()` storing a promise.
- Fixed a 419 calling `onSessionExpired`: only a 401 does.
- Fixed the CSRF refresh re-reading the stale token.
- Fixed the HTTP bridge dropping the error body's message.
- Fixed `once()` skipping the listeners after it.
- Fixed async-function detection in minified builds.
- Added `useVaporCommand()`.
- Added a development warning for a composable used outside a Vue scope.
- Added `.vapor.vue` support in the Vite HMR plugin.
- Added `createFormBus({ reactive: false })`.
- Added `scopeController` on the HTTP bridge and `connected` on the WebSocket bridge.
- Changed form rules to allow async validators: `set()` runs sync rules, `submit()` awaits all.
- Added `createAsyncSchemaCommandBus`, `schemaValidator`, `describeSchema` and `bus.fromToolCall()`.
- Added the schema layer: `BusSchema`, `InferMap`, `createSchemaCommandBus`, `toTools`, `schemaLogger` and `synthesize`.
- Fixed eight core bus defects: `request()` skipping plugins, unguarded `onMissing` functions and more. Added `bus.hasHandler()`.

## v0.5.0 - 2026-03-22

The full notes are in docs/rc-alignment-log.md, section 37, under 0.5.0.

- Changed (breaking) action names to camelCase (`cartAdd`). Migrate: rename dotted and snake_case actions.
- Changed (breaking) wildcards to a `*` suffix: `cart*` matches `cartAdd`.
- Changed (breaking) a throttled dispatch to return `{ ok: false, error }` with `error.retryIn`.
- Added `useCommandGroup(namespace)` and `useCommandError()`.
- Added `createHttpBridge`, `createWsBridge` and `createSseBridge`, each with an `actions` filter.
- Added the `retry`, `persist` and `sync` plugins.
- Added `snapshot()`, `travelTo()` and `travelToAction()` on the test bus.
- Added `src/http.ts`: `postCommand`, CSRF from three sources, backoff and session expiry.
- Added `createFormBus()`.
- Changed `command-bus.ts` to module-level functions.
- Added a warning for an async plugin on a sync bus.

## v0.4.0 - 2026-03-20

The full notes are in docs/rc-alignment-log.md, section 37, under 0.4.0.

- Added `isVaporAvailable()`, `createVaporChamberApp()`, `getVaporInteropPlugin()` and `defineVaporCommand()`.
- Changed `tryAutoCleanup()` to prefer `onScopeDispose`.
- Changed the Node floor to 20.19 and the TypeScript target to ES2022.

## v0.3.0 - 2026-03-20

The full notes are in docs/rc-alignment-log.md, section 37, under 0.3.0.

- Fixed the debounce plugin running a stale `next`.
- Fixed `history.undo()` changing only the stack: with `{ bus }` it runs the undo handler.
- Fixed the fallback signal having no reactivity in Vue 3.
- Added `resetCommandBus()`, so the shared bus does not leak between tests.
- Added the `naming` option, `bus.on(pattern)`, `bus.request()` and `bus.respond()`.
- Added `{ throttle, undo }` on `register()`.
- Added automatic cleanup when a component unmounts.
- Added the `authGuard` and `optimistic` plugins.

## v0.2.0 - 2026-03-18

The full notes are in docs/rc-alignment-log.md, section 37, under 0.2.0.

- Added `createAsyncCommandBus`, `dispatchBatch`, plugin priority, `onMissing`, `createTestBus` and `setupDevtools`.

## v0.1.0 - 2026-03-16

The full notes are in docs/rc-alignment-log.md, section 37, under 0.1.0.

- Fixed memory leaks in the debounce and throttle plugins and in `useCommand`.
- Fixed the example component's reactivity bugs.
- Improved dispatch: the plugin chain is built on `use()`, not per dispatch.
- Added `signal`, `configureSignal` and DevTools integration.
