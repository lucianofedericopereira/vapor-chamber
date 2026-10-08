/**
 * vapor-chamber - the shared command bus.
 *
 * Its own module, and free of the Vue probe on purpose: it lived in
 * `chamber.ts`, whose top-level `probeVue()` runs a dynamic `import('vue')`,
 * so a Vue-less app that only used the shared bus kept that module and
 * loaded a Vue chunk at start under esbuild and webpack
 * (tests/root-probe-builds.test.ts). `chamber.ts` re-exports all three, so
 * every import path is unchanged.
 */

import { createCommandBus, type AsyncCommandBus, type BaseBus, type CommandBus, type CommandMap, type CommandResult } from './command-bus';
import type { SharedCommandMap } from './chamber';
import { DEV } from './dev';

let sharedBus: CommandBus | null = null;
// The bus getCommandBus() created and handed out, until something replaces it.
// DEV only: it exists to warn about that replacement (setCommandBus below).
let fallbackBus: CommandBus | null = null;

/**
 * Get the shared bus. Typed with {@link SharedCommandMap} - augment
 * `GlobalCommands` to make every call site typed. Pass an explicit map
 * to override per call site (`getCommandBus<CommandMap>()` opts back out).
 */
export function getCommandBus<M extends CommandMap = SharedCommandMap>(): CommandBus<M> {
  if (!sharedBus) {
    sharedBus = createCommandBus();
    if (DEV) fallbackBus = sharedBus;
  }
  return sharedBus as CommandBus<M>;
}

/**
 * Replace the shared bus instance.
 *
 * SSR WARNING: the shared bus is a module global - one per Node process, not
 * per request. The set-render-reset pattern (see ssr.ts) is only safe when
 * requests render strictly one at a time. Under CONCURRENT SSR renders,
 * interleaved requests stomp each other's bus: handlers and state leak across
 * requests. For concurrent servers, don't use the shared bus on the server -
 * create a bus per request and pass it explicitly (every composable and plugin
 * accepts a `bus` option / argument).
 *
 * Accepts either bus flavor - the composables' dispatch path already handles
 * thenable results (`runDispatch` awaits them), so an AsyncCommandBus works at
 * runtime. `getCommandBus()`'s static type is `CommandBus`.
 *
 * Call it before anything calls `getCommandBus()`. Replacing the bus
 * `getCommandBus()` already created and handed out splits the app: code that
 * holds the old bus keeps dispatching to it. In DEV that replacement warns,
 * once (tests/shared-bus-fallback-warning.test.ts); setting the same bus again,
 * as the HMR shim does, or setting after `resetCommandBus()`, does not.
 */
export function setCommandBus(bus: CommandBus | AsyncCommandBus): void {
  if (DEV && fallbackBus !== null && bus !== fallbackBus) {
    console.warn('[vapor-chamber] setCommandBus() replaced the bus getCommandBus() had created and already handed out. Code that called getCommandBus() before this keeps the old bus, so its dispatches and listeners are split from the new one. Call setCommandBus() before anything calls getCommandBus().');
    fallbackBus = null;
  }
  sharedBus = bus as CommandBus;
}

/** The option every bus composable takes. */
export type BusOption<B extends BaseBus = BaseBus> = {
  /**
   * Bus to use, sync or async. Default: the shared bus from `getCommandBus()`.
   * Pass one to scope a composable to a feature, an island or an SSR request.
   */
  bus?: B;
};

/**
 * What a composable's dispatch returns on bus `B`: the result on a sync bus,
 * a promise of it on an async one, either on a bus typed only as `BaseBus`.
 * tests/composables-result-types.test.ts.
 */
export type ResultOn<B, R = CommandResult> =
  B extends AsyncCommandBus<any> ? Promise<R> : B extends CommandBus<any> ? R : R | Promise<R>;

/**
 * The bus a composable uses: the one it was given, else the shared one. Every
 * composable reads its bus here, so the rule lives in one place.
 * tests/composables-bus-option.test.ts.
 */
export function resolveBus(bus: BaseBus | null | undefined): CommandBus {
  return (bus ?? getCommandBus()) as CommandBus;
}

/**
 * Reset the shared bus to null. Useful in test teardown to prevent
 * handler/hook leaks between test files.
 */
export function resetCommandBus(): void {
  sharedBus = null;
  fallbackBus = null;
}
