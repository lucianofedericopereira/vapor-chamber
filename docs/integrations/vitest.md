# Vitest integration

`vapor-chamber/vitest` tests a vapor-chamber app on Vitest 5 with Vitest's own
tools: matchers registered with `expect.extend`, a setup file, fixtures built
with `test.extend`, and a plugin for what needs configuration. Every command
bus in a test is the real one; the entry records what it dispatched and asserts
on that.

Every code block on this page runs. `tests/vitest-consumer.test.ts` installs
the built package in a temporary project, uses this page's config blocks as
its `vitest.config.ts`, and runs each test block with a real Vitest.

---

## Setup

One line in the Vitest config:

```ts config:setup
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { setupFiles: ['vapor-chamber/vitest'] },
});
```

and one in `tsconfig.json`, so the matchers are typed:

```json tsconfig
{ "compilerOptions": { "types": ["vapor-chamber/vitest"] } }
```

That is the whole integration for most suites. Every test file now has the
matchers, and before each test `getCommandBus()` returns a fresh, recorded
`createCommandBus()` bus.

### The plugin, for what needs configuration

`vaporChamberTest()` from `vapor-chamber/vite` adds the setup file for you and
takes options:

```ts config:plugin
import { defineConfig } from 'vitest/config';
import { vaporChamberTest } from 'vapor-chamber/vite';

export default defineConfig({
  plugins: [vaporChamberTest()],
});
```

- `sharedBus.exclude`: test files, as globs from the project root, that get no
  shared bus. A file that asserts the library's one-shot Vue detection from a
  clean start needs nothing to have imported the library first.
- `islands`: files named `*.island.test.*` or under `tests/islands/` run in a
  project of their own with a DOM (`happy-dom` unless
  `islands.environment` says otherwise). `false` turns it off.
- The setup file is placed first in `setupFiles`, once, and yours are kept.
- On a Vitest major this release does not know, one warning,
  `VC_TEST_VITEST_MAJOR`, never a failure.

A run with the plugin opens with one line, in Vue's green and slate where the
terminal has colors:

```text brand
 \\//  powered by vc-vitest-plugin
```

It goes to stderr, once per run, and only beside Vitest's own banner: a run
with only the `json`, `junit` or `tap` reporter shows nothing, and
`vitest list --json` output stays parseable. `NO_COLOR` turns the colors off.

---

## Asserting on dispatches

A component or composable reaches the shared bus through `getCommandBus()`,
and the setup file has already recorded that bus:

```ts test
import { expect, it } from 'vitest';
import { getCommandBus } from 'vapor-chamber';

it('clicking Add dispatches cartAdd', () => {
  const bus = getCommandBus();
  bus.register('cartAdd', () => 1);
  // In an app, the component under test makes this call.
  bus.dispatch('cartAdd', { id: 1 }, { qty: 1 });
  expect(bus).toHaveBeenDispatchedWith('cartAdd', { qty: 1 });
});
```

The matchers are Vitest's spy matchers with the action in place of the spy:

| matcher | Vitest's spy matcher |
| --- | --- |
| `toHaveBeenDispatched(action)` | `toHaveBeenCalled()` |
| `toHaveBeenDispatchedWith(action, payload)` | `toHaveBeenCalledWith(...)` |
| `toHaveBeenDispatchedTimes(action, n)` | `toHaveBeenCalledTimes(n)` |
| `toHaveBeenDispatchedOnce(action)` | `toHaveBeenCalledOnce()` |
| `toHaveBeenNthDispatchedWith(n, action, payload)` | `toHaveBeenNthCalledWith(n, ...)` |
| `toHaveBeenLastDispatchedWith(action, payload)` | `toHaveBeenLastCalledWith(...)` |

Payloads compare the way `toEqual` compares. `n` counts the dispatches of that
action only, from 1.

```ts test
import { createCommandBus } from 'vapor-chamber';
import { expect, it, vc } from 'vapor-chamber/vitest';

it('reads like a spy', () => {
  const bus = vc.tap(createCommandBus());
  bus.register('cartAdd', () => 1);
  bus.dispatch('cartAdd', { id: 1 }, { qty: 1 });
  bus.dispatch('cartAdd', { id: 1 }, { qty: 2 });

  expect(bus).toHaveBeenDispatched('cartAdd');
  expect(bus).toHaveBeenDispatchedTimes('cartAdd', 2);
  expect(bus).toHaveBeenNthDispatchedWith(1, 'cartAdd', { qty: 1 });
  expect(bus).toHaveBeenLastDispatchedWith('cartAdd', { qty: 2 });
  expect(bus).not.toHaveBeenDispatched('cartClear');
});
```

A bus you create yourself is recorded once you pass it to `vc.tap()`, which
returns the same bus. Three more matchers read results and failures by their
error code, never by message text:

```ts test
import { createCommandBus } from 'vapor-chamber';
import { expect, it, vc } from 'vapor-chamber/vitest';

it('a result succeeds with a value, or fails with a code', () => {
  const bus = vc.tap(createCommandBus());
  bus.register('cartAdd', () => 3);

  expect(bus.dispatch('cartAdd', { id: 1 }, { qty: 2 })).toSucceedWith(3);
  expect(bus.dispatch('cartClear', null)).toFailWith('VC_CORE_NO_HANDLER');
  expect(bus).toHaveFailedWith('cartClear', 'VC_CORE_NO_HANDLER');
});
```

On a typed bus, `createCommandBus<Shop>()`, a misspelled action, a wrong
payload and a wrong result value are type errors.

---

## Fixtures: `bus` and `asyncBus`

Import `it` (or `test`) from `vapor-chamber/vitest` and a test can ask for a
recorded bus instead of creating one. It is Vitest's own `test`, extended with
`test.extend`; Vitest's `it` is not changed.

```ts test
import { expect, it } from 'vapor-chamber/vitest';

it('bus: a recorded createCommandBus()', ({ bus }) => {
  bus.register('cartAdd', () => 1);
  bus.dispatch('cartAdd', { id: 1 }, { qty: 1 });
  expect(bus).toHaveBeenDispatchedOnce('cartAdd');
});

it('asyncBus: a recorded createAsyncCommandBus()', async ({ asyncBus }) => {
  asyncBus.register('cartAdd', async () => 2);
  expect(await asyncBus.dispatch('cartAdd', { id: 1 }, { qty: 2 })).toSucceedWith(2);
});
```

- Each is built only for a test that asks for it, and new in every test.
- `bus` is not the shared bus. It stands for the `createCommandBus()` a test
  would write, so it is isolated from what `getCommandBus()` reaches.
- Neither is disposed after the test: a failed test's bus keeps its record.
- After `vi.resetModules()` a fixture loads a fresh copy of the library, while
  the test file's own imports keep the first. A test that mixes the two, for
  example `instanceof BusError`, creates its bus from its own import.

Build your own reusable setup the same way, and import it from any test file:

```ts test
import { expect, it } from 'vapor-chamber/vitest';

const shopTest = it.extend('shop', ({ bus }) => {
  bus.register('cartAdd', (cmd) => cmd.payload.qty);
  return bus;
});

shopTest('adding to the cart', ({ shop }) => {
  expect(shop.dispatch('cartAdd', { id: 1 }, { qty: 2 })).toSucceedWith(2);
  expect(shop).toHaveBeenDispatchedWith('cartAdd', { qty: 2 });
});
```

---

## `vc`: the utilities in one object

As Vitest keeps its utilities in `vi`, this entry keeps its own in `vc`. Each
member is also a named export (`vc.tap === tap`).

| member | what it does |
| --- | --- |
| `vc.tap(bus)` | records every dispatch on a real bus, and returns that bus |
| `vc.stubGlobal(name, value)` | stubs a global, restored at the end of the block with `using` |
| `vc.stubEnv(name, value)` | stubs an environment variable, the same way |
| `vc.mcp(handler)` | an MCP client for tests (next section) |

`vi.stubGlobal` and `vi.stubEnv` restore at the start of the NEXT test, after
this test's `afterEach` hooks have run. `vc.stubGlobal` and `vc.stubEnv` return
a disposable, so `using` restores the name when the block ends, a throw
included:

```ts test
import { expect, it, vc } from 'vapor-chamber/vitest';

it('stubs last as long as their block', () => {
  {
    using _confirm = vc.stubGlobal('confirm', () => true);
    using _env = vc.stubEnv('NODE_ENV', 'production');
    expect(confirm('Clear the cart?')).toBe(true);
    expect(process.env.NODE_ENV).toBe('production');
  }
  expect(typeof globalThis.confirm).toBe('undefined');
  expect(process.env.NODE_ENV).not.toBe('production');
});
```

A stub made without `using` is restored before the next test, as Vitest's
`unstubGlobals` would restore it.

---

## When a test fails

A test that fails on any assertion lists the dispatches it made on recorded
buses, the way Vitest lists a spy's calls:

```ts fails
import { expect, it } from 'vitest';
import { getCommandBus } from 'vapor-chamber';

it('fails on an unrelated assertion', () => {
  getCommandBus().dispatch('cartAdd', { id: 1 }, { qty: 2 });
  expect(1).toBe(2);
});
```

```text failure
AssertionError: expected 1 to be 2 // Object.is equality

Dispatched during this test:

  1st dispatch on getCommandBus():

    { action: 'cartAdd', target: { id: 1 }, payload: { qty: 2 }, ok: false, code: 'VC_CORE_NO_HANDLER' }

Number of dispatches: 1
```

A failing bus matcher shows a diff of each dispatch against what it expected,
as `toHaveBeenCalledWith` does.

---

## Testing an MCP surface

`vc.mcp()` drives an MCP server handler as an agent does, without writing
JSON-RPC by hand. `toBeToolResult` reads a tool's value; `toBeToolError` reads
a refusal or a failure.

```ts test
import { createSchemaCommandBus } from 'vapor-chamber';
import { createMcpHandler } from 'vapor-chamber/mcp';
import { expect, it, vc } from 'vapor-chamber/vitest';

it('an agent can add to the cart and cannot clear it', async () => {
  const bus = vc.tap(createSchemaCommandBus({
    cartAdd: { description: 'Add an item', target: { id: 'number' }, payload: { qty: 'number' } },
    cartClear: { description: 'Empty the cart' },
  }));
  bus.register('cartAdd', (cmd) => ({ count: cmd.payload.qty }));
  bus.register('cartClear', () => null);

  const mcp = vc.mcp(createMcpHandler(bus, { actions: ['cartAdd'] }));
  expect(await mcp.toolNames()).toEqual(['cartAdd']);
  expect(await mcp.call('cartAdd', { target: { id: 1 }, payload: { qty: 2 } })).toBeToolResult({ count: 2 });
  expect(await mcp.call('cartClear')).toBeToolError(/not permitted/);
  expect(bus).toHaveBeenDispatchedWith('cartAdd', { qty: 2 });
});
```

A protocol error (not a tool error) throws, because no tool test expects one.
`mcp.request(method, params)` returns the raw reply when the envelope itself is
under test.

---

## An MCP server for your test run: `vc-vitest-mcp`

The package ships a minimal MCP server that lets an agent run your tests and
read what is left to cover. Add it to your MCP client, started in the project
root:

```json mcp-client
{ "mcpServers": { "vitest": { "command": "npx", "args": ["vc-vitest-mcp"] } } }
```

`--root <dir>` and `--config <file>` select another project root or Vitest
config.

| tool | what it does |
| --- | --- |
| `runTests` | runs every test file, or those `target.files` selects, in a Vitest that stays warm between calls; returns counts and each failure with its message |
| `getTestResults` | the last run again, with `stale` and the files changed since it ran |
| `getCoverageGaps` | runs the tests once with coverage and lists, per source file, the uncovered lines, functions and branch arms |

- **What an agent can choose.** The root and the config are fixed by whoever
  starts the server. An agent passes only `files`, Vitest filters that select
  among the test files your config already includes; a filter that starts with
  `-` is refused (`VC_TEST_MCP_INVALID_FILES`).
- **Edits are seen.** The server watches the project and invalidates changed
  files before each run, so a run after an edit is not stale, and a new test
  file is found.
- **Failures carry the dispatches.** With `vapor-chamber/vitest` as a setup
  file, a failure's message includes what the test dispatched.
- **One run at a time.** Calls sent together wait their turn;
  `getTestResults` waits for a run in progress.
- **Limits, for now.** `getCoverageGaps` starts a separate `vitest run`, so it
  pays a cold start. v8 coverage lists only the source files the selected tests
  loaded; set `coverage.include` in your config to list the others. The server
  speaks stdio only.
- **Programmatic use.** `createVitestMcp({ root, config })` from
  `vapor-chamber/vitest/mcp` returns the schema bus; serve it with
  `createMcpHandler` or `serveMcpStdio`.

Tool names are camelCase, as a vapor-chamber schema bus names its actions.

---

## Diagnostics

A misuse throws a `VcTestError` with a `code`, the reason, the fix and a link.

| code | cause | fix |
| --- | --- | --- |
| `VC_TEST_UNTAPPED` | a bus matcher received a bus nobody passed to `tap()` | `vc.tap(createCommandBus())` where the bus is created |
| `VC_TEST_DUPLICATE_INSTANCE` | the bus comes from a second installed copy of vapor-chamber | dedupe the install (`npm ls vapor-chamber`) |
| `VC_TEST_TAP_REMOVED` | `clear()` or `dispose()` removed the recording hook | `vc.tap(bus)` again after clearing |
| `VC_TEST_VITEST_MAJOR` | a Vitest major this release does not know (a warning) | nothing if the suite passes |
| `VC_TEST_MCP_INVALID_FILES` | an agent passed `target.files` that is not a short list of filters, or a filter starting with `-` | pass file filters relative to the project root |
| `VC_TEST_MCP_NO_RUN` | `getTestResults` before any `runTests` | call `runTests` first |
| `VC_TEST_MCP_NO_COVERAGE` | the coverage run wrote no report | install the coverage provider your config names |

A bus nobody recorded is named, never reported as empty, and `.not` throws too,
so a negated assertion cannot pass by accident:

```ts test
import { createCommandBus } from 'vapor-chamber';
import { expect, it } from 'vapor-chamber/vitest';

it('an untapped bus is a coded error', () => {
  const bus = createCommandBus();
  expect(() => expect(bus).not.toHaveBeenDispatched('cartAdd')).toThrow(/VC_TEST_UNTAPPED/);
});
```

---

## What Vitest already does, and this entry leaves alone

- **Spies.** Every Vitest mock is disposable, so `using spy = vi.spyOn(...)`
  restores it when the block ends. No wrapper is needed.
- **Cleanup between tests.** `restoreMocks`, `unstubGlobals` and `unstubEnvs`
  in the config clean up after every test.
- **Reusable setup.** `test.extend`, as the fixtures above use it.

```ts test
import { expect, it, vi } from 'vitest';

it('a spy restores itself at the end of its block', () => {
  {
    using warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    console.warn('quiet');
    expect(warn).toHaveBeenCalledWith('quiet');
  }
  expect(vi.isMockFunction(console.warn)).toBe(false);
});
```

---

## Without the side effects: `vapor-chamber/vitest/pure`

`vapor-chamber/vitest/pure` exports the same helpers and registers nothing: no
matcher, no hook, no shared bus. It imports nothing from the library at
runtime.

```ts test
import { createCommandBus } from 'vapor-chamber';
import { expect, it } from 'vitest';
import { matchers, tap } from 'vapor-chamber/vitest/pure';

expect.extend(matchers);

it('registers only what you ask for', () => {
  const bus = tap(createCommandBus());
  bus.dispatch('cartAdd', null);
  expect(bus).toHaveFailedWith('cartAdd', 'VC_CORE_NO_HANDLER');
});
```

Requires Vitest 5 (`vitest >=5.0.0`, an optional peer dependency). The API
reference is [docs/api/vitest.md](../api/vitest.md),
[docs/api/vitest-pure.md](../api/vitest-pure.md) and
[docs/api/vite.md](../api/vite.md).
