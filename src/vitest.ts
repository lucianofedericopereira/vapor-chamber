/**
 * vapor-chamber/vitest - the testing entry, with its side effects.
 *
 * Load it as a setup file and every test file gets, with no import of its own:
 *
 * - the matchers, registered with `expect.extend`;
 * - a fresh, tapped shared bus before each test: `getCommandBus()` returns a
 *   real `createCommandBus()` bus that `tap()` records, so what `useCommand()`
 *   and islands dispatch can be asserted directly.
 * - and a failed test, on any assertion, shows the dispatches it made on tapped
 *   buses, listed the way Vitest lists a spy's calls.
 *
 * The same module's types augment Vitest's `Matchers`, so one `types` entry
 * gives both. Everything else is `vapor-chamber/vitest/pure`, re-exported.
 *
 * THE LIBRARY IS IMPORTED LAZILY, inside beforeEach, never at load. The
 * one-shot Vue detection and the warn-once state in chamber.ts assume nothing
 * imported the library before a test set its preconditions. Measured on this
 * repository's suite (vitest5-plugin-study.md A.15.3, re-measured for Batch B):
 * in the full run, importing at load fails 4 tests in 2 files and importing
 * inside beforeEach fails none; with each file run alone, both fail the same
 * 4, because the async detection then lands before those tests. Those two
 * files assert detection from a clean start, and `vaporChamberTest()`'s
 * `sharedBus.exclude` is how a suite like that opts out.
 * It is imported by its own package name, so the setup file and the tests
 * share one module instance (measured in five configurations, C.4), and the
 * build keeps the specifier external instead of bundling a second copy.
 *
 * THE BUS IS REPLACED BEFORE EACH TEST, not reset after it, so a failed test's
 * bus and what it recorded are still there to inspect afterwards.
 *
 * @example
 * // vitest.config.ts
 * export default defineConfig({ test: { setupFiles: ['vapor-chamber/vitest'] } });
 *
 * // tsconfig.json
 * { "compilerOptions": { "types": ["vapor-chamber/vitest"] } }
 *
 * // a test
 * it('clicking Add dispatches cartAdd', () => {
 *   clickAdd();
 *   expect(getCommandBus()).toHaveBeenDispatchedWith('cartAdd', { qty: 1 });
 * });
 */

import { afterEach, beforeEach, chai, expect, inject, type TestAPI, test as vitestTest } from 'vitest';
import type { AsyncCommandBus, CommandBus } from './command-bus';
import { _beginTest, _explainFailure, _restoreStubs, _setInstalledBus, matchers, tap, type VaporChamberMatchers } from './vitest-pure';

export * from './vitest-pure';

/**
 * The key `vaporChamberTest()` provides its options under. Duplicated in
 * src/vite-hmr.ts rather than imported, because the plugin runs in Vite's
 * process and must not load test code; tests/vitest-plugin.test.ts keeps the
 * two equal.
 */
const PROVIDED = 'vaporChamber';

// Files the plugin's `sharedBus.exclude` names, as RegExp sources it built
// from the globs against the project root. Absent without the plugin.
const provided = (inject as (key: string) => { exclude: string[] } | undefined)(PROVIDED);
const exclude = (provided?.exclude ?? []).map((source) => new RegExp(source));

expect.extend(matchers);

beforeEach(async ({ task }) => {
  // A stubGlobal / stubEnv made without `using` is restored here, when Vitest's
  // unstubGlobals / unstubEnvs would restore a vi.stubGlobal / vi.stubEnv.
  _restoreStubs();
  _beginTest();
  if (exclude.some((pattern) => pattern.test(task.file.filepath))) return;
  const vc = await import('vapor-chamber');
  const bus = tap(vc.createCommandBus());
  vc.setCommandBus(bus);
  _setInstalledBus(bus);
});

// Registered in the setup file, so it runs after the test file's own afterEach
// hooks (Vitest runs them in reverse): a failed test shows what it dispatched.
afterEach(({ task }) => _explainFailure(task, chai));

/**
 * Vitest's own `test`, extended with two fixtures through `test.extend`, the
 * way Vitest defines reusable setup. Vitest's `test` is not changed; this is
 * the new API `extend` returns.
 *
 * - `bus`: a tapped `createCommandBus()`, the setup a bus test most often opens with.
 * - `asyncBus`: a tapped `createAsyncCommandBus()`.
 *
 * Both are lazy, as every Vitest fixture is: a test that does not destructure
 * one builds nothing, and the library is imported inside the fixture, for the
 * same reason beforeEach imports it there (see the header).
 *
 * `bus` IS NOT THE SHARED BUS. It is a bus of its own, like the
 * `createCommandBus()` it replaces, so a test using it is isolated from what
 * `useCommand()` and islands reach through `getCommandBus()`, which stays the
 * tapped shared bus installed before each test. A test that wants the shared
 * bus reads `getCommandBus()`, or defines that fixture with `.extend`.
 *
 * Neither is disposed after the test, as the shared bus is not: a failed
 * test's bus and its record stay as they were, and a bus the test no longer
 * references is collected with its record.
 *
 * After `vi.resetModules()` the fixture imports a fresh module instance, as
 * beforeEach does, while the file's static imports keep the first one. A test
 * that mixes the two (`instanceof BusError`, a plugin with module state such
 * as `history`) creates its bus from its own import instead.
 *
 * Build your own on top with `.extend`, from any file:
 *
 * @example
 * import { expect, it } from 'vapor-chamber/vitest';
 *
 * export const shopTest = it.extend('shop', ({ bus }) => {
 *   registerShop(bus);
 *   return bus;
 * });
 *
 * shopTest('adding to the cart', ({ shop }) => {
 *   shop.dispatch('cartAdd', { id: 1 }, { qty: 1 });
 *   expect(shop).toHaveBeenDispatchedWith('cartAdd', { qty: 1 });
 * });
 */
export const test: TestAPI<TestScoped<VaporChamberFixtures>> = vitestTest
  .extend('bus', async (): Promise<CommandBus> => tap((await import('vapor-chamber')).createCommandBus()))
  .extend('asyncBus', async (): Promise<AsyncCommandBus> => tap((await import('vapor-chamber')).createAsyncCommandBus()));

/** The fixtures `test` and `it` add to Vitest's test context. */
export interface VaporChamberFixtures {
  /** A tapped `createCommandBus()`, new in each test that destructures it. Not the shared bus. */
  bus: CommandBus;
  /** A tapped `createAsyncCommandBus()`, new in each test that destructures it. */
  asyncBus: AsyncCommandBus;
}

/**
 * Fixtures `F` in the shape Vitest 5's builder records for test-scoped
 * fixtures (its AddBuilderTest): the `$__` keys are how a later `.extend`
 * knows which scope each fixture belongs to. Named here so the declaration
 * reads `TestAPI<TestScoped<VaporChamberFixtures>>`; left to inference it
 * printed two nested `Omit`s, and `TestAPI<VaporChamberFixtures>` alone is not
 * assignable from what `.extend` returns.
 */
type TestScoped<F> = F & { readonly $__worker?: object; readonly $__file?: object; readonly $__test?: F };

/** The same API as `test`, as Vitest's `it` is its `test`. */
export const it = test;

/** Vitest's own `expect`, with the matchers registered, so one import serves a test file. */
export { expect };

declare module 'vitest' {
  interface Matchers<R, T> extends VaporChamberMatchers<R, T> {}
}
