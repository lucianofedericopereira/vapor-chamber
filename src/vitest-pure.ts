/**
 * vapor-chamber/vitest/pure - assert on a real bus through its own events.
 *
 * No side effects: importing this module registers no hook and no matcher. It
 * is what `vapor-chamber/vitest` re-exports after doing both, and what a suite
 * imports when it wants the helpers without the automatic behaviour.
 *
 * It imports NOTHING from the library at runtime, only types. That is a
 * measured requirement, not tidiness: a setup file that imported the root
 * barrel at load ran chamber.ts's one-shot Vue detection and consumed a
 * warn-once before any test had set its preconditions, and 4 tests of this
 * repository's suite failed for it (vitest5-plugin-study.md A.15.3).
 *
 * @example
 * import { expect } from 'vitest';
 * import { matchers, tap } from 'vapor-chamber/vitest/pure';
 * expect.extend(matchers);
 *
 * const bus = tap(createCommandBus<Shop>());
 * expect(bus.dispatch('cartAdd', { id: 1 }, { qty: 2 })).toSucceedWith(3);
 * expect(bus).toHaveBeenDispatchedWith('cartAdd', { qty: 2 });
 */

import type {
  AsyncCommandBus, BusErrorCode, Command, CommandBus, CommandMap, CommandResult, PayloadOf,
} from './command-bus';
import type { McpTool } from './mcp';

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/**
 * Codes of the misuse diagnostics this entry raises. A union of its own, so
 * the core `BusErrorCode` registry, and the bytes every app ships, do not move
 * for test tooling.
 *
 * - `VC_TEST_UNTAPPED`: a bus matcher received a bus that was never passed to
 *   `tap()`, so nothing it dispatched was recorded. Fix: `tap(bus)` where the
 *   bus is created; the shared bus from `getCommandBus()` is tapped for you
 *   when `vapor-chamber/vitest` is a setup file.
 * - `VC_TEST_DUPLICATE_INSTANCE`: the bus came from a second copy of
 *   vapor-chamber, not the one the setup file tapped. Every assertion would
 *   otherwise report "nothing was dispatched". Fix: dedupe the install
 *   (`npm ls vapor-chamber`) so one copy is loaded.
 * - `VC_TEST_VITEST_MAJOR`: a warning, never a failure. This entry was released
 *   against Vitest 5 and meets a major it does not know. Fix: none needed if
 *   the suite passes; report a break if it does not.
 * - `VC_TEST_TAP_REMOVED`: the bus was tapped, then `clear()` or `dispose()`
 *   removed every hook, the tap's included, so later dispatches were not
 *   recorded. Raised only where a missed record could change the outcome.
 *   Fix: `tap(bus)` again after clearing.
 * - `VC_TEST_MCP_INVALID_FILES`: an MCP client passed `target.files` that is
 *   not a list of up to 100 non-empty filters, or a filter starting with `-`.
 *   Fix: pass file filters relative to the project root.
 * - `VC_TEST_MCP_NO_RUN`: `getTestResults` before any `runTests`. Fix: call
 *   `runTests` first.
 * - `VC_TEST_MCP_NO_COVERAGE`: the coverage run wrote no report. Fix: install
 *   the provider the config names and check that the suite starts.
 */
export type VcTestDiagnostic =
  | 'VC_TEST_UNTAPPED'
  | 'VC_TEST_DUPLICATE_INSTANCE'
  | 'VC_TEST_VITEST_MAJOR'
  | 'VC_TEST_TAP_REMOVED'
  | 'VC_TEST_MCP_INVALID_FILES'
  | 'VC_TEST_MCP_NO_RUN'
  | 'VC_TEST_MCP_NO_COVERAGE';

const DOCS = 'https://github.com/lucianofedericopereira/vapor-chamber/blob/main/docs/api/vitest-pure.md#vctestdiagnostic';

const CATALOGUE: Record<VcTestDiagnostic, { why: string; fix: string }> = {
  VC_TEST_UNTAPPED: {
    why: 'this bus was never passed to tap(), so nothing dispatched on it was recorded',
    fix: 'wrap it where it is created: tap(createCommandBus()). The shared bus from getCommandBus() is tapped for you when vapor-chamber/vitest is a setup file',
  },
  VC_TEST_DUPLICATE_INSTANCE: {
    why: 'this bus comes from a second copy of vapor-chamber, not the copy the setup file tapped',
    fix: 'load one copy: dedupe the install (npm ls vapor-chamber) so tests and the setup file resolve the same package',
  },
  VC_TEST_VITEST_MAJOR: {
    why: 'vapor-chamber/vitest was released against Vitest 5 and is running on a major it does not know',
    fix: 'nothing if the suite passes; report the break if it does not',
  },
  VC_TEST_TAP_REMOVED: {
    why: 'this bus was tapped, then clear() or dispose() removed every hook, the tap included, so later dispatches were not recorded',
    fix: 'tap(bus) again after clear() or dispose(); it resumes recording into the same record',
  },
  VC_TEST_MCP_INVALID_FILES: {
    why: 'target.files must be a list of at most 100 non-empty file filters, none starting with "-"',
    fix: 'pass Vitest file filters relative to the project root, or omit target.files to run every test file',
  },
  VC_TEST_MCP_NO_RUN: {
    why: 'no runTests call has finished in this server yet',
    fix: 'call runTests first',
  },
  VC_TEST_MCP_NO_COVERAGE: {
    why: 'the coverage run wrote no report',
    fix: 'install the coverage provider the Vitest config names (npm i -D @vitest/coverage-v8) and check that the suite starts',
  },
};

/** A coded misuse diagnostic: `code` to switch on, `why`, `fix` and a `docs` link. */
export class VcTestError extends Error {
  readonly code: VcTestDiagnostic;
  readonly why: string;
  readonly fix: string;
  readonly docs: string;

  constructor(code: VcTestDiagnostic, detail = '') {
    const { why, fix } = CATALOGUE[code];
    super(`[vapor-chamber/vitest] ${code}: ${why}${detail}\n  fix: ${fix}\n  docs: ${DOCS}`);
    this.name = 'VcTestError';
    this.code = code;
    this.why = why;
    this.fix = fix;
    this.docs = DOCS;
  }
}

// ---------------------------------------------------------------------------
// tap
// ---------------------------------------------------------------------------

/** One dispatch as the bus's after-hook saw it. Same shape for every record. */
interface TappedDispatch {
  action: string;
  target: unknown;
  payload: unknown;
  ok: boolean;
  value: unknown;
  code: string | undefined;
  message: string | undefined;
}

/** What `tap()` needs: the after-hook. Sync, async and schema buses all have it. */
export type Tappable = { onAfter(hook: (cmd: Command, result: CommandResult) => void): () => void };

// Keyed by the bus, so a bus the test drops is collected with its record.
const taps = new WeakMap<object, TappedDispatch[]>();

/**
 * Record every dispatch on `bus`, in order, through its own `onAfter` hook,
 * and return the same bus. Idempotent: a bus tapped twice records once.
 *
 * The bus is the real one - no double, no wrapper - so a test exercises what
 * production runs. The one observable difference is the hook itself
 * (`inspectBus(bus).afterHookCount` is 1 higher), measured to break nothing
 * across this repository's suite. A sealed bus refuses the hook with
 * `VC_CORE_SEALED`: tap before sealing.
 *
 * `clear()` and `dispose()` remove every hook, this one included. Tapping the
 * bus again re-attaches it to the same record; until then a matcher whose
 * outcome a missed dispatch could change throws `VC_TEST_TAP_REMOVED`.
 *
 * The record grows for the life of the bus. What a matcher reads is the part
 * since the last {@link beginTest}, which is why a bus that outlives a test
 * needs one per test.
 */
export function tap<B extends Tappable>(bus: B): B {
  const known = taps.get(bus);
  if (known === undefined || tapRemoved(bus)) {
    const log: TappedDispatch[] = known ?? [];
    bus.onAfter((cmd, result) => {
      const error = result.error as { code?: unknown; message?: string } | undefined;
      if (!touched.has(log)) touched.set(log, { bus, from: log.length });
      log.push({
        action: cmd.action,
        target: cmd.target,
        payload: cmd.payload,
        ok: result.ok,
        value: result.value,
        code: typeof error?.code === 'string' ? error.code : undefined,
        message: error?.message,
      });
    });
    taps.set(bus, log);
  }
  return bus;
}

/**
 * True when a tapped bus has certainly lost the tap's hook. `clear()` and
 * `dispose()` empty the after-hook list in place, and a bus still holding the
 * tap reports at least one. Read through the bus's own inspect symbol, found by
 * description as fromOtherInstance below does, because this file imports
 * nothing. A hook added after the clear hides the removal, and a bus without
 * the symbol is never reported: both fall back to what the tap recorded.
 *
 * THE SYMBOL CARRIES THE STATE, not a `() => BusInspection` closure, so this
 * counts `afterHooks` itself rather than reading `afterHookCount` off a
 * snapshot. The closure was what kept `inspect()` reachable from every bus
 * ever constructed and shipped its body to consumers that never import
 * `inspectBus`, against what two docblocks in command-bus.ts promised. This
 * reads one level deeper into a private shape as a result, which is the same
 * class of coupling a private symbol already is - and `tests/vitest-consumer`
 * drives it through a packed install, which is what caught the change.
 */
function tapRemoved(bus: object): boolean {
  const inspect = Object.getOwnPropertySymbols(bus).find((s) => s.description === 'vapor-chamber:inspect');
  if (inspect === undefined) return false;
  const state = (bus as Record<symbol, { afterHooks?: unknown[] } | undefined>)[inspect];
  return state?.afterHooks?.length === 0;
}

// Records that grew during the current test, with the bus and where this test's
// dispatches start. Cleared before each test by vapor-chamber/vitest.
const touched = new Map<TappedDispatch[], { bus: object; from: number }>();

/**
 * beginTest - open a new record boundary, so the bus matchers answer for the
 * dispatches that follow it and not for the ones before.
 *
 * `vapor-chamber/vitest` calls it before each test, where a fresh shared bus
 * makes it a formality. A suite using THIS entry on its own must call it in a
 * `beforeEach` whenever it taps a bus that outlives one test - an app's own
 * configured bus, published at module load and imported by every test file.
 * Without it the record is that bus's whole history, and a count or a `.not`
 * answers for earlier tests.
 *
 * @example
 * import { beforeEach, expect } from 'vitest';
 * import { beginTest, matchers, tap } from 'vapor-chamber/vitest/pure';
 * import { bus } from './bus';
 *
 * expect.extend(matchers);
 * tap(bus);
 * beforeEach(beginTest);
 */
export function beginTest(): void {
  touched.clear();
}

/** The part of Vitest's task an after-hook sees that a failure explanation needs. */
type FinishedTask = { result?: { state?: string; errors?: { message: string; stack?: string }[] } };

/** The part of Vitest's `chai` export a failure explanation prints with. */
type Chai = { config: { truncateThreshold: number }; util: { inspect(value: unknown): string } };

/**
 * @internal Run by `vapor-chamber/vitest` after each test. A test that failed,
 * on any assertion, gets the dispatches it made appended to its first error,
 * in the shape of Vitest's own "Received: ... Number of calls" block, printed
 * with Vitest's `chai.util.inspect`. `annotate()` is not an option: measured on
 * Vitest 5.0.1, it throws once the test has failed. A failure a bus matcher
 * already explained is left as it is.
 *
 * Printed untruncated, as Vitest prints its Received blocks: at the default
 * `truncateThreshold` (40, meant for assertion headers) a dispatch read
 * `{ action: 'cartAdd', ...(4) }`. The user's threshold is restored at once.
 * The stack gets the text too, the way Vitest rewrites an error's message
 * (`stack.replace(message, ...)`): the JSON reporter reads `stack`, not
 * `message`, and showed nothing without it.
 */
export function _explainFailure(task: FinishedTask, chai: Chai): void {
  const error = task.result?.state === 'fail' ? task.result.errors?.[0] : undefined;
  if (error === undefined || touched.size === 0 || error.message.includes('Number of dispatches:')) return;
  const threshold = chai.config.truncateThreshold;
  const inspect = (value: unknown) => {
    chai.config.truncateThreshold = 0;
    try {
      return chai.util.inspect(value);
    } finally {
      chai.config.truncateThreshold = threshold;
    }
  };
  const tapped = [...touched.values()].filter((t) => t.bus !== installed).length;
  let nthTap = 0;
  let count = 0;
  const calls = [...touched].flatMap(([log, { bus, from }]) => {
    const name = bus === installed ? 'getCommandBus()' : tapped === 1 ? 'tap() bus' : `tap() bus ${++nthTap} of ${tapped}`;
    return log.slice(from).map((d, i) => {
      count++;
      const view: Record<string, unknown> = { action: d.action, target: d.target };
      if (d.payload !== undefined) view.payload = d.payload;
      view.ok = d.ok;
      if (d.ok) {
        if (d.value !== undefined) view.value = d.value;
      } else if (d.code !== undefined) view.code = d.code;
      else view.error = d.message;
      return `  ${ordinal(i + 1)} dispatch on ${name}:\n\n${inspect(view).split('\n').map((line) => `    ${line}`).join('\n')}\n`;
    });
  });
  const original = error.message;
  error.message += `\n\nDispatched during this test:\n\n${calls.join('\n')}\n\nNumber of dispatches: ${count}`;
  if (error.stack !== undefined) error.stack = error.stack.replace(original, error.message);
}

// The bus the auto entry installed as the shared bus in the current test, the
// reference a received bus is compared against to tell a second module
// instance from a bus nobody tapped.
let installed: object | undefined;

/** @internal Set by `vapor-chamber/vitest` in each test's beforeEach. */
export function _setInstalledBus(bus: object | undefined): void {
  installed = bus;
}

/**
 * A second copy of the library mints its own symbols. Every real bus carries
 * the library's `vapor-chamber:*` symbols as own keys, so a received bus whose
 * symbol has the same description as one on the installed bus but is not the
 * same symbol was built by another module instance.
 */
function fromOtherInstance(ours: object, received: object): boolean {
  const mine = Object.getOwnPropertySymbols(ours);
  return Object.getOwnPropertySymbols(received).some(
    (s) => !mine.includes(s) && mine.some((m) => m.description === s.description),
  );
}

function recordsOf(received: unknown): TappedDispatch[] {
  const log = taps.get(received as object);
  if (log !== undefined) {
    const boundary = touched.get(log);
    return boundary === undefined ? [] : log.slice(boundary.from);
  }
  if (installed !== undefined && typeof received === 'object' && received !== null && fromOtherInstance(installed, received)) {
    throw new VcTestError('VC_TEST_DUPLICATE_INSTANCE');
  }
  throw new VcTestError('VC_TEST_UNTAPPED');
}

// ---------------------------------------------------------------------------
// Stubs that `using` restores
// ---------------------------------------------------------------------------

/**
 * What a stub returns: declare it with `using`, and the one name it stubbed is
 * restored at the end of the block, before `afterEach` runs, a throw included.
 * Vitest's own `vi.stubGlobal` / `vi.stubEnv` return nothing disposable, and
 * `unstubGlobals` / `unstubEnvs` restore at the start of the NEXT test, after
 * the current test's after-hooks. Every Vitest mock is already disposable
 * (`using spy = vi.spyOn(...)`), so spies need nothing from here.
 */
export interface Restore {
  // biome-ignore lint/suspicious/noTsIgnore: @ts-expect-error fails a consumer whose lib HAS Symbol.dispose (unused directive); tsc keeps this JSDoc in the .d.ts
  /** @ts-ignore Symbol.dispose is absent from a lib older than esnext.disposable. Restores the stubbed name; a second call does nothing. */
  [Symbol.dispose](): void;
}

// Restores not yet run, oldest first. `vapor-chamber/vitest` runs what is left
// before each test, so a stub made without `using` is restored when Vitest's
// own unstubGlobals would restore it.
const pending: (() => void)[] = [];

function restorer(restore: () => void): Restore {
  const once = () => {
    const at = pending.lastIndexOf(once);
    if (at !== -1) {
      pending.splice(at, 1);
      restore();
    }
  };
  pending.push(once);
  return { [Symbol.dispose]: once };
}

/** @internal Run by `vapor-chamber/vitest` before each test: restores every stub still in place, newest first. */
export function _restoreStubs(): void {
  while (pending.length > 0) (pending[pending.length - 1] as () => void)();
}

/**
 * Stub `globalThis[name]` for the block: `using _ = stubGlobal('fetch', fake)`.
 * Defined the way `vi.stubGlobal` defines it (writable, configurable,
 * enumerable). The restore puts back the own-property descriptor that was
 * there, getters included, or deletes the name if there was none.
 */
export function stubGlobal(name: string | symbol, value: unknown): Restore {
  const saved = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true, enumerable: true });
  return restorer(() => {
    if (saved === undefined) Reflect.deleteProperty(globalThis, name);
    else Object.defineProperty(globalThis, name, saved);
  });
}

/** The value `stubEnv` accepts for `name`: a boolean for Vite's DEV, PROD and SSR, as `vi.stubEnv` takes. */
export type EnvValue<N extends string> = N extends 'DEV' | 'PROD' | 'SSR' ? boolean : string | undefined;

/**
 * Stub an environment variable for the block: `using _ = stubEnv('NODE_ENV', 'production')`.
 * Stored the way `vi.stubEnv` stores it: `undefined` unsets, DEV / PROD / SSR
 * become '1' or ''. It writes `process.env`, which `import.meta.env` reads in
 * every Node pool (Vitest's `metaEnv` there is a view of `process.env`). The
 * restore puts back the value that was there, or deletes the variable.
 */
export function stubEnv<N extends string>(name: N, value: EnvValue<N>): Restore {
  const env = process.env;
  const had = Object.hasOwn(env, name);
  const saved = env[name];
  const set = (v: unknown) => {
    if (v === undefined) delete env[name];
    else env[name] = typeof v === 'boolean' ? (v ? '1' : '') : String(v);
  };
  set(value);
  return restorer(() => set(had ? saved : undefined));
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

/** A `tools/call` result: text content blocks, and `isError` when the tool failed. */
export type McpToolResult = { content: { type: string; text: string }[]; isError?: boolean };

/** A JSON-RPC 2.0 message handler, such as `createMcpHandler(bus, { actions })` returns. */
export type McpMessageHandler = (message: unknown) => Promise<object | null>;

/** An MCP client for tests: what an agent does, without writing JSON-RPC envelopes. */
export interface McpClient {
  /** `initialize`, returning the server's result. */
  initialize(params?: object): Promise<{ protocolVersion: string; capabilities: object; serverInfo: object }>;
  /** `tools/list`: every tool the server exposes to this client. */
  tools(): Promise<McpTool[]>;
  /** The names `tools/list` returns, in order. */
  toolNames(): Promise<string[]>;
  /** `tools/call`. A tool that fails or is refused is a result with `isError`; assert it with `toBeToolError`. */
  call(name: string, args?: { target?: unknown; payload?: unknown }): Promise<McpToolResult>;
  /** Any request, answered with the raw JSON-RPC reply, errors included: for testing the envelope itself. */
  request(method: string, params?: unknown): Promise<any>;
  /** A notification: no id, so a conforming server answers `null`. */
  notify(method: string, params?: unknown): Promise<object | null>;
}

/**
 * Drive an MCP server handler the way an agent does. Ids are numbered for you;
 * `initialize`, `tools`, `toolNames` and `call` throw on a JSON-RPC error (an
 * `Error` whose `code` is the JSON-RPC code), because a protocol error is never
 * what a tool test expects. Takes the handler, not the bus, so this entry
 * still imports nothing and any JSON-RPC MCP handler works.
 *
 * @example
 * const mcp = mcpClient(createMcpHandler(bus, { actions: ['cart*'] }));
 * expect(await mcp.toolNames()).toEqual(['cartAdd']);
 * expect(await mcp.call('cartAdd', { target: { id: 1 }, payload: { qty: 2 } })).toBeToolResult({ count: 2 });
 * expect(await mcp.call('orderDelete')).toBeToolError(/not permitted/);
 */
export function mcpClient(handler: McpMessageHandler): McpClient {
  let id = 0;
  const message = (method: string, params: unknown, withId: boolean) => ({
    jsonrpc: '2.0',
    ...(withId ? { id: ++id } : {}),
    method,
    ...(params === undefined ? {} : { params }),
  });
  const request = (method: string, params?: unknown): Promise<any> => handler(message(method, params, true));
  const result = async (method: string, params?: unknown): Promise<any> => {
    const reply = await request(method, params);
    if (reply.error) throw Object.assign(new Error(`MCP ${method} failed: ${reply.error.code} ${reply.error.message}`), { code: reply.error.code });
    return reply.result;
  };
  return {
    initialize: (params = {}) => result('initialize', params),
    tools: async () => (await result('tools/list')).tools,
    toolNames: async () => (await result('tools/list')).tools.map((tool: McpTool) => tool.name),
    call: (name, args = {}) => result('tools/call', { name, arguments: args }),
    request,
    notify: (method, params) => handler(message(method, params, false)),
  };
}

/**
 * The utilities in one object, as Vitest keeps its own in `vi`: type `vc.` and
 * the editor lists them. Each member IS the named export (`vc.tap === tap`),
 * so both forms can be mixed and tree-shaking of the named imports is kept.
 *
 * @example
 * import { vc } from 'vapor-chamber/vitest';
 * const bus = vc.tap(createCommandBus());
 * using _env = vc.stubEnv('NODE_ENV', 'production');
 * const mcp = vc.mcp(createMcpHandler(bus, { actions: ['cart*'] }));
 */
export const vc = {
  tap,
  stubGlobal,
  stubEnv,
  mcp: mcpClient,
};

// ---------------------------------------------------------------------------
// Matchers
// ---------------------------------------------------------------------------

/** The part of Vitest's matcher `this` these matchers use; structural, so this file names no vitest type. */
interface MatcherContext {
  isNot: boolean;
  customTesters: unknown[];
  equals(a: unknown, b: unknown, testers?: unknown[]): boolean;
  utils: {
    stringify(value: unknown, maxDepth?: number, options?: { min?: boolean }): string;
    diff(expected: unknown, received: unknown, options?: { omitAnnotationLines?: boolean }): string | undefined;
    iterableEquality: unknown;
  };
}

// The comparison toEqual makes, exactly: Vitest's toEqual passes the registered
// custom testers and iterableEquality. Bare `equals` found two Maps with
// different entries equal, since neither has an own enumerable key.
const equal = (ctx: MatcherContext, a: unknown, b: unknown) =>
  ctx.equals(a, b, [...ctx.customTesters, ctx.utils.iterableEquality]);

// Vitest's ordinal, so a dispatch reads as "1st", "2nd", like "1st vi.fn() call".
function ordinal(n: number): string {
  const last = n % 10;
  const tens = n % 100;
  if (last === 1 && tens !== 11) return `${n}st`;
  if (last === 2 && tens !== 12) return `${n}nd`;
  if (last === 3 && tens !== 13) return `${n}rd`;
  return `${n}th`;
}

// The tail of a bus matcher's message, in the shape Vitest gives
// toHaveBeenCalledWith (formatCalls): each dispatch diffed against what was
// expected with Vitest's own diff, then the count.
// With no expected value (toHaveBeenDispatched, the counts) each dispatch is
// listed as formatCalls lists a call for toHaveBeenCalled: stringified, indented.
function received(ctx: MatcherContext, log: TappedDispatch[], expected: object | undefined, view: (d: TappedDispatch) => object): string {
  const show = (d: TappedDispatch) =>
    expected === undefined
      ? ctx.utils.stringify(view(d)).split('\n').map((line) => `    ${line}`).join('\n')
      : ctx.utils.diff(expected, view(d), { omitAnnotationLines: true });
  const calls = log.map((d, i) => `  ${ordinal(i + 1)} dispatch:\n\n${show(d)}\n`);
  return `${calls.length === 0 ? '' : `\n\nReceived:\n\n${calls.join('\n')}`}\n\nNumber of dispatches: ${log.length}`;
}

function resultOf(received: unknown, ctx: MatcherContext): CommandResult {
  if (typeof (received as CommandResult | null)?.ok !== 'boolean') {
    throw new TypeError(
      `expected a CommandResult ({ ok, value } or { ok, error }), received ${ctx.utils.stringify(received)}. ` +
        'An async bus returns a Promise: await the dispatch first.',
    );
  }
  return received as CommandResult;
}

function describeResult(r: CommandResult, ctx: MatcherContext): string {
  const error = r.error as { code?: unknown; message?: string } | undefined;
  return r.ok ? `it succeeded with ${ctx.utils.stringify(r.value)}` : `it failed with ${String(error?.code)}: ${error?.message}`;
}

const not = (ctx: MatcherContext) => (ctx.isNot ? 'not ' : '');

function toolResultOf(received: unknown, ctx: MatcherContext): McpToolResult {
  if (!Array.isArray((received as McpToolResult | null)?.content)) {
    throw new TypeError(
      `expected an MCP tool result ({ content, isError? }), received ${ctx.utils.stringify(received)}. ` +
        'mcpClient().call() returns a Promise: await the call first.',
    );
  }
  return received as McpToolResult;
}

const toolText = (r: McpToolResult) => r.content.map((block) => block.text).join('\n');

// A tool's text parsed as JSON, the way createMcpHandler serializes a value;
// text that is not JSON stays text.
function toolValue(r: McpToolResult): unknown {
  try {
    return JSON.parse(toolText(r));
  } catch {
    return toolText(r);
  }
}

// A bus matcher's verdict, unless the tap was removed and the verdict is one a
// missed record could have produced. A missed record only ever turns a match
// into no match, so that is `pass === false`: a failing assertion, or a
// passing `.not`.
function verdict(bus: unknown, pass: boolean, message: () => string) {
  if (!pass && tapRemoved(bus as object)) throw new VcTestError('VC_TEST_TAP_REMOVED');
  return { pass, message };
}

// For a count or a position a missed record moves the outcome either way (a
// count read too low can match, the last one read can be the wrong one), so
// after a removal no verdict of these matchers is trustworthy.
function exactVerdict(bus: unknown, pass: boolean, message: () => string) {
  if (tapRemoved(bus as object)) throw new VcTestError('VC_TEST_TAP_REMOVED');
  return { pass, message };
}

// One line, as Vitest prints the expected value in a spy matcher's header.
const inline = (ctx: MatcherContext, value: unknown) => ctx.utils.stringify(value, undefined, { min: true });

// The Received block every dispatch matcher ends with, diffing { action, payload }.
function receivedPayloads(ctx: MatcherContext, log: TappedDispatch[], action: string, payload: unknown): string {
  const view = (d: TappedDispatch) => ({ action: d.action, payload: d.payload });
  return received(ctx, log, { action, payload }, view);
}

/**
 * The matcher implementations, for `expect.extend(matchers)`. The bus matchers
 * read what `tap()` recorded and throw a `VcTestError` on a bus it never saw,
 * `.not` included, so a negated assertion cannot pass vacuously. The result
 * matchers read a `CommandResult` and compare codes, never message text.
 */
export const matchers = {
  toHaveBeenDispatched(this: MatcherContext, bus: unknown, action: string) {
    const log = recordsOf(bus);
    const count = log.filter((d) => d.action === action).length;
    const view = (d: TappedDispatch) => ({ action: d.action, payload: d.payload });
    return verdict(bus, count > 0, () =>
      (this.isNot
        ? `expected "${action}" to not be dispatched at all, but actually been dispatched ${count} times`
        : `expected "${action}" to be dispatched at least once`) + received(this, log, undefined, view),
    );
  },

  toHaveBeenDispatchedWith(this: MatcherContext, bus: unknown, action: string, payload: unknown) {
    const log = recordsOf(bus);
    const pass = log.some((d) => d.action === action && equal(this, d.payload, payload));
    return verdict(bus, pass, () =>
      `expected "${action}" to ${this.isNot ? 'not ' : ''}be dispatched with payload: ${inline(this, payload)}${receivedPayloads(this, log, action, payload)}`,
    );
  },

  toHaveBeenDispatchedTimes(this: MatcherContext, bus: unknown, action: string, times: number) {
    const log = recordsOf(bus);
    const count = log.filter((d) => d.action === action).length;
    return exactVerdict(bus, count === times, () =>
      `expected "${action}" to ${this.isNot ? 'not ' : ''}be dispatched ${times} times, but got ${count} times${received(this, log, undefined, (d) => ({ action: d.action, payload: d.payload }))}`,
    );
  },

  toHaveBeenDispatchedOnce(this: MatcherContext, bus: unknown, action: string) {
    const log = recordsOf(bus);
    const count = log.filter((d) => d.action === action).length;
    return exactVerdict(bus, count === 1, () =>
      `expected "${action}" to ${this.isNot ? 'not ' : ''}be dispatched once, but got ${count} times${received(this, log, undefined, (d) => ({ action: d.action, payload: d.payload }))}`,
    );
  },

  toHaveBeenNthDispatchedWith(this: MatcherContext, bus: unknown, nth: number, action: string, payload: unknown) {
    const log = recordsOf(bus);
    const nthOfAction = log.filter((d) => d.action === action)[nth - 1];
    const pass = nthOfAction !== undefined && equal(this, nthOfAction.payload, payload);
    return exactVerdict(bus, pass, () =>
      `expected ${ordinal(nth)} "${action}" dispatch to ${this.isNot ? 'not ' : ''}have payload: ${inline(this, payload)}${receivedPayloads(this, log, action, payload)}`,
    );
  },

  toHaveBeenLastDispatchedWith(this: MatcherContext, bus: unknown, action: string, payload: unknown) {
    const log = recordsOf(bus);
    const last = log.filter((d) => d.action === action).at(-1);
    const pass = last !== undefined && equal(this, last.payload, payload);
    return exactVerdict(bus, pass, () =>
      `expected last "${action}" dispatch to ${this.isNot ? 'not ' : ''}have payload: ${inline(this, payload)}${receivedPayloads(this, log, action, payload)}`,
    );
  },

  toHaveFailedWith(this: MatcherContext, bus: unknown, action: string, code: string) {
    const log = recordsOf(bus);
    const pass = log.some((d) => d.action === action && !d.ok && d.code === code);
    return verdict(bus, pass, () =>
      `expected "${action}" ${not(this)}to have failed with ${code}${received(this, log, { action, code }, (d) => ({ action: d.action, code: d.code }))}`,
    );
  },

  toSucceedWith(this: MatcherContext, received: unknown, ...value: [unknown?]) {
    const r = resultOf(received, this);
    const withValue = value.length > 0;
    const pass = r.ok && (!withValue || equal(this, r.value, value[0]));
    const what = withValue ? ` with ${this.utils.stringify(value[0])}` : '';
    return { pass, message: () => `expected the dispatch ${not(this)}to succeed${what}, and ${describeResult(r, this)}` };
  },

  toFailWith(this: MatcherContext, received: unknown, code: string) {
    const r = resultOf(received, this);
    const pass = !r.ok && (r.error as { code?: unknown }).code === code;
    return { pass, message: () => `expected the dispatch ${not(this)}to fail with ${code}, and ${describeResult(r, this)}` };
  },

  toBeToolResult(this: MatcherContext, received: unknown, ...value: [unknown?]) {
    const r = toolResultOf(received, this);
    const withValue = value.length > 0;
    const pass = r.isError !== true && (!withValue || equal(this, toolValue(r), value[0]));
    const what = withValue ? ` with ${this.utils.stringify(value[0])}` : '';
    const detail = r.isError === true
      ? `, and it failed: ${toolText(r)}`
      : withValue ? `\n\n${this.utils.diff(value[0], toolValue(r), { omitAnnotationLines: true })}` : '';
    return { pass, message: () => `expected tool result ${not(this)}to succeed${what}${detail}` };
  },

  toBeToolError(this: MatcherContext, received: unknown, expected?: string | RegExp) {
    const r = toolResultOf(received, this);
    const text = toolText(r);
    const pass = r.isError === true && (expected === undefined || (typeof expected === 'string' ? text.includes(expected) : expected.test(text)));
    const what = expected === undefined ? '' : typeof expected === 'string' ? ` containing "${expected}"` : ` matching ${expected}`;
    return { pass, message: () => `expected tool result ${not(this)}to be an error${what}, and it ${r.isError === true ? 'failed' : 'succeeded'} with: ${text}` };
  },
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type MapOf<T> = T extends CommandBus<infer M> ? M : T extends AsyncCommandBus<infer M> ? M : CommandMap;

/** The actions a matcher accepts for received value `T`: the bus's own names when typed, any string when not. */
export type ActionOf<T> = string extends keyof MapOf<T> ? string : keyof MapOf<T> & string;

/** The payload a matcher accepts for action `A` on received value `T`. */
export type ExpectedPayload<T, A> = A extends keyof MapOf<T> ? PayloadOf<MapOf<T>, A> : unknown;

/**
 * An error code: the bus's own codes autocomplete, and a handler's domain code
 * is accepted too, because a handler's throw reaches `result.error` as thrown.
 */
export type ExpectedCode = BusErrorCode | (string & {});

/**
 * The matcher signatures, typed from the received value. `vapor-chamber/vitest`
 * merges this into Vitest's `Matchers<R, T>`; this entry does not, so importing
 * it alone never types a matcher it did not register.
 */
export interface VaporChamberMatchers<R = unknown, T = unknown> {
  /** The bus dispatched `action` at least once. Vitest's `toHaveBeenCalled`, for one action. */
  toHaveBeenDispatched<A extends ActionOf<T>>(action: A): R;
  /** Some dispatch of `action` carried a payload equal to `payload` (toEqual's comparison). */
  toHaveBeenDispatchedWith<A extends ActionOf<T>>(action: A, payload: ExpectedPayload<T, A>): R;
  /** `action` was dispatched exactly `times` times. */
  toHaveBeenDispatchedTimes<A extends ActionOf<T>>(action: A, times: number): R;
  /** `action` was dispatched exactly once. */
  toHaveBeenDispatchedOnce<A extends ActionOf<T>>(action: A): R;
  /** The `nth` dispatch of `action` (1-based, counting that action only) carried `payload`. */
  toHaveBeenNthDispatchedWith<A extends ActionOf<T>>(nth: number, action: A, payload: ExpectedPayload<T, A>): R;
  /** The last dispatch of `action` carried `payload`. */
  toHaveBeenLastDispatchedWith<A extends ActionOf<T>>(action: A, payload: ExpectedPayload<T, A>): R;
  /** The bus dispatched `action` and it failed with `code`. */
  toHaveFailedWith<A extends ActionOf<T>>(action: A, code: ExpectedCode): R;
  /** The result succeeded, and when given, with a value equal to `value`. */
  toSucceedWith(value?: T extends CommandResult<infer V> ? V : unknown): R;
  /** The result failed with `code`. */
  toFailWith(code: ExpectedCode): R;
  /** An MCP tool result succeeded, and when given, its text parsed as JSON equals `value`. */
  toBeToolResult(value?: unknown): R;
  /** An MCP tool result is an error, and when given, its text contains the string or matches the RegExp. */
  toBeToolError(expected?: string | RegExp): R;
}
