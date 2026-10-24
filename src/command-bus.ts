/**
 * vapor-chamber - Command Bus for Vue Vapor
 *
 * Sizes are not quoted here. This header carried "~3.6 KB brotli core" while
 * the generated table measured 4.2 - a hand-typed number in a source file that
 * no generator can reach and no gate can check. `docs/BUNDLE-SIZES.md` is
 * regenerated every run and is the only place a size should be read from.
 * DevTools is loaded dynamically.
 */

// ---------------------------------------------------------------------------
// Structured error codes - machine-readable, LLM-friendly, i18n-ready
// ---------------------------------------------------------------------------

/**
 * Severity level for bus diagnostics.
 * - `'error'`: dispatch failed, result.ok === false
 * - `'warn'`: recoverable issue, dispatch may succeed (e.g. naming violation)
 * - `'info'`: informational (e.g. handler overwrite, circuit breaker state change)
 */
import { DEV } from './dev';
import { _report } from './report';
import { Accepted } from './accepted';
import { keyTextFor } from './canonical';
import { MAX_TIMEOUT_MS, countOption, delayOption, isDelay } from './bounds';
import { createLanes, createSleeper, type Lanes } from './scheduler';
import { onSettled } from './settled';
import { _asLibrary, _isLibraryAction, _isLibraryRegister, _registersLocal } from './library-names';
import { _appliedRemotely, _busStores, _hotUpdate, _sendsOn, type BusStores } from './applied-remotely';
import { _combineSignals, type GroupHub } from './http';
import type { ActionFilter } from './action-filter';
import { BusError, _RETRY_ATTEMPTS, _RETRY_BASE_MS, _RETRY_MAX_MS, _backoff, _failures, _heldBack, _isBug, _isCancel, conditionOf, conditionOfStatus, ownerOf, retryClass, type BusErrorCode, type Condition, type Fail, type FailCode, type FailOptions } from './failure';
import { _patternPrefix, matchesPattern } from './pattern';
export { BusError, _failures, _isBug, conditionOf, conditionOfStatus, ownerOf, type BusErrorCode, type Condition, type Fail, type FailCode, type FailOptions };
export type BusSeverity = 'error' | 'warn' | 'info';



const fail = _failures('core');


/**
 * Any failure's condition, read by contract (docs/contract.md 4, reading by contract): a library
 * failure's own code; an HTTP status (another client's `response.status`) through the
 * status table; a timeout by its name; a cancel, named `AbortError` or the
 * `signal`'s own reason (`_isCancel`); the Fetch standard's `TypeError` for no
 * response at all, `lost`. Anything else - a handler's own throw, a test
 * diagnostic - is `failed` (docs/contract.md rule 8). Pass the command's
 * `signal` to read an abort with the caller's own Error as `aborted`
 * (tests/abort-custom-reason.test.ts).
 */
export function failureCondition(error: unknown, signal?: AbortSignal): Condition {
  const own = conditionOf(error);
  if (own !== undefined) return own;
  const e = error as { name?: unknown; response?: { status?: unknown } } | null;
  const status = e?.response?.status;
  if (typeof status === 'number') return conditionOfStatus(status);
  if (e?.name === 'TimeoutError') return 'timeout';
  if (_isCancel(error, signal)) return 'aborted';
  return error instanceof TypeError ? 'lost' : 'failed';
}

/**
 * The transient conditions: held back (`limited`) or a timeout the other side
 * declared (`timeout`, a 408). The async bus re-sends them for any action.
 * No reply (a transport's own `timeout`, a 504) and the uncertain ones
 * (`lost`, `failed`, `unexpected`, `unknown`: the first attempt may have
 * landed) it re-sends only for an idempotent action or a keyed command. The
 * other side's verdict, an abort and a depth bound never (docs/retry.md,
 * log s35.162).
 */
export const RETRYABLE_CONDITIONS: ReadonlySet<string> = new Set(['limited', 'timeout']);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Automatic metadata stamped on every command. */
export type CommandMeta = {
  /**
   * Wall-clock stamp for correlation and audit - NOT a timing instrument.
   *
   * Read from `Date.now()` **once per microtask turn** and shared by every
   * command dispatched inside that turn. The first command of each turn carries
   * an exact stamp; the 2nd..nth of the same synchronous run repeat it. Since
   * `Date.now()` is millisecond-resolution and a typical burst is
   * sub-millisecond, those commands would almost always have received the same
   * number anyway - what is actually given up is intra-burst resolution in
   * bursts long enough to cross a millisecond (a thousand-command burst reads
   * as instantaneous). Bought ~15-25ns per dispatch; measured in
   * `tests/clock-source-ab.test.ts` (v1.6.0, 2026-08-24).
   *
   * **Ordering does not depend on this field.** `meta.id` is a monotonic
   * counter and stays unique and ordered - use it, not `ts`, to sequence
   * commands.
   *
   * **Do not measure durations with it, cached or not.** `Date.now()` is wall
   * clock: millisecond-resolution and *not monotonic*, so an NTP correction or
   * a clock change can move it, backwards included. That was true before this
   * cache and is not a consequence of it. For real timing use
   * `performance.now()` in a plugin; on a hot loop use `createFastLane()`,
   * which stamps no meta at all.
   */
  ts: number;
  /**
   * Unique, monotonically increasing command ID - the ordering key.
   *
   * Default generator: a per-process random prefix plus an incrementing
   * counter (`configureUid` swaps it; `crypto.randomUUID` is the documented
   * opt-in for cross-process auditing, not the default).
   */
  id: string;
  /** ID of the command that caused this one (set manually via payload.__causationId). */
  causationId?: string;
  /** Correlation ID for tracing a chain of commands (propagates from parent). */
  correlationId?: string;
  /**
   * Idempotency key. Transports (e.g. httpTransport) forward it as an
   * `Idempotency-Key` header, or that name in a batched command's or a
   * frame's `headers`, so the backend can reject duplicate writes.
   * Always present, `undefined` until the `idempotent` plugin, the outbox or
   * the retry (an action declared idempotent) stamps it. Never the command's
   * content: an app's own key as given, an outbox record's key, else this
   * dispatch's `id` (tests/idempotency-key.test.ts).
   */
  idempotencyKey?: string;
  /**
   * The 2xx response a transport's reply arrived in, Fetch's members (a 202
   * says accepted, not finished: RFC 9110 15.3.3). Always present, `undefined`
   * for a local handler; a non-2xx answer is the error's. Log s35.136.
   */
  response?: MetaResponse;
  /**
   * Request-level headers a plugin adds to the request a transport sends
   * (a W3C `traceparent`, a locale), names lowercase. Always present,
   * `undefined` until a plugin sets it. Log s35.139.
   */
  request?: MetaRequest;
  /**
   * Where the command originated. `undefined` (the default) means local user
   * code called dispatch directly. The core never sets this field - dispatchers
   * that proxy external traffic (bridges, sync layers, replay tooling, agent
   * endpoints) stamp it post-hoc via plugins so downstream plugins, hooks, and
   * listeners can distinguish local intent from mirrored or machine-driven
   * commands (e.g. skip re-broadcasting a `'sync'` command, or audit-log
   * everything marked `'agent'`).
   *
   * Well-known values: `'user'`, `'remote'`, `'sync'`, `'replay'`, `'agent'` -
   * but any string is accepted for custom origins. The core stamps two of its
   * own: `'undo'` on every dispatch made synchronously inside
   * an undo handler and `'redo'` on a redo and what its handler dispatches
   * (`_withOriginScope`); `history()` and `useCommandHistory` record
   * neither, nor a `'sync'` command (a change an app's sync layer mirrored from
   * elsewhere). A shared store dispatches nothing for another tab's command.
   *
   * @example
   * bus.use({ started(cmd) {
   *   if (cmd.meta?.origin === 'agent') console.info('LLM-driven:', cmd.action);
   * } });
   */
  origin?: 'user' | 'remote' | 'sync' | 'replay' | 'agent' | 'undo' | 'redo' | (string & {});
};

/** A response's members as Fetch names them; header names lowercase. */
export type MetaResponse = { status: number; headers: Record<string, string>; url?: string; redirected?: boolean };
/** What a plugin adds to the request a transport sends. */
export type MetaRequest = { headers: Record<string, string> };

export type Command<A extends string = string, T = any, P = any> = {
  // Readonly, with `meta`: every part, listener and history entry reads one
  // command, so it stays as dispatched (the meta's own fields stay writable).
  // The type says so, at no runtime cost (log 36.127). tests/command-readonly.test.ts.
  readonly action: A;
  readonly target: T;
  readonly payload?: P;
  /** Auto-stamped metadata - timestamp, unique id, correlation/causation tracing.
   *  Always present on commands from dispatch/query/emit. Optional on manually constructed commands. */
  readonly meta?: CommandMeta;
  /**
   * The signal the work runs under. On the async bus, `bus.dispatch(..., { signal })`
   * sets it: async handlers may listen to `cmd.signal.aborted` /
   * `cmd.signal.addEventListener('abort', ...)` to short-circuit work, and
   * transports (HTTP) forward it to the underlying fetch. A sync dispatch
   * ignores its own `{ signal }` option: it is atomic. On either bus a step's
   * ticket (`PluginParts.begin`) may set it, combined with any already there,
   * so work a handler starts and does not await can be cancelled by the step
   * that owns the signal (tests/work-steps.test.ts).
   */
  signal?: AbortSignal;
};

/** Optional per-dispatch options. Currently: `{ signal }` for cancellation. */
export type DispatchOptions = {
  /** Abort the dispatch before it starts (if already aborted) or signal async
   *  handlers and transports to cancel mid-flight. Async bus only. */
  signal?: AbortSignal;
};

/**
 * Result of a dispatch/query - a discriminated union on `ok`.
 *
 * `if (result.ok)` narrows away `error`; on the failure arm `error` is a
 * guaranteed `Error` (no `!` or `?.` needed). `value` stays optional on the
 * success arm because void commands legitimately produce no value.
 */
export type CommandResult<V = any> =
  | { ok: true; value?: V; error?: undefined }
  | { ok: false; error: Error; value?: undefined };

export type Handler<T = any, P = any, R = any> = (cmd: Command<string, T, P>) => R;
/** An async bus's handler: a value or a promise of it. A value answers sooner (tests/async-handler-types.test.ts). */
export type AsyncHandler<T = any, P = any, R = any> = (cmd: Command<string, T, P>) => R | Promise<R>;
/**
 * What a plugin declares besides its function: `dispose` (the bus's dispose()
 * runs it), `id` (the owner of its failures), `actions` (the only actions the
 * bus runs it on, an {@link ActionScope}; log s35.141).
 * `actionFilter`: a predicate on the action name (src/action-filter.ts), ANDed
 * with `actions` when both are given, asked once per action (log s35.152).
 * `forget(cmd)`: the bus calls it on every installed plugin once an undo of
 * `cmd` lands, so a plugin drops what it keeps for that command (cache and
 * idempotent drop its stored answer) and a redo runs (log s35.181).
 * `attach(bus)`: called once when `use()` installs the plugin, with that bus.
 * What it returns runs when the function `use()` returned takes it out. A
 * plugin that only listens subscribes here (`revalidateRoutes`), as a
 * transport's `attach` gets its bus. tests/router/cache-groups.test.ts.
 * `settled(cmd, result)`: the bus calls it with the command state, after the
 * `onAfter` hooks and before the listeners, on the actions its scope covers, so
 * it hears every outcome, a rule's refusal included. A plugin is these parts, an object: `use()` places each of them.
 * tests/plugin-settled-part.test.ts.
 * `authorize(action)` and `validate(action)`: the action's rule, or undefined
 * for none, asked once per action its scope covers. The bus runs every authorize rule, then
 * every validate rule, after the start and before the work's steps
 * and the work: the first refusal is the command's answer, so it never
 * reaches a limit, a cache, a retry or the transport.
 * tests/rules-before-the-work.test.ts.
 * `started(cmd)`: a dispatch or a query starts, before its rules, on the
 * actions its scope covers. With `settled` it times every outcome
 * (`metrics`). Both are the bus's facts: a throw in either is logged and the
 * command goes on. tests/plugin-started-part.test.ts.
 * The work's steps, run around the action's work (its transport, its local
 * handler, a request's responder) on the actions its scope covers, once per
 * dispatch, never per retry, each kind for every plugin before the next:
 * `reuse(cmd)` a stored answer, the first one the command's (`cache`,
 * `idempotent`); `admit(cmd, fail)` a limit's refusal, a pure check, so a
 * refused command spends nothing (`rateLimit`, `circuitBreaker`); `begin(cmd)`
 * the command goes to the work, with an optional {@link WorkTicket}. A step's
 * throw is its plugin's `failed:plugin`. tests/work-steps.test.ts.
 */
export type PluginParts = { dispose?: () => void; readonly id?: string; readonly actions?: Readonly<ActionScope>; readonly actionFilter?: ActionFilter; forget?: (cmd: Command) => void; attach?: (bus: BaseBus) => (() => void) | void; started?: (cmd: Command) => void; settled?: (cmd: Command, result: CommandResult) => void; authorize?: (action: string) => Refusal | undefined; validate?: (action: string) => Refusal | undefined; reuse?: (cmd: Command) => CommandResult | Promise<CommandResult> | undefined; admit?: (cmd: Command, fail: Fail) => CommandResult | undefined; begin?: (cmd: Command) => WorkTicket | undefined };

/**
 * What a `begin` step hands the bus for one command. `signal`: the work's
 * signal, in place of the caller's (a step that keeps the caller's combines
 * it in; several steps' signals are combined). `landed(result)`: the work's
 * final result, after the retry, before the settle. `answer`: the caller's
 * answer in place of the work's, while the work runs on for others
 * (`idempotent`'s join, each caller's abort its own).
 */
export type WorkTicket = { readonly signal?: AbortSignal; landed?(result: CommandResult): void; readonly answer?: Promise<CommandResult> };

/** A rule's answer to a command, through its plugin's `fail`: a refusal, or undefined to let it through. */
export type Refusal = (cmd: Command, fail: Fail) => CommandResult | undefined | Promise<CommandResult | undefined>;

/**
 * A transport: the work for the actions it is declared for at the async bus
 * (`createAsyncCommandBus({ transport })`), never a plugin, so every plugin
 * wraps it wherever it was installed. `send` answers one command; `local` runs
 * the action's local handler, for a transport that falls back to it. `id` owns
 * its failures; `dispose` runs at the bus's `dispose()`. `attach`, called
 * once at the bus's creation, gets that bus: where a transport that reads
 * the server's pushes delivers them (`wsTransport`, docs/contract.md 4).
 * `httpTransport` and `wsTransport` (vapor-chamber/transports) are two;
 * `defineTransport(send)` makes an app's own.
 */
export type Transport = {
  readonly id?: string;
  /**
   * Whether `send` may call `local()`, the action's local handler: declared
   * by the transport, never guessed. Only then is a handler registered for
   * one of its actions, `optimistic` aside (`register()`,
   * `core:invalid:handler`). Every transport of the library's sets it.
   */
  readonly localFallback?: boolean;
  send(cmd: Command, local: () => Promise<CommandResult>): CommandResult | Promise<CommandResult>;
  dispose?(): void;
  attach?(bus: BaseBus): void;
  /**
   * Whether it can send now, for a transport that can be unable to (a
   * WebSocket while its socket is not open). An outbox over it holds its
   * commands while this is false. A transport without it can always send.
   */
  isConnected?(): boolean;
};

/**
 * A plugin's action filter, the `actions` option of every plugin that takes
 * one and the `actions` it declares to the bus: absent or `[]` is every action
 * (ActionScope's own rule, stated here once), each entry an action name or a pattern
 * (`'cart*'`, `'*'`). Read by the bus alone. Log s35.146 and s35.148,
 * tests/plugin-empty-list.test.ts. `string[]`, so an app edits its list; a plugin declares it
 * read-only (`Readonly<ActionScope>`). tests/option-types.test-d.ts.
 */
export type ActionScope = string[];

/**
 * The scope options of a plugin or recorder that takes one: `actions` (an
 * {@link ActionScope}) and `actionFilter` (a predicate of the action name,
 * `createActionFilter`), ANDed. Read by `_scoped`, once per action. The same
 * two names `metrics`, `cache` and the other plugins take.
 */
export type ScopeOptions = { actions?: ActionScope; actionFilter?: ActionFilter };

export type Hook = (cmd: Command, result: CommandResult) => void;
export type AsyncHook = (cmd: Command, result: CommandResult) => void | Promise<void>;


/** Batch dispatch input */
export type BatchCommand = { action: string; target: any; payload?: any };

/** Options for batch dispatch */
export type BatchOptions = {
  continueOnError?: boolean;
  /**
   * All-or-nothing semantics: if any command fails, automatically run the
   * registered undo handler for every command that already succeeded (in reverse order).
   * Requires undo handlers to be registered via `register(action, handler, { undo })`.
   * Commands without an undo handler are skipped during rollback.
   * Mutually exclusive with `continueOnError`.
   */
  transactional?: boolean;
  /**
   * AbortSignal applied to the whole batch. Aborting before the batch starts
   * skips it entirely; aborting mid-flight stops further commands from
   * dispatching (the in-flight one runs to completion since per-command
   * abort already happened or is the handler's responsibility) and the
   * batch result is
   * `{ ok: false, error: BusError('core:aborted:dispatch'), results: [...partial] }`
   * - a BusError rather than the raw DOMException so the code is queryable
   * (see `abortedResult`; a caller-supplied `signal.reason` is passed through
   * unchanged). Under `transactional`, rollback runs first and
   * `successCount` is reported as 0.
   * Async bus only - sync `dispatchBatch` accepts the option for type
   * uniformity but ignores it.
   */
  signal?: AbortSignal;
};

/** Result of a batch dispatch */
export type BatchResult = {
  ok: boolean;
  results: CommandResult[];
  error?: Error;
  /** Number of commands that completed successfully */
  successCount: number;
  /** Number of commands that failed */
  failCount: number;
  /** Results of undo handlers run during transactional rollback (reverse order). Only present when `transactional: true` and a command failed. */
  rollbacks?: CommandResult[];
};

/**
 * Dead letter mode - what to do when a command has no registered handler.
 * - `'error'` (default): returns `{ ok: false, error }`
 * - `'throw'`: throws the error
 * - `'ignore'`: returns `{ ok: true, value: undefined }`
 * - function: called with the command, return value used as result
 *
 * To make a dispatch wait for a handler that registers later, give the bus a
 * `buffer` (`createBuffer`): it takes precedence for a dispatch, and a query
 * still answers by this mode.
 */
export type DeadLetterMode = 'error' | 'throw' | 'ignore' | ((cmd: Command) => CommandResult);

/**
 * Naming convention configuration.
 * Enforces a regex pattern on action names at register and dispatch time.
 * A name containing `$` is the library's (a store's `<id>$reset`) and is not
 * checked (tests/store-reset-command.test.ts).
 */
export type NamingConvention = {
  /** Regex pattern that action names must match */
  pattern: RegExp;
  /** What to do on violation: 'warn' logs, 'throw' throws, 'ignore' skips */
  onViolation?: 'warn' | 'throw' | 'ignore';
};

/** Per-command registration options */
export type RegisterOptions = {
  /**
   * Inverse handler for undo support, run by the `<action>$undo` command.
   * Called with the original command, which still carries that dispatch's
   * `signal`: aborted when the dispatch was cancelled (by `supersede`, or by
   * the caller), so it cannot serve the inverse's own work.
   * tests/library-commands-memory.test.ts.
   */
  undo?: Handler;
  /**
   * Whether history may still undo this recorded command. History undoes only
   * when true. A rollback (an `optimistic` action's failure, a transactional batch) reverses
   * the step that failed and does not consult it. tests/undo-check.test.ts.
   */
  canUndo?: (cmd: Command) => boolean;
  /**
   * Called when a transport answered the command, with the answer's value.
   * A sent action declares it with no handler: `register(action, null, {
   * answer })`. It runs at the transport's level, so the plugins outside it
   * see what it changes. A throw fails the dispatch. A store's `answer`
   * option is one. tests/store-bridged-answer.test.ts.
   */
  answer?: (cmd: Command, value: unknown) => void;
  /**
   * The command answers at once, its change already shown. On the async bus
   * the dispatch answers an `Accepted`, whose `done` settles with the result,
   * and listeners, after-hooks and history hear that result when it lands.
   * For an action a transport sends, the handler is the change shown: it runs
   * when the plugins hand on, before an `exclusive` turn is waited for, and
   * is the transport's local fallback, never run twice. A failure of the work
   * runs `undo` first (the `<action>$undo` command). A plugin's refusal runs
   * nothing, so nothing is shown or undone. On the sync bus a throw runs the
   * undo and the failure returns. Needs `undo` and a handler (`core:invalid:option`).
   * tests/register-optimistic.test.ts.
   */
  optimistic?: boolean;
  /**
   * Commands with one key never overlap: one at a time, first in first out.
   * The turn is taken at dispatch and held for the work and every retry, so a
   * retried command keeps its turn; the plugins run at once, so a refused
   * command never waits. A failure never stalls the key. `key` defaults to the action; one action or
   * several may share a key, and `null` runs a command at once. `scope:
   * 'cross-tab'` holds the key across every tab of the origin through Web
   * Locks (`lockPrefix`, default `vapor-chamber:exclusive`), and on this bus
   * where the API is absent. A sync handler runs to its end before the next,
   * so the sync bus already holds it. tests/register-exclusive.test.ts.
   */
  exclusive?: Exclusive;
  /**
   * The cache groups a cached result of this action joins (RFC 9875
   * `Cache-Groups`): `cache()` drops it when one of them goes, from any
   * source. tests/cache-groups-hub.test.ts.
   */
  cacheGroups?: readonly string[];
  /**
   * The cache groups a success of this action makes stale (RFC 9875
   * `Cache-Group-Invalidation`): `cache()`, the client's stored reads and the
   * router hear them, as a server's answer naming them. An `Accepted` makes
   * them stale once its `done` settles ok. tests/cache-groups-hub.test.ts.
   */
  cacheGroupInvalidation?: readonly string[];
};

/** `RegisterOptions.exclusive`. */
export type Exclusive = {
  key?: (cmd: Command) => string | number | null | undefined;
  scope?: 'instance' | 'cross-tab';
  lockPrefix?: string;
};

export type CommandBusOptions = {
  onMissing?: DeadLetterMode;
  /** Enforce naming convention on action names */
  naming?: NamingConvention;
  /**
   * Hold a dispatch whose action has no handler yet, and run it when the
   * handler registers (`createBuffer`, buffer.ts). Built for lazy wiring: an
   * island or a code-split panel. A query never waits.
   */
  buffer?: { readonly [_BUFFER]: BusBuffer };
};

/** @internal The key of a buffer's half the bus reads (buffer.ts). */
export const _BUFFER: unique symbol = Symbol('vapor-chamber:buffer');
/** @internal What the bus needs from a buffer. */
export type BusBuffer = {
  /** Hold a dispatch with no handler: its answer. */
  hold(cmd: Command): CommandResult;
  /** A handler for `action` registered: run what waited for it. */
  release(action: string): void;
  /** The bus's clear(): settle every waiting caller. */
  clear(): void;
  attach(bus: BaseBus): void;
};

/**
 * What the async bus's retry does with an action (gRPC's per-method
 * `retryPolicy`): `'idempotent'` (running it twice is safe, so an uncertain
 * failure is re-sent too, under one idempotency key), `false` (never re-sent)
 * or an attempt count.
 */
export type RetryPolicy = 'idempotent' | false | number;

/** The async bus's retry (docs/retry.md). Every field has a default. */
export type RetryOptions = {
  /** Attempts in total, the first included. Default 3, at least 1. */
  maxAttempts?: number;
  /** The backoff's base in ms: attempt n waits up to `baseDelay * 2^(n-1)`. Default 200. */
  baseDelay?: number;
  /** The longest wait, in ms. Default 20_000. A computed wait is capped at it; a
   *  declared `retryIn` longer than it is not re-sent: the failure is returned. */
  maxDelay?: number;
  /**
   * A policy per action name or pattern (`'cart*'`, `'*'`). The most specific
   * match wins, whatever the written order: the exact name, then the longest
   * prefix, then `*` (gRPC service config). tests/retry-action-policies.test.ts.
   */
  actionPolicies?: Readonly<Record<string, RetryPolicy>>;
};

export type AsyncCommandBusOptions = CommandBusOptions & {
  /**
   * The retry, on by default: a transient failure (`limited`, a 408) is
   * re-sent for any action. An uncertain one (no reply, a 502, 504 or 500),
   * or one with a declared `retryIn`, only for an action declared idempotent
   * or a keyed command. An unidentified command that got no reply fails with
   * `context.outcome: 'unknown'`. `false` turns it off.
   */
  retry?: RetryOptions | false;
  /**
   * Where commands go over a wire: one {@link Transport} for every action, or
   * a map from action pattern to transport, the most specific match winning
   * whatever the written order (the exact name, then the longest prefix, then
   * `*`, as `retry.actionPolicies`). A command with a transport is sent; any
   * other runs its local handler. A `$` action (the library's) is always local.
   */
  transport?: Transport | Readonly<Record<string, Transport>>;
  /**
   * The offline outbox (`createOutbox`): the actions it covers that have a
   * transport are held while offline and sent in order once online. Decided
   * once per action; any other action pays nothing.
   */
  outbox?: { readonly [_OUTBOX]: BusOutbox; dispose(): void };
};

/** @internal The key of an outbox's half the bus reads (outbox.ts). */
export const _OUTBOX: unique symbol = Symbol('vapor-chamber:outbox');
/**
 * @internal How an outbox sends a record: through the transport `unwrap`
 * gives for the action's, at the work step of the bus it is on.
 */
export type SendAt = (unwrap: (t: Transport) => Transport, action: string, target: unknown, payload: unknown, key: string) => Promise<CommandResult>;

/**
 * @internal What the bus needs from an outbox: the transport an action
 * resolves to (its own wrapper for an action it covers), read once per action,
 * and where its records go, given at creation: the async bus's state (sent by
 * `_sendAt`), or a transport's own send off an async bus (the test bus).
 */
export type BusOutbox = {
  adapt(action: string, transport: Transport): Transport;
  attach(bus: unknown | SendAt): void;
  /** A transport can send again (`_opened`): flush what waits. */
  opened(): void;
};

/** Listener callback for on() subscriptions (wildcard-capable) */
export type Listener = (cmd: Command, result: CommandResult) => void;

/**
 * Options for `on()`/`once()` subscriptions.
 * The returned unsubscribe function also carries `Symbol.dispose`, so
 * `using off = bus.on(...)` works without an explicit `off()` call.
 */
export type ListenerOptions = {
  /** Auto-unsubscribe when the signal aborts. Already-aborted at call time
   *  means the listener is never added - matches DOM `addEventListener`. */
  signal?: AbortSignal;
};

/**
 * Typed command map - define action names, target, payload, and result shapes.
 * Use with createCommandBus<MyMap>() for type-safe dispatch and register.
 *
 * @example
 * type AppCommands = {
 *   cartAdd: { target: { id: number }; payload: { qty: number }; result: void };
 *   cartClear: { target: {}; result: number };
 * };
 * const bus = createCommandBus<AppCommands>();
 * bus.dispatch('cartAdd', { id: 1 }, { qty: 2 }); // fully typed
 */
export type CommandMap = Record<string, { target?: any; payload?: any; result?: any }>;

/** Extract the target type for action A from a CommandMap. Used in typed bus interfaces. */
export type TargetOf<M extends CommandMap, A extends keyof M> = M[A] extends { target: infer T } ? T : any;
/** Extract the payload type for action A from a CommandMap. */
export type PayloadOf<M extends CommandMap, A extends keyof M> = M[A] extends { payload: infer P } ? P : any;
/** Extract the result type for action A from a CommandMap. */
export type ResultOf<M extends CommandMap, A extends keyof M> = M[A] extends { result: infer R } ? R : any;

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/**
 * Structural base interface for both sync and async buses.
 * Use this as the parameter type in utilities (createChamber, createWorkflow, etc.)
 * to avoid `as any` casts when working with either bus variant.
 */
export interface BaseBus {
  dispatch(action: string, target: any, payload?: any, options?: DispatchOptions): any;
  /** Read-only dispatch - runs the rules, the steps and the handler, fires afterHooks. No mutation intent. */
  query(action: string, target: any, payload?: any): any;
  /** Fire a domain event - notifies on() listeners, no handler required, no result returned. */
  emit(event: string, data?: any): void;
  register(action: string, handler: any, options?: RegisterOptions): () => void;
  use(plugin: PluginParts): () => void;
  onAfter(hook: any): () => void;
  on(pattern: string, listener: Listener, options?: ListenerOptions): () => void;
  once(pattern: string, listener: Listener, options?: ListenerOptions): () => void;
  /** Remove all `on()` listeners matching the given pattern, or all listeners if omitted. */
  offAll(pattern?: string): void;
  hasHandler(action: string): boolean;
  /** Returns all registered action names. Useful for introspection and DevTools. */
  registeredActions(): string[];
  clear(): void;
  /**
   * Full teardown - calls clear() and cancels all pending timers/requests. Use in SSR or component-scoped buses.
   * A request() still waiting on its responder settles at once as
   * core:aborted:dispatch with its timer cleared; the responder is not told (only the caller's own signal
   * reaches cmd.signal, on the async bus). There is no disposed state - the bus stays usable - and
   * dispose() works on a sealed bus, which stays sealed. It also runs each installed plugin's
   * `dispose()` first (retry owns timers), before the plugins are dropped.
   */
  dispose(): void;
  /**
   * Seal the bus - prevents further register(), use(), onAfter(), respond() calls.
   * Dispatch, query, emit, on(), once() still work - seal protects the handler/plugin topology,
   * not the observation layer. Listeners via on()/once() can still subscribe after seal.
   * Call after app initialization to lock down the graph in production. Throws BusError
   * with code 'core:refused:bus' on any mutation attempt. clear() is a mutation too and throws
   * on a sealed bus, since it would delete the undo handlers and plugins the seal commits: for
   * HMR, call unsealBus() first, then clear(). dispose() works on a sealed bus and leaves it
   * sealed.
   */
  seal(): void;
  /** Returns true if the bus has been sealed. */
  isSealed(): boolean;
}

export interface CommandBus<M extends CommandMap = CommandMap> extends BaseBus {
  /**
   * Sync dispatch. The optional `options.signal` is accepted for type
   * compatibility with `AsyncCommandBus` but **ignored at runtime** - sync
   * dispatches are atomic and not cancelable. Pass a signal here only if
   * you also use the async bus and want a uniform call site.
   */
  dispatch<A extends keyof M & string>(
    action: A,
    target: TargetOf<M, A>,
    payload?: PayloadOf<M, A>,
    options?: DispatchOptions,
  ): CommandResult<ResultOf<M, A>>;
  /** Read-only dispatch - runs the rules, the steps and the handler, fires afterHooks. */
  query<A extends keyof M & string>(action: A, target: TargetOf<M, A>, payload?: PayloadOf<M, A>): CommandResult<ResultOf<M, A>>;
  /** Fire a domain event - notifies on() listeners, no handler required, no result. */
  emit(event: string, data?: any): void;
  dispatchBatch(commands: BatchCommand[], options?: BatchOptions): BatchResult;
  register<A extends keyof M & string>(action: A, handler: (cmd: Command<A, TargetOf<M, A>, PayloadOf<M, A>>) => ResultOf<M, A>, options?: RegisterOptions): () => void;
  use(plugin: PluginParts): () => void;
  onAfter(hook: Hook): () => void;
  on(pattern: string, listener: Listener, options?: ListenerOptions): () => void;
  /** Subscribe to the first matching command only; auto-unsubscribes after it fires. */
  once(pattern: string, listener: Listener, options?: ListenerOptions): () => void;
  offAll(pattern?: string): void;
  /**
   * Request/response: a responder answers, a timeout (default 5000 ms) bounds the wait, and
   * `signal` settles the request - before the responder runs if already aborted, at once if
   * aborted while waiting. The sync command carries no signal (see Command.signal), so the
   * responder is not told; without a responder this is a dispatch.
   */
  request<A extends keyof M & string>(action: A, target: TargetOf<M, A>, payload?: PayloadOf<M, A>, options?: { timeout?: number; signal?: AbortSignal }): Promise<CommandResult<ResultOf<M, A>>>;
  respond(action: string, handler: (cmd: Command) => any | Promise<any>): () => void;
  /** Returns true if a handler is registered for the given action. */
  hasHandler(action: string): boolean;
  /** Returns all registered action names. */
  registeredActions(): string[];
  /**
   * @internal Used by the undo ledger to retrieve an undo handler registered alongside
   * a command handler. Do not call this from application code.
   */
  getUndoHandler(action: string): Handler | undefined;
  /** @internal The `canUndo` registered with an action's undo, for undo history. */
  getUndoCheck(action: string): ((cmd: Command) => boolean) | undefined;
  /** Remove all handlers, plugins, hooks, and listeners. Useful for testing and HMR. */
  clear(): void;
  /** Freeze configuration - rejects register/use/clear after sealing. */
  seal(): void;
  /** Returns true if the bus is sealed. */
  isSealed(): boolean;
  /**
   * Teardown - runs each plugin's dispose(), clears state and settles
   * pending request()s as core:aborted:dispatch. There is no disposed state: the bus stays usable.
   */
  dispose(): void;
}

export interface AsyncCommandBus<M extends CommandMap = CommandMap> extends BaseBus {
  /**
   * Async dispatch with optional `AbortSignal`. If `options.signal` is already
   * aborted at call time, resolves immediately with `core:aborted:dispatch`
   * without invoking the handler. If aborted mid-flight, the handler observes
   * `cmd.signal.aborted === true`; the HTTP transport propagates the signal
   * to the underlying fetch automatically. A handler or plugin that rethrows
   * the signal's reason gets the same `core:aborted:dispatch`. Every abort the
   * bus builds is a BusError named `AbortError`, with the reason as `cause`. A
   * custom Error reason (`ac.abort(myError)`) is never wrapped, at call time or
   * mid-flight: it passes through as itself.
   */
  dispatch<A extends keyof M & string>(
    action: A,
    target: TargetOf<M, A>,
    payload?: PayloadOf<M, A>,
    options?: DispatchOptions,
  ): Promise<CommandResult<ResultOf<M, A>>>;
  /** Read-only dispatch - runs the rules, the steps and the handler, fires afterHooks. */
  query<A extends keyof M & string>(action: A, target: TargetOf<M, A>, payload?: PayloadOf<M, A>): Promise<CommandResult<ResultOf<M, A>>>;
  /** Fire a domain event - notifies on() listeners, no handler required, no result. */
  emit(event: string, data?: any): void;
  dispatchBatch(commands: BatchCommand[], options?: BatchOptions): Promise<BatchResult>;
  /** `null`: the options of an action a transport sends, with no handler (`_checkHandler`). */
  register<A extends keyof M & string>(action: A, handler: ((cmd: Command<A, TargetOf<M, A>, PayloadOf<M, A>>) => ResultOf<M, A> | Promise<ResultOf<M, A>>) | null, options?: RegisterOptions): () => void;
  /** Installs a plugin: the bus places each of its parts. */
  use(plugin: PluginParts): () => void;
  onAfter(hook: AsyncHook): () => void;
  on(pattern: string, listener: Listener, options?: ListenerOptions): () => void;
  /** Subscribe to the first matching command only; auto-unsubscribes after it fires. */
  once(pattern: string, listener: Listener, options?: ListenerOptions): () => void;
  offAll(pattern?: string): void;
  /**
   * Request/response: a responder answers, receiving the command the plugins saw. Identical
   * in-flight requests (same action, target and payload) share one responder run, and each
   * caller keeps its own timeout (default 5000 ms) and `signal`: its abort settles its own
   * promise at once. The responder's cmd.signal aborts, with the caller's reason, once every
   * caller holding the request has aborted. Without a responder this is a dispatch.
   * tests/request-join.test.ts.
   */
  request<A extends keyof M & string>(action: A, target: TargetOf<M, A>, payload?: PayloadOf<M, A>, options?: { timeout?: number; signal?: AbortSignal }): Promise<CommandResult<ResultOf<M, A>>>;
  respond(action: string, handler: (cmd: Command) => any | Promise<any>): () => void;
  /** Returns true if a handler is registered for the given action. */
  hasHandler(action: string): boolean;
  /** Returns all registered action names. */
  registeredActions(): string[];
  /**
   * @internal Used by the undo ledger to retrieve an undo handler registered alongside
   * a command handler. Do not call this from application code.
   */
  getUndoHandler(action: string): Handler | undefined;
  /** @internal The `canUndo` registered with an action's undo, for undo history. */
  getUndoCheck(action: string): ((cmd: Command) => boolean) | undefined;
  /** Remove all handlers, plugins, hooks, and listeners. Useful for testing and HMR. */
  clear(): void;
  /** Freeze configuration - rejects register/use/clear after sealing. */
  seal(): void;
  /** Returns true if the bus is sealed. */
  isSealed(): boolean;
  /**
   * Teardown - runs each plugin's dispose(), clears state and settles
   * pending request()s as core:aborted:dispatch. There is no disposed state: the bus stays usable.
   */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Internal state types
// ---------------------------------------------------------------------------

/** Max nested dispatch depth - prevents infinite loops from reactions/listeners re-dispatching. */
const MAX_DISPATCH_DEPTH = 16;



/**
 * @internal Symbol used by unsealBus() - not on the public interface.
 * Exported, underscored like `_stampMeta`, so createTestBus carries it too:
 * unsealBus() reopens a sealed TestBus as it reopens a real bus. No package
 * entry re-exports it.
 */
export const _UNSEAL = Symbol('vapor-chamber:unseal');

/**
 * @internal What a bus announces per command to its one observer slot:
 * `started` before the rules, `settled` after the after-hooks and
 * before the listeners, so a listener reads its command as settled. A query
 * (and a sync request's responder) starts with `queried`, which the command
 * state does not count, so a read never shows pending. An emit announces
 * nothing. A plain object, not a fast lane: a lane's one call site served the
 * start, the settle and the failure (polymorphic) behind a Map read per fact,
 * and a tracked dispatch read +16.8 ns slower than the before-hook and
 * `on('*')` it replaced (log 36.84). The slot holds the command state's
 * observer alone, or one that calls it and every plugin's `started` and
 * `settled` parts (`_composeFacts`). The observer catches its own throws: the
 * bus calls it bare. tests/command-state-lane.test.ts.
 */
export type Facts = {
  started(cmd: Command): void;
  queried(cmd: Command): void;
  settled(cmd: Command, result: CommandResult): void;
};

/**
 * @internal One action's facts, resolved on its first dispatch, query or
 * request and read once per command (plan 4.1): its handler, its rules, its
 * work steps, and on the async bus its transport and its `declared` options.
 * One literal, one hidden class. Cleared by every change of what it holds:
 * register, its cleanup, use, its removal, clear. Listeners stay out: a
 * subscription touches no record.
 * tests/action-record.test.ts.
 */
type ActionRecord = {
  readonly handler: ((cmd: Command) => any) | undefined;
  readonly rules: readonly Rule[] | null;
  readonly steps: readonly Step[] | null;
  readonly transport: Transport | undefined;
  readonly declared: RegisterOptions | undefined;
};

/**
 * @internal The test bus's setter of its facts observer. A real bus has none:
 * its observer is the `facts` slot of the state `_INSPECT` carries, so no bus
 * carries a setter (`_factsSetter`). commandState hands the observer over,
 * then hands null back on release.
 */
export const _FACTS = Symbol('vapor-chamber:facts');

/** @internal Symbol used by inspectBus() - not on the public interface. */
const _INSPECT = Symbol('vapor-chamber:inspect');

/** Guard: throw if the bus is sealed. */
function assertNotSealed(s: { sealed: boolean }, method: string): void {
  if (s.sealed) throw fail('refused:bus', `Cannot call ${method}() on a sealed bus.${DEV ? ' The bus was sealed with bus.seal() to prevent runtime mutations.' : ''}`, { context: { method } });
}

type SyncState = {
  readonly opts: CommandBusOptions;
  handlers: Map<string, Handler>;
  undoHandlers: Map<string, RegisterOptions>;
  /** `RegisterOptions.answer` per action: what a transport's answer is handed to. */
  answers: Map<string, (cmd: Command, value: unknown) => void>;
  /** The installed plugins, in install order: the bus places their parts. */
  plugins: PluginParts[];
  afterHooks: HookEntry<Hook>[];
  /** Exact-match listeners - O(1) lookup on the hot path. Action-keyed. */
  exactListeners: Map<string, ListenerEntry[]>;
  /** Wildcard listeners ('*' or 'foo*') - walked per dispatch with a precomputed prefix (WildcardEntry). */
  wildcardListeners: WildcardEntry[];
  responders: Map<string, (cmd: Command) => any | Promise<any>>;
  /** Each action's work steps (`_stepsOf`), null while no installed plugin declares one. */
  steps: Steps;
  /** Current nested dispatch depth - guards against infinite recursion. */
  dispatchDepth: number;
  /** When true, register/use/onAfter/respond throw. */
  sealed: boolean;
  /** One cancel per request() still waiting on its responder. dispose() runs them, so
   *  each settles at once as core:aborted:dispatch with its timer cleared, and polices nothing
   *  afterwards - no disposed state. Vue's EffectScope.stop() records one (active false)
   *  but polices nothing either: run() still runs (rc.11 reactivity).
   *  Lazily null until the first such request. */
  waiting: Set<() => void> | null;
  /** The one internal observer of each command's start and settle (`Facts`).
   *  Null while nothing listens, so the bare path stays bare. */
  facts: Facts | null;
  /** Each action's rules (`_rulesOf`), null while no installed plugin declares one. */
  rules: Rules;
  /** Each action's record (`recordOf`), read once per command past the bare path. */
  records: Map<string, ActionRecord>;
  /** Each action's live registration: the one its handler, undo and options are. */
  owners: Map<string, Registration>;
  /** The live registrations a newer one covers, per action, null until the first. */
  held: Map<string, Registration[]> | null;
};

type AsyncState = {
  readonly opts: CommandBusOptions;
  handlers: Map<string, AsyncHandler>;
  undoHandlers: Map<string, RegisterOptions>;
  /** `RegisterOptions.answer` per action: what a transport's answer is handed to. */
  answers: Map<string, (cmd: Command, value: unknown) => void>;
  /** The actions registered `optimistic` or `exclusive`, with their options: run apart. */
  declared: Map<string, RegisterOptions>;
  /** The keys `exclusive` holds on this bus, made by the first such command. */
  lanes: Lanes | null;
  /** The library's own actions an app names (a form's, history's trigger), by handler: no transport sends them. */
  locals: Map<string, unknown>;
  /** The installed plugins, in install order: the bus places their parts. */
  plugins: PluginParts[];
  afterHooks: HookEntry<AsyncHook>[];
  /** Exact-match listeners - O(1) lookup on the hot path. Action-keyed. */
  exactListeners: Map<string, ListenerEntry[]>;
  /** Wildcard listeners ('*' or 'foo*') - walked per dispatch with a precomputed prefix (WildcardEntry). */
  wildcardListeners: WildcardEntry[];
  responders: Map<string, (cmd: Command) => any | Promise<any>>;
  /** The work steps, as on the sync bus. */
  steps: Steps;
  /** Per-instance dedup map for in-flight async requests - avoids module-level singleton leak in SSR. */
  pendingRequests: Map<string, SharedRequest>;
  /** Current nested dispatch depth - guards against infinite recursion. */
  dispatchDepth: number;
  /** When true, register/use/onAfter/respond throw. */
  sealed: boolean;
  /** One cancel per request() still waiting on its responder. dispose() runs them, so
   *  each settles at once as core:aborted:dispatch with its timer cleared, and polices nothing
   *  afterwards - no disposed state. Vue's EffectScope.stop() records one (active false)
   *  but polices nothing either: run() still runs (rc.11 reactivity).
   *  Lazily null until the first such request. */
  waiting: Set<() => void> | null;
  /** The retry policy (budget, waits), or null when `retry: false`. */
  retry: Retrier | null;
  /** The bus's stores and their lane, where a reply's `stores` go (`_busStores`). */
  stores: BusStores;
  /** The declared transports by pattern, fixed at creation; empty without one. */
  readonly transports: ReadonlyArray<{ pattern: string; transport: Transport }>;
  /** The action's transport, resolved once per action; null on a bus with none. */
  readonly transportFor: ((action: string) => Transport | undefined) | null;
  /** The internal observer, as on the sync bus. */
  facts: Facts | null;
  /** The rules, as on the sync bus. */
  rules: Rules;
  /** The records, as on the sync bus. */
  records: Map<string, ActionRecord>;
  /** Each action's live registration: the one its handler, undo and options are. */
  owners: Map<string, Registration>;
  /** The live registrations a newer one covers, per action, null until the first. */
  held: Map<string, Registration[]> | null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Lightweight unique ID - counter + per-process random prefix.
 *
 * V8-aligned: monotonic counter + module-load random + module-load timestamp.
 * No `crypto.randomUUID()` syscall, no per-call `Date.now()`, no per-call
 * `Math.random()`. Measured on Node 24, 2026-08-17 (`hrtime` medians over 21x200k reps):
 * ~12ns per call vs ~104ns for `crypto.randomUUID()`, ~8x. Quote the runtime
 * with the number: modern V8/Node batch UUID entropy, so the margin moves.
 *
 * Command IDs are correlation tokens, not security tokens - uniqueness is
 * required across one process; cross-process collision risk is acceptable
 * for tracing/observability use cases. If you need cryptographically unique
 * IDs (cross-process auditing, distributed tracing IDs), call
 * `configureUid(crypto.randomUUID.bind(crypto))` at app setup.
 */
const _uidPrefix = (
  Date.now().toString(36) + '-' +
  ((Math.random() * 0xffffffff) >>> 0).toString(36)
);
let _uidCounter = 0;
// Named, so `_resetUid` can put it back. Joining the `-` once at load was
// measured: no difference on four workloads, +3 to +6 brotli (log s35.213).
const DEFAULT_UID = (): string => _uidPrefix + '-' + (++_uidCounter).toString(36);
let _uidFn: () => string = DEFAULT_UID;

// Held as a binding, not called literally, so `configureClock` can swap it.
//
// Whatever occupies this slot READS THE GLOBAL on every call rather than being
// `Date.now` itself - true of the cached default below, and the rule any
// replacement must follow. Assigning the function reference captures
// the intrinsic at module load, so test doubles that replace the global
// (`vi.useFakeTimers`, `vi.setSystemTime`) never reach it, and `meta.ts` silently
// keeps reporting real time. That was the first version of this code and
// `tests/clock-source-contained.test.ts` caught it: the indirection added to
// make the clock swappable had itself broken the fake-timer behaviour the
// default exists to preserve. The wrapper costs one call; correctness of the
// default is not negotiable against that.
//
// It is a named constant, and `configureClock()` restores it, because the
// obvious way to "put it back" - `configureClock(Date.now)` - is the same trap
// wearing a different hat. That footgun was hit twice while writing this, once
// in the implementation and once in the test's own teardown, which is two more
// times than a comment would have prevented.
// The DEFAULT: one real clock read per microtask turn, reused by every command
// dispatched inside that turn.
//
// Note the refresh is EAGER - the clock is read on the first call of each turn,
// not scheduled for later. A lazy version (return the old value, queue a
// refresh) would hand the first dispatch after an idle period a timestamp from
// whenever the module loaded, which is arbitrarily stale. Reading first and
// only then arming the reset means the first command of every turn carries an
// EXACT timestamp, and only the 2nd..nth command of the same synchronous run
// shares it.
//
// Lost beyond what `CommandMeta.ts` already records: tracking of
// `vi.setSystemTime` for the 2nd..nth command in a turn.
//
// What `ts` is and is not - a wall clock, not an ordering key, not a duration
// source - and what the cache gives up, are on `CommandMeta.ts`, with the
// measurement. If an exact wall clock is ever genuinely needed, the cheap door
// is a `clock?: () => number` bus option - one branch, no build step, and
// addable later without breaking anyone.

// A boolean rather than a `0` sentinel. `_clockNow === 0` meaning "re-read me"
// reads as safe - `Date.now()` cannot return 0, that is 1970 - but it is only
// true in production: under a test clock pinned to the epoch
// (`vi.useFakeTimers({ now: 0 })`) the cache silently never engages, and a
// benchmark would measure the uncached path while believing otherwise.
let _clockNow = 0;
let _clockStale = true;
const CACHED_CLOCK = (): number => {
  if (_clockStale) {
    _clockNow = Date.now();
    _clockStale = false;
    queueMicrotask(() => { _clockStale = true; });
  }
  return _clockNow;
};

let _clockFn: () => number = CACHED_CLOCK;
function uid(): string { return _uidFn(); }

/**
 * Swap the unique-ID generator. Call once at app setup if you need a different
 * format (e.g. `crypto.randomUUID` for distributed tracing).
 *
 * @example
 * import { configureUid } from 'vapor-chamber';
 * configureUid(() => crypto.randomUUID());
 */
export function configureUid(fn: () => string): void { _uidFn = fn; }

/**
 * Put the default id generator back after `configureUid`.
 *
 * @internal - NOT public API, not exported from the barrel, like
 * `_configureClock`. It exists so tests/perf.bench.ts times the library's
 * default after a group that swapped it, not a copy of it.
 */
export function _resetUid(): void { _uidFn = DEFAULT_UID; }

/**
 * Swap the clock `stampMeta` reads. `_configureClock()` with no argument
 * restores the cached default.
 *
 * @internal - NOT public API, not exported from the barrel, no semver promise.
 * It exists so `tests/clock-source-ab.test.ts` can A/B the two clock sources
 * through the real dispatch path, and so
 * `tests/clock-source-contained.test.ts` can drive a deliberately frozen clock
 * to prove no TTL depends on this. Underscored for the same reason
 * `_stampMeta` is.
 *
 * There is deliberately no consumer-facing option. An option only earns its
 * place when both settings are right for different people; here the cached
 * clock is what essentially everyone wants, and the rare need for exact
 * per-command wall-clock is served by reading the clock yourself - see the
 * note on `CommandMeta.ts`.
 */
export function _configureClock(fn?: () => number): void { _clockFn = fn ?? CACHED_CLOCK; }

// V8 optimization: monomorphic result factories - always same hidden class
function okResult(value: any): CommandResult { return { ok: true, value, error: undefined }; }
function errResult(error: Error): CommandResult { return { ok: false, value: undefined, error }; }

/** The sync and async buses share these two failures' wording. */
function maxDepthResult(action: string): CommandResult {
  return errResult(fail('exceeded:depth', `Maximum dispatch depth (${MAX_DISPATCH_DEPTH}) exceeded for "${action}".${DEV ? ' This usually means a listener or reaction is re-dispatching in an infinite loop.' : ''}`, { action, context: { depth: MAX_DISPATCH_DEPTH } }));
}

function requestTimeoutResult(action: string, timeout: number): CommandResult {
  return errResult(fail('timeout:request', `Request "${action}" timed out after ${timeout}ms.${DEV ? ' Increase timeout or check if a respond() handler is registered.' : ''}`, { action, context: { timeout } }));
}

/**
 * request()'s timeout, on both buses: a NaN is the default 5000 ms and one past
 * MAX_TIMEOUT_MS the maximum, since a timer fires at once on either. `null`
 * is the default too. tests/nan-options.test.ts.
 */
const requestTimeout = (t: number | undefined) => delayOption(t ?? 5000, 5000);

/**
 * Singleton "successful empty" result used by `bus.emit()`. emit is fire-and-
 * forget - no value is computed, the result is constant. Reusing one frozen
 * object eliminates a per-emit `okResult(undefined)` allocation. Listeners
 * receive this as the second arg; mutation attempts will throw in strict
 * mode (the freeze is intentional, not accidental).
 */
const EMIT_RESULT: CommandResult = Object.freeze({ ok: true, value: undefined, error: undefined }) as CommandResult;

// V8 optimization: extract try/catch into separate function so callers stay optimizable
function tryCatchHandler(handler: Handler, cmd: Command): CommandResult {
  try { return okResult(handler(cmd)); }
  catch (e) { return errResult(e as Error); }
}
// Not async: a handler that returns a value answers at once, with no frame and
// no await (tests/async-sync-handler.test.ts). A thenable is settled apart.
function tryCatchAsyncHandler(handler: AsyncHandler, cmd: Command): CommandResult | Promise<CommandResult> {
  let r: unknown;
  try { r = handler(cmd); }
  catch (e) { return ownAbort(e, cmd) ?? errResult(e as Error); }
  return r && typeof (r as PromiseLike<unknown>).then === 'function' ? asyncHandlerSettled(r as PromiseLike<unknown>, cmd) : okResult(r);
}
async function asyncHandlerSettled(p: PromiseLike<unknown>, cmd: Command): Promise<CommandResult> {
  try { return okResult(await p); }
  catch (e) { return ownAbort(e, cmd) ?? errResult(e as Error); }
}

/**
 * A throw that IS the dispatch's own signal's reason is that abort, reported
 * as an abort before start is (`abortedResult`). The DOM tells this abort
 * from any other by the reason's identity (`throwIfAborted`, Fetch's
 * rejection). Failure path only.
 */
function ownAbort(e: unknown, cmd: Command): CommandResult | undefined {
  const signal = cmd.signal;
  return signal?.aborted && e === signal.reason ? abortedResult(cmd.action, signal) : undefined;
}

/**
 * One-shot origin slot - consumed by the NEXT `stampMeta` call.
 *
 * Why a module slot is safe here when it was the original bug everywhere else:
 * the four flags `stampMeta`'s docblock indicts (`_mcpDispatching`, `receiving`,
 * `paused`, the reaction guard) all had to survive until a dispatch SETTLED,
 * which on an async bus means past a microtask - so `finally` cleared them
 * early. This slot only has to survive into `stampMeta`, which every dispatch
 * variant calls in its SYNCHRONOUS prologue while building `cmd`, before any
 * await exists. It cannot span a microtask by construction.
 *
 * It exists because `__origin`-in-the-payload can only mark payloads that hold
 * keys. A number, string, boolean or array cannot carry it, so those dispatches
 * reached handlers unattributed - an infinite cross-tab broadcast loop in
 * createChannel(), a double-recorded redo in chamber(), and an MCP command invisible to
 * an `origin === 'agent'` audit filter. Each site had grown its own workaround
 * (a depth counter, a one-shot identity match, a boundary refusal); this
 * replaces all three with one mechanism that works for every payload shape and
 * leaves the payload itself untouched.
 */
let _nextOrigin: string | undefined;

/**
 * One-shot causation slot - same mechanism, same synchronous-prologue safety
 * argument as `_nextOrigin` above, for the other `__`-key that cannot mark
 * every payload shape.
 *
 * `__causationId` in the payload has exactly the limitation that moved
 * `__origin` off it: a number, string, boolean or array has nowhere to put the
 * key, so a dispatch carrying one arrives with no causation and any consumer
 * counting a chain from it starts over at zero. `createReaction`'s `maxHops`
 * cap was doing precisely that - measured, an indirect cycle whose `mapPayload`
 * returns a scalar ran to `MAX_DISPATCH_DEPTH` on a sync bus and is unbounded on
 * an async one, which is the failure `ReactionOptions.allowSelfMatch` documents
 * as the reason the guard exists.
 */
let _nextCausation: string | undefined;

/**
 * Scoped origin - every dispatch made synchronously inside `_withOriginScope`
 * carries it, where `_withOrigin` marks only the next one. History's undo and
 * redo need the scope: an undo handler that dispatches two compensations, or
 * a redone handler that dispatches a child, are rollback steps and none of
 * them may be recorded. The one-shot slot stays one-shot on purpose (a nested
 * dispatch must not inherit 'sync' and lose its own broadcast); a rollback
 * window is the case where inheriting IS the point. The read sits in
 * stampMeta, so it holds on the async bus too - a recorder there runs at
 * settle, after a flag would have been cleared, which is how the history
 * plugin recorded an undo handler's compensations on the async bus and wiped
 * the redo stack. The flag's old limit remains: a dispatch an ASYNC undo
 * handler makes after an await is outside the window. Measured on the
 * dispatch hot path: tests/origin-scope-ab.test.ts.
 */
let _originScope: string | undefined;

/** Internal - `origin` on every dispatch `fn` makes synchronously; nests, restores on exit. */
export function _withOriginScope<T>(origin: string, fn: () => T): T {
  const outer = _originScope;
  _originScope = origin;
  try { return fn(); } finally { _originScope = outer; }
}

/**
 * Internal - stamp `origin` on the meta of the FIRST dispatch `fn` makes
 * synchronously. Not public API; underscored like `_stampMeta`.
 *
 * The `finally` is leak protection, not a settlement guard: `validateNaming`
 * can throw before `stampMeta` runs, and an unconsumed slot must not bleed into
 * whatever dispatches next. Awaiting the result of `fn()` is fine - the slot is
 * already consumed by then.
 */
export function _withOrigin<T>(origin: string, fn: () => T): T {
  _nextOrigin = origin;
  try {
    return fn();
  } finally {
    _nextOrigin = undefined;
  }
}

export { _isLibraryAction, _asLibrary };

/** @internal Reverse `cmd` through its `<action>$undo` command: origin 'undo', caused by `cmd`. */
export function _undo(bus: { dispatch(action: string, target: any): any }, cmd: Command): any {
  return _withOriginScope('undo', () => _withCausation(cmd.meta?.id, () => bus.dispatch(cmd.action + '$undo', cmd)));
}

/**
 * Internal - stamp `causationId` on the meta of the FIRST dispatch `fn` makes
 * synchronously, for callers whose payload cannot carry `__causationId`.
 * Same contract and same `finally` reasoning as `_withOrigin`.
 */
export function _withCausation<T>(causationId: string | undefined, fn: () => T): T {
  _nextCausation = causationId;
  try {
    return fn();
  } finally {
    _nextCausation = undefined;
  }
}

/**
 * Stamp a command with auto-generated metadata.
 *
 * The `__`-prefixed payload keys are the established convention for
 * per-dispatch meta without a signature change: they travel **with** the
 * dispatch rather than beside it.
 *
 * `__origin` was added for a family of four bugs that all shared one shape -
 * a module-level flag set before a dispatch and cleared in `finally`
 * (`_mcpDispatching` in mcp.ts, `receiving` in createChannel(), `paused` in redo(),
 * and the reaction guard). On a sync bus the dispatch completes inside the
 * `try`, so the flag holds and the tests pass. On an **async** bus the
 * dispatch returns a pending promise, its work runs a microtask later,
 * and `finally` has already fired - so the flag was cleared before the thing
 * it was guarding happened. The failure modes ranged from misattributed audit
 * origins to an infinite cross-tab broadcast loop. A marker on the dispatch is
 * race-free by construction, and one fix site serves all of them.
 */
function stampMeta(payload: any): CommandMeta {
  // Read __causationId once - it is both `causationId` and `correlationId`'s fallback.
  // V8 does not CSE the repeated optional-chain read (measured ~5-9% for v1.18.0 on an isolated A/B with
  // the common no-ids payload; end-to-end it's within noise, dwarfed by uid()/Date.now()).
  // Behavior-identical; reading once also avoids a double getter invocation on exotic payloads.
  // `origin` is always present (undefined when unset) rather than conditionally
  // added - one field set, one hidden class, monomorphic dispatch preserved.
  // Read-and-clear, branchless: both slots are consumed unconditionally (a
  // store of undefined over undefined in the common case) and each `??` falls
  // back to the documented public payload key. The obvious
  // `if (_nextOrigin !== undefined)` form costs more bytes for no measurable
  // speed - and this bundle's budget is a ratchet that gets argued down before
  // it gets raised.
  //
  // The two clears are deliberately NOT folded into one chained assignment
  // (`_nextOrigin = _nextCausation = undefined`). That reads as the cheaper
  // shape and measured one byte WORSE on the tree-shake bundle - 6564 vs 6563 in v1.19.0 -
  // because brotli is not linear in source length. Measured, then reverted;
  // recorded so nobody re-derives it hoping for a saving.
  const cause = _nextCausation;
  _nextCausation = undefined; // one-shot
  const causationId = cause ?? payload?.__causationId;
  const correlationId = payload?.__correlationId ?? causationId;
  const slot = _nextOrigin;
  _nextOrigin = undefined; // one-shot
  // The scope slot reads between the one-shot and the payload key: a dispatch
  // marked one-shot inside a scope keeps its own origin.
  // `idempotencyKey` is always present (undefined until a plugin, the outbox
  // or the retry stamps it), so stamping it fills a slot rather than adding a
  // property: one meta map whether a command is keyed or not
  // (tests/v8-shapes.test.ts; V8 rule 2).
  return { ts: _clockFn(), id: uid(), correlationId, causationId, origin: slot ?? _originScope ?? payload?.__origin, idempotencyKey: undefined, response: undefined, request: undefined };
}

/**
 * Internal - exported for `testing.ts` so the TestBus stamps the same meta the
 * real buses do. Underscored: not public API, not in the docs, may change.
 * Duplicating the `__`-key convention in the double is exactly how the double
 * drifts from the thing it doubles.
 */
export { stampMeta as _stampMeta };

/**
 * Internal - the two result factories, for modules that build a
 * `CommandResult` outside the bus (transports, composables, plugins). A
 * hand-written `{ ok: false, error }` literal has a different hidden class from
 * `errResult`'s three-field one, so every `result.ok` site that sees both goes
 * polymorphic; tests/v8-shapes.test.ts pins the shared map. The root barrel
 * makes the two public as `ok` / `err` for app plugins (index.ts,
 * tests/plugin-result-factories.test.ts); these underscored names stay the
 * library's own spelling.
 */
export { okResult as _okResult, errResult as _errResult, tryCatchHandler as _tryCatchHandler };
export { declaredTransports as _declaredTransports, attachTransports as _attachTransports, send as _send, assertPlugin as _assertPlugin };

/**
 * register(): a `$` name is the library's, so an app's is refused whatever its
 * naming rule (log s35.117). Whether the library is registering is this
 * copy's module state: a store or history from a second copy of the package
 * lands here too, hence the second hint. tests/library-names.test.ts.
 */
function refuseLibraryName(action: string): void {
  if (_isLibraryAction(action) && !_isLibraryRegister()) {
    throw fail('invalid:name', `Action "${action}": a name with "$" is the library's.${DEV ? ' Rename the action. If the app did not name it, two copies of vapor-chamber are loaded: a bundle that marks `vapor-chamber` external must mark `vapor-chamber/*` too.' : ''}`, { context: { action } });
  }
}

function validateNaming(action: string, naming?: NamingConvention): void {
  // A `$` name is the library's and passes any rule (register refuses an app's).
  if (!naming || naming.pattern.test(action) || _isLibraryAction(action)) return;
  const msg = `Action "${action}" does not match naming pattern ${naming.pattern}.${DEV ? ' Rename the action to match or adjust the naming option in createCommandBus({ naming: { pattern } }).' : ''}`;
  const mode = naming.onViolation ?? 'warn';
  if (mode === 'throw') throw fail('invalid:name', msg, { context: { action, pattern: String(naming.pattern) } });
  if (mode === 'warn') _report('warn', 'core:invalid:name', msg, undefined, { action });
}

/**
 * WildcardEntry - a subscribed wildcard listener, with its match test already
 * reduced to data.
 *
 * `pattern` is retained verbatim because `offAll(pattern)` and `inspectBus()`
 * both report on it; `prefix` is what the dispatch path actually reads. It is
 * `pattern.slice(0, -1)`, which is correct for BOTH wildcard shapes with no
 * special case: `'cart*'` -> `'cart'`, and `'*'` -> `''`, where
 * `action.startsWith('')` is unconditionally true. So the fan-out loop is one
 * `startsWith` per listener with no branch, no `charCodeAt`, and no cache
 * lookup.
 *
 * WHY IT LIVES ON THE ENTRY rather than in `matchesPattern`'s cache. `on()`
 * has already classified the pattern as a wildcard to decide which bucket it
 * goes in, so by the time the entry exists the parse is a known result being
 * thrown away. Storing it is the same move Vue made in 3.6.0-rc.6's `29ed4b0`
 * (`parseAdoptTarget`): hoist a per-call string scan into a descriptor computed
 * once by the factory, then compare cheap values on the hot path.
 * `matchesPattern` keeps its cache - it is public API taking arbitrary
 * caller-supplied patterns (plugin `actions:` filters), where
 * nothing has classified anything in advance.
 *
 * Measured, real dispatch path, interleaved A/B - see
 * `tests/wildcard-prefix-ab.test.ts`.
 */
type WildcardEntry = { pattern: string; prefix: string; listener: Listener; off: boolean };

/**
 * An exact-match listener: the same shape as a WildcardEntry (one hidden
 * class for both loops), its `prefix` unused. `off` is set when it is
 * unsubscribed, so a dispatch already walking it skips it.
 */
type ListenerEntry = WildcardEntry;

/**
 * A before- or after-hook: one shape for both lists. `off` is set when it is
 * unsubscribed, so a dispatch already walking it skips it, as a listener's.
 */
type HookEntry<H> = { fn: H; off: boolean };

/**
 * Walk listener buckets for an action. Exact-match bucket is O(1) lookup;
 * wildcard bucket is walked with one `startsWith` against each entry's
 * precomputed prefix (WildcardEntry).
 *
 * A dispatch calls the listeners that existed when it started, the rule
 * DOM's EventTarget uses: one removed during it (by itself or a peer) does
 * not run, one added during it runs from the next dispatch. Unsubscribing
 * marks the entry `off` and REPLACES the array (see on()); it never splices
 * the one a loop is walking, and the loop's bound is the length it started
 * with. So nothing a listener does can move the cursor. The length-based
 * cursor correction this replaced skipped the next listener when one removed
 * an earlier peer and added one in the same call, and re-ran the previous one
 * when one removed itself and a later peer (log s35.67).
 */
function fanOutListeners(
  exact: Map<string, ListenerEntry[]>,
  wild: WildcardEntry[],
  action: string,
  cmd: Command,
  result: CommandResult,
): void {
  const ex = exact.get(action);
  if (ex !== undefined) {
    for (let i = 0, n = ex.length; i < n; i++) {
      const entry = ex[i];
      if (entry.off) continue;
      try { entry.listener(cmd, result); } catch (e) { _report('error', 'core:failed:listener', `a listener threw on "${action}"`, e, { action }); }
    }
  }
  for (let i = 0, n = wild.length; i < n; i++) {
    const entry = wild[i];
    // `entry.prefix` is `pattern.slice(0, -1)`, computed ONCE in `on()` - see
    // WildcardEntry. `'*'` slices to `''` and `''.startsWith` is always true,
    // so match-all needs no branch of its own and this loop is a single
    // `startsWith` per listener. `matchesPattern` (public API, arbitrary
    // caller-supplied patterns) still re-derives the prefix through its cache;
    // only this loop knows the pattern was classified at subscribe time.
    if (!entry.off && action.startsWith(entry.prefix)) {
      try { entry.listener(cmd, result); } catch (e) { _report('error', 'core:failed:listener', `a listener threw on "${action}"`, e, { action }); }
    }
  }
}

/**
 * Run every collected disposer in insertion order, then empty the list so a
 * second call is a no-op (idempotent teardown). Shared by the composables'
 * `dispose()` and the chamber/install + history-plugin cleanups. Cold path
 * (runs at unmount/disposal, never per dispatch) - a plain loop, no closure.
 *
 * No try/catch by design - settled, do not "harden". Every disposer collected
 * here is an internal `register`/`on`/`use`/`respond` unsub (`Map.delete` /
 * `Array.splice`); none can throw. A throw would mean corrupted internal state,
 * which should surface loudly during teardown, not be swallowed.
 */
export function disposeAll(fns: Array<() => void>): void {
  for (let i = 0; i < fns.length; i++) fns[i]();
  fns.length = 0;
}

/** commandKey's text for a value RFC 8785 refuses: tagged, so it never meets a JSON value's text. */
const outsideKey = (v: number | bigint): unknown => (typeof v === 'bigint' ? { '\u0000bigint': String(v) } : { '\u0000number': String(v) });
/** commandKey's writer for an object target, built once (./canonical keyTextFor). */
const targetKeyText = /* @__PURE__ */ keyTextFor(outsideKey);

/** Per-object ids for targets JSON cannot serialize (a cycle, a function). */
const _identityKeys = new WeakMap<object, string>();
/** The same for a symbol `Symbol.for` did not make: the build targets refuse one as a WeakMap key (log 36.41). */
const _symbolKeys = new Map<symbol, string>();
let _identitySeq = 0;

/** A target keyed by what it is, not by its JSON: one id per object or symbol, a registered symbol by its name. */
function identityKey(target: object | symbol): string {
  if (typeof target === 'symbol') {
    const name = Symbol.keyFor(target);
    if (name !== undefined) return `\u0000symbol:${name}`;
    let sid = _symbolKeys.get(target);
    if (sid === undefined) _symbolKeys.set(target, (sid = `\u0000ref#${++_identitySeq}`));
    return sid;
  }
  let id = _identityKeys.get(target);
  if (id === undefined) _identityKeys.set(target, (id = `\u0000ref#${++_identitySeq}`));
  return id;
}

/** The action names already warned about (development only). */
let _colonActions: Set<string> | undefined;
function warnColonAction(action: string): void {
  if (_isLibraryAction(action)) return;
  _colonActions ??= new Set();
  if (_colonActions.has(action)) return;
  _colonActions.add(action);
  _report('warn', 'core:invalid:name', `Action "${action}" holds ':', the separator of commandKey: ("a:b", "c") and ("a", "b:c") share a key, so idempotent, cache, serialize and supersede can collapse two different commands. Name actions without ':' (cartAdd, not cart:add).`, undefined, { action });
}

/**
 * Stable string key for a (action, target) pair. Handles circular refs safely.
 * Useful for cache invalidation integration (e.g. TanStack Query).
 *
 * A target keys by its value: a primitive by its String() (so `1` and `'1'`
 * share a key, by design - tests/isloading-keys.test.ts), an object by its
 * JSON with keys sorted (keyTextFor, ./canonical), a Number, String, Boolean
 * or BigInt object as its value. A target JSON cannot serialize no longer
 * shares one fallback string with every other: a BigInt, a NaN or an Infinity
 * inside it is tagged, and a circular, function or symbol target keys by its
 * identity (tests/commandkey-collisions.test.ts).
 *
 * An action name holding `:` can share a key with another action -
 * ('a:b', 'c') and ('a', 'b:c') are both `a:b:c`. Escaping the name on every
 * call measured 25-30% of a primitive key (v1.30.0), so it is a naming rule
 * instead, decided once (docs/V8-RULES.md rule 3): warned in development and
 * folded out of production.
 */
export function commandKey(action: string, target: any): string {
  if (DEV && action.indexOf(':') !== -1) warnColonAction(action);
  // Fast path: primitives and null don't need serialization or key sorting.
  // Each test is `typeof target === '...'`, as in ./canonical keyTextFor.
  if (target === null || target === undefined) return `${action}:${target}`;
  if (typeof target === 'string' || typeof target === 'number' || typeof target === 'boolean' || typeof target === 'bigint') return `${action}:${target}`;
  // Object path: the runtime key text (./canonical keyTextFor), so { b:2, a:1 }
  // and { a:1, b:2 } share a key at every level, nested fields stay in full
  // and arrays keep their order. A value JSON cannot carry exactly gets this
  // key's own tag: a BigInt, and a NaN or Infinity, which JSON.stringify
  // wrote as `null` and so keyed with null (tests/commandkey-collisions.test.ts).
  let tkey: string | undefined;
  try {
    tkey = targetKeyText(target);
  } catch {
    // A cycle: JSON.stringify throws on it. String(target) was
    // '[object Object]' for every such target, so two different ones shared a
    // key; each now keys by its own identity, below.
  }
  // No text: a function, a symbol, or an object whose toJSON gave none. Each
  // keyed `act:undefined`, with undefined and with one another (log 36.41).
  if (tkey === undefined) tkey = identityKey(target);
  return `${action}:${tkey}`;
}

/**
 * The target half of `commandKey`, exactly: `commandKey(a, t) === a + ':' +
 * _targetKey(t)`. For `commandState`'s `pending`, whose slots are a map by action, then by
 * this, so a tracked dispatch builds no `action:target` string. A primitive's
 * String() is the conversion the template does; an object takes commandKey's
 * own serialization, so the two cannot drift (tests/isloading-keys.test.ts).
 */
export function _targetKey(target: any): string {
  if (target === null || target === undefined) return String(target);
  if (typeof target === 'string') return target;
  if (typeof target === 'number' || typeof target === 'boolean' || typeof target === 'bigint') return String(target);
  return commandKey('', target).slice(1);
}

// ---------------------------------------------------------------------------
// commandPool - circular buffer of pre-allocated Command objects (zero-GC)
// ---------------------------------------------------------------------------

/**
 * CommandPool - pre-allocates Command objects in a circular buffer to
 * eliminate garbage collection pauses during dispatch bursts. When the
 * pool is exhausted, it wraps around and reuses the oldest slot.
 *
 * **Important**: The pool is a standalone utility - `bus.dispatch()` still
 * creates its own Command internally and stamps `meta` (ts, id, correlationId).
 * Pooled commands do NOT have `meta` set. Use `pool.acquire()` for the action/target/payload,
 * then pass those values to `bus.dispatch(cmd.action, cmd.target, cmd.payload)`.
 * The bus will create its own internal command with proper metadata.
 *
 * @example
 * const pool = createCommandPool();
 * const cmd = pool.acquire('cartAdd', cart, { id: 1 });
 * bus.dispatch(cmd.action, cmd.target, cmd.payload); // bus stamps its own meta
 *
 * pool.stats(); // { size: 64, acquired: 1, cursor: 1 }
 * pool.reset(); // Reset cursor and clear all slots
 */
export interface CommandPool {
  /** Acquire a command object from the pool. Reuses slots in a circular fashion. */
  acquire(action: string, target: any, payload?: any): Command;
  /** Current pool statistics. */
  stats(): { size: number; acquired: number; cursor: number };
  /** Reset the pool - clears all slots and resets cursor. */
  reset(): void;
  /** Pool capacity. */
  readonly size: number;
}

export function createCommandPool(size: number = 64): CommandPool {
  if (size < 1) throw new RangeError('CommandPool size must be at least 1');

  // Pre-allocate monomorphic command objects - same hidden class for V8 TurboFan.
  // The pool writes its own commands; to everyone else a command is readonly.
  const buffer: { -readonly [K in keyof Command]: Command[K] }[] = new Array(size);
  for (let i = 0; i < size; i++) {
    buffer[i] = { action: '', target: undefined, payload: undefined, meta: undefined, signal: undefined };
  }

  let cursor = 0;
  let totalAcquired = 0;

  function acquire(action: string, target: any, payload?: any): Command {
    const cmd = buffer[cursor];
    cmd.action = action;
    cmd.target = target;
    cmd.payload = payload;
    cmd.meta = undefined; // pooled commands carry no meta - dispatch stamps its own
    cursor = (cursor + 1) % size;
    totalAcquired++;
    return cmd;
  }

  function stats() {
    return { size, acquired: totalAcquired, cursor };
  }

  function reset() {
    cursor = 0;
    totalAcquired = 0;
    for (let i = 0; i < size; i++) {
      buffer[i].action = '';
      buffer[i].target = undefined;
      buffer[i].payload = undefined;
      buffer[i].meta = undefined;
    }
  }

  return { acquire, stats, reset, size };
}

// ---------------------------------------------------------------------------
// Per-action resolution
// ---------------------------------------------------------------------------

// The bound of every per-action cache: the rules, the steps, a filter's answers.
const CHAINS_MAX = 512;
/** @internal The one reader of a declared scope: `actions` (an ActionScope) and `actionFilter`, ANDed. The outbox's too. */
export function _inScope(declared: { readonly actions?: Readonly<ActionScope>; readonly actionFilter?: ActionFilter }, action: string): boolean {
  const a = declared.actions;
  const f = declared.actionFilter;
  return (!a?.length || a.some((p) => matchesPattern(p, action))) && (!f || f(action));
}
/**
 * @internal `declared`'s scope as a predicate of the action, or null when it
 * declares none, so an unscoped reader pays one null check. The scope of
 * `logger`, `history`, `useCommandHistory` and `useCommandError`, and of a
 * `settled` part. `actions` are classified once, here, into exact names and
 * prefixes by `_patternPrefix`, so a command costs a few comparisons and no lookup:
 * a per-action Map cost a scoped history record +19.5 ns (V8-RULES 3).
 * `actionFilter` is called as it is. tests/scope-options.test.ts.
 */
export function _scoped(declared: { readonly actions?: Readonly<ActionScope>; readonly actionFilter?: ActionFilter }): ((action: string) => boolean) | null {
  const f = declared.actionFilter;
  if (!declared.actions?.length) return f ?? null;
  const names: string[] = [];
  const prefixes: string[] = [];
  let all = false;
  for (const p of declared.actions) {
    const prefix = _patternPrefix(p);
    if (prefix === '') all = true;
    else if (prefix !== undefined) prefixes.push(prefix);
    else names.push(p);
  }
  return (action) => {
    if (!all) {
      let hit = false;
      for (let i = 0; i < names.length && !hit; i++) hit = names[i] === action;
      for (let i = 0; i < prefixes.length && !hit; i++) hit = action.startsWith(prefixes[i]);
      if (!hit) return false;
    }
    return f === undefined || f(action);
  };
}

// ---------------------------------------------------------------------------
// Module-level sync bus operations (state threaded explicitly)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Shared helpers for both sync and async buses
// ---------------------------------------------------------------------------

/** One plugin's `started` or `settled` part as the bus places it: the part, its plugin and its scope. */
type Observing = { readonly fn: (cmd: Command, result: CommandResult) => void; readonly plugin: PluginParts; readonly inside: ((action: string) => boolean) | null };

/** A part's throw: logged with its plugin's id, and the command goes on, as a listener's. */
function partThrew(o: Observing, part: string, cmd: Command, e: unknown): void {
  _report('error', `${o.plugin.id ?? 'plugin'}:failed:plugin`, `its ${part} part threw on "${cmd.action}"`, e, { action: cmd.action, plugin: o.plugin.id, part, parts: _partsOf(o.plugin) });
}

/**
 * A scope with an `actionFilter`, its answer kept per action: the filter is
 * asked once per action, as `PluginParts.actionFilter` says, never per
 * dispatch (tests/action-filter.test.ts). Capped like the rules.
 */
function oncePerAction(inside: (action: string) => boolean): (action: string) => boolean {
  const known = new Map<string, boolean>();
  return (action) => {
    let v = known.get(action);
    if (v === undefined) {
      v = inside(action);
      if (known.size >= CHAINS_MAX) known.clear();
      known.set(action, v);
    }
    return v;
  };
}

/** Calls one part of each plugin in `list`, inside its scope and its own try. */
function each(list: readonly Observing[], part: 'started' | 'settled', cmd: Command, result?: CommandResult): void {
  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    try { if (o.inside === null || o.inside(cmd.action)) o.fn.call(o.plugin, cmd, result as CommandResult); }
    catch (e) { partThrew(o, part, cmd, e); }
  }
}

/**
 * @internal The bus's facts slot, from the command state's observer (`own`)
 * and every installed plugin's `started` and `settled` parts. Nothing
 * observes: null, so a bare bus stays bare. The command state alone: its own
 * observer, unwrapped, so a tracked dispatch runs the code it ran before parts
 * existed. Anything more: one observer calling the command state first, then
 * each part in install order, inside its scope and its own try. Built at
 * `use()` and when a command state attaches, never per dispatch. The test
 * bus's too. tests/plugin-started-part.test.ts.
 */
export function _composeFacts(own: Facts | null, plugins: readonly PluginParts[]): Facts | null {
  const starts: Observing[] = [];
  const settles: Observing[] = [];
  for (const p of plugins) {
    if (p.started === undefined && p.settled === undefined) continue;
    const inside = p.actionFilter === undefined ? _scoped(p) : oncePerAction(_scoped(p)!);
    if (p.started !== undefined) starts.push({ fn: p.started, plugin: p, inside });
    if (p.settled !== undefined) settles.push({ fn: p.settled, plugin: p, inside });
  }
  if (starts.length === 0 && settles.length === 0) return own;
  return {
    started(cmd) {
      if (own !== null) own.started(cmd);
      each(starts, 'started', cmd);
    },
    queried(cmd) {
      each(starts, 'started', cmd);
    },
    settled(cmd, result) {
      if (own !== null) own.settled(cmd, result);
      each(settles, 'settled', cmd, result);
    },
  };
}

/** The command state's observer of each real bus, kept beside its state for `_composeFacts`. */
const _ownFacts = new WeakMap<object, Facts | null>();

/** Rebuild a real bus's facts slot from its command state's observer and its plugins. */
function recompose(s: SyncState | AsyncState): void {
  s.facts = _composeFacts(_ownFacts.get(s) ?? null, s.plugins);
}

/** One rule of an action: its check and its plugin's `fail`. */
type Rule = { readonly check: Refusal; readonly fail: Fail; readonly part: 'authorize' | 'validate' };
/** @internal Each action's rules, resolved once per action; null while no installed plugin declares one. */
export type Rules = ((action: string) => readonly Rule[] | null) | null;

/**
 * @internal The rules of each action, read from the installed plugins' parts:
 * every `authorize` rule, then every `validate` rule (authorization answers
 * before validation, plan-transport-owned.md revision 17), each kind in
 * install order, on the actions each part's scope covers (`_inScope`). A
 * part is asked once per action, and an action with none caches null. The
 * test bus's too. tests/rule-scope.test.ts.
 */
export function _rulesOf(plugins: readonly PluginParts[]): Rules {
  const parts: PluginParts[] = [];
  for (const p of plugins) {
    if (p.authorize !== undefined || p.validate !== undefined) parts.push(p);
  }
  if (parts.length === 0) return null;
  const fails = parts.map((p) => _failures(p.id ?? 'plugin'));
  const known = new Map<string, readonly Rule[] | null>();
  const resolve = (action: string): readonly Rule[] | null => {
    const list: Rule[] = [];
    const inside = parts.map((p) => _inScope(p, action));
    for (let i = 0; i < parts.length; i++) { const check = inside[i] ? parts[i].authorize?.(action) : undefined; if (check) list.push({ check, fail: fails[i], part: 'authorize' }); }
    for (let i = 0; i < parts.length; i++) { const check = inside[i] ? parts[i].validate?.(action) : undefined; if (check) list.push({ check, fail: fails[i], part: 'validate' }); }
    const value = list.length === 0 ? null : list;
    if (known.size >= CHAINS_MAX) known.clear();
    known.set(action, value);
    return value;
  };
  return (action) => {
    const value = known.get(action);
    return value === undefined ? resolve(action) : value;
  };
}

/**
 * @internal Runs an action's rules in order: the first refusal answers, and
 * undefined lets the command through. A rule's throw or rejection is its
 * plugin's `failed:plugin`. A promise only when a
 * rule returns one. The test bus's too. tests/rules-before-the-work.test.ts.
 */
export function _refusal(rules: readonly Rule[], cmd: Command, from = 0): CommandResult | Promise<CommandResult | undefined> | undefined {
  for (let i = from; i < rules.length; i++) {
    const rule = rules[i];
    let r: CommandResult | Promise<CommandResult | undefined> | undefined;
    try { r = rule.check(cmd, rule.fail); }
    catch (e) { return ruleThrew(e, cmd, rule.fail, rule.part); }
    if (r === undefined) continue;
    if (typeof (r as PromiseLike<unknown>).then === 'function') {
      return (r as Promise<CommandResult | undefined>).then((v) => v ?? _refusal(rules, cmd, i + 1), (e: unknown) => ruleThrew(e, cmd, rule.fail, rule.part));
    }
    return r;
  }
  return undefined;
}

/** A rule's or a step's throw: its plugin's `failed:plugin`, the caller's abort excepted. Failure path only. */
function ruleThrew(e: unknown, cmd: Command, fail: Fail, part: string): CommandResult {
  // The caller's cancel, rethrown by a part, is not a plugin bug.
  const aborted = ownAbort(e, cmd);
  if (aborted) return aborted;
  const error = fail('failed:plugin', `Plugin threw in its ${part} part on "${cmd.action}".`, { action: cmd.action, context: { part }, cause: e });
  // Logged in development, so the conversion to a result never hides the bug.
  if (DEV) _report('error', error.code, `a ${part} part threw on "${cmd.action}", and the dispatch answers with this code. Return an errResult instead of throwing.`, e, { action: cmd.action, part });
  return errResult(error);
}

/** One plugin's work steps for an action, with its `fail`. */
type Step = { readonly plugin: PluginParts; readonly fail: Fail };
/** @internal Each action's steps, resolved once per action; null while no installed plugin declares one. */
export type Steps = ((action: string) => readonly Step[] | null) | null;

/**
 * @internal The work's steps of each action, read from the installed
 * plugins' `reuse`, `admit` and `begin` parts, in install order, each plugin
 * inside its scope. Resolved once per action; an action with none caches
 * null. The test bus's too.
 */
export function _stepsOf(plugins: readonly PluginParts[]): Steps {
  const parts: Step[] = [];
  for (const p of plugins) {
    if (p.reuse !== undefined || p.admit !== undefined || p.begin !== undefined) parts.push({ plugin: p, fail: _failures(p.id ?? 'plugin') });
  }
  if (parts.length === 0) return null;
  const known = new Map<string, readonly Step[] | null>();
  return (action) => {
    let value = known.get(action);
    if (value === undefined) {
      const list = parts.filter((s) => _inScope(s.plugin, action));
      value = list.length === 0 ? null : list;
      if (known.size >= CHAINS_MAX) known.clear();
      known.set(action, value);
    }
    return value;
  };
}

/** A promise a step answered, its rejection its plugin's `failed:plugin`. */
function guarded(r: CommandResult | Promise<CommandResult>, cmd: Command, fail: Fail): CommandResult | Promise<CommandResult> {
  return typeof (r as PromiseLike<unknown>).then === 'function' ? (r as Promise<CommandResult>).then(undefined, (e: unknown) => ruleThrew(e, cmd, fail, 'reuse')) : r;
}

/** Each ticket's `landed`, with the work's final result. */
function land(tickets: readonly WorkTicket[], result: CommandResult): CommandResult {
  for (let i = 0; i < tickets.length; i++) tickets[i].landed?.(result);
  return result;
}

/**
 * @internal The work behind its steps: every `reuse` (the first answer is
 * the command's), every `admit` (the first refusal is), every `begin`, then
 * the work (`run`, the retry and the work below it), then each ticket's
 * `landed`. A ticket's `signal` becomes the work's, combined when several
 * give one; a ticket's `answer` is the caller's in place of the work's. A
 * step's throw is its plugin's `failed:plugin`, and the tickets taken before
 * it land with that failure. Synchronous while every step and the work are.
 * The test bus's too. tests/work-steps.test.ts.
 */
export function _stepped<R extends CommandResult | Promise<CommandResult>>(steps: readonly Step[], cmd: Command, run: () => R): R | CommandResult | Promise<CommandResult> {
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i];
    if (st.plugin.reuse === undefined) continue;
    let r: CommandResult | Promise<CommandResult> | undefined;
    try { r = st.plugin.reuse(cmd); }
    catch (e) { return ruleThrew(e, cmd, st.fail, 'reuse'); }
    if (r !== undefined) return guarded(r, cmd, st.fail);
  }
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i];
    if (st.plugin.admit === undefined) continue;
    let r: CommandResult | undefined;
    try { r = st.plugin.admit(cmd, st.fail); }
    catch (e) { return ruleThrew(e, cmd, st.fail, 'admit'); }
    if (r !== undefined) return r;
  }
  let tickets: WorkTicket[] | null = null;
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i];
    if (st.plugin.begin === undefined) continue;
    let t: WorkTicket | undefined;
    try { t = st.plugin.begin(cmd); }
    catch (e) { const failed = ruleThrew(e, cmd, st.fail, 'begin'); return tickets === null ? failed : land(tickets, failed); }
    if (t !== undefined) (tickets ??= []).push(t);
  }
  if (tickets === null) return run();
  return ticketed(tickets, cmd, run);
}

/** The work under its tickets: their signal, then their `landed`, and an `answer` in place of the work's. */
function ticketed(tickets: readonly WorkTicket[], cmd: Command, run: () => CommandResult | Promise<CommandResult>): CommandResult | Promise<CommandResult> {
  // Several signals combine; each is the command's own (a step's controller,
  // or one it combined with the caller's), so nothing outlives the command
  // and the combination needs no detach.
  let signal: AbortSignal | undefined;
  let answer: Promise<CommandResult> | undefined;
  for (let i = 0; i < tickets.length; i++) {
    const t = tickets[i];
    if (t.signal !== undefined) signal = signal === undefined ? t.signal : _combineSignals(signal, t.signal).signal;
    answer ??= t.answer;
  }
  if (signal !== undefined) cmd.signal = signal;
  let r: CommandResult | Promise<CommandResult>;
  try { r = run(); }
  catch (e) { land(tickets, errResult(e as Error)); throw e; }
  const result = typeof (r as PromiseLike<unknown>).then === 'function'
    ? (r as Promise<CommandResult>).then((v) => land(tickets, v), (e: unknown) => { land(tickets, errResult(e as Error)); throw e; })
    : land(tickets, r as CommandResult);
  if (answer === undefined) return result;
  // The work runs on for the others: its own rejection is theirs, not this caller's.
  if (typeof (result as PromiseLike<unknown>).then === 'function') (result as Promise<CommandResult>).then(undefined, () => {});
  return answer;
}

/** register()'s options when none are given: one object, never stored. */
const NO_OPTIONS: RegisterOptions = {};

/**
 * Register a handler on either bus variant. Both SyncState and AsyncState
 * carry the same fields here, so one implementation covers both.
 */
function register(s: SyncState | AsyncState, action: string, handler: any, opts: RegisterOptions = NO_OPTIONS, syncOptimistic?: typeof undoOnThrow): () => void {
  assertNotSealed(s, 'register');
  refuseLibraryName(action);
  validateNaming(action, s.opts.naming);
  // DEV-gated: overwriting a handler is a wiring mistake only the developer can
  // fix, so the message is worth bytes in dev and none in prod. `DEV` folds to
  // `false` in the IIFE builds, taking the string with it (see src/dev.ts).
  // Inside a hot update the re-run module registers again: that is the
  // update, not a clash. tests/register-hot-update.test.ts.
  if (DEV && s.handlers.has(action) && _hotUpdate() === undefined) {
    _report('warn', 'core:already:handler', `Handler for "${action}" already exists and is being overwritten. Call the unregister function returned by register() first, or use bus.clear() to reset.`, undefined, { action });
  }
  // The library's own command an app named (a form's `<id>Set`, history's
  // trigger) is local under any transport. The last registration decides.
  // tests/library-commands-under-transport.test.ts.
  const local = 'locals' in s && _registersLocal();
  _checkHandler(action, handler, opts, 'locals' in s && s.transportFor !== null && !local ? s.transportFor(action) : undefined);
  let h = handler;
  // Optimistic on the sync bus: a throw of the work runs the undo, then the
  // throw goes on. Decided here, so no other action pays for it. The sync
  // factory hands the wrapper in, so an async-only bundle never carries the
  // sync dispatch it calls.
  if (opts.optimistic && syncOptimistic !== undefined) h = syncOptimistic(s, action, h);
  // A landed undo makes what a plugin keeps for the command stale, as a write
  // makes a stored response stale (RFC 9111 4.4): every installed plugin
  // forgets it, its scope aside. Landed is the ledger's rule: no throw, no
  // rejection, no `{ ok: false }`. The undo path only.
  // tests/undo-forgets-memory.test.ts.
  const undoH = opts.undo && ((c: Command): any => onSettled((opts.undo as Handler)(c.target), (v: any) => {
    if (v?.ok !== false) {
      const pe = s.plugins;
      for (let i = 0, len = pe.length; i < len; i++) pe[i].forget?.(c.target);
    }
    return v;
  }));
  const declares = (opts.optimistic || opts.exclusive) && 'declared' in s;
  let offGroups: (() => void) | undefined;
  // What this call writes (`true`) and removes (`false`), kept so a covered
  // call can be written back.
  const reg: Registration = (on) => {
    s.records.clear();
    if (!on) {
      s.handlers.delete(action);
      if (local) (s as AsyncState).locals.delete(action);
      if (undoH) {
        s.undoHandlers.delete(action);
        s.handlers.delete(action + '$undo');
      }
      if (opts.answer) s.answers.delete(action);
      offGroups?.();
      if (declares) (s as AsyncState).declared.delete(action);
      return;
    }
    // `null`: a sent action's options with no handler, so none stays.
    if (h === null) s.handlers.delete(action);
    else s.handlers.set(action, h);
    if (local) (s as AsyncState).locals.set(action, h);
    else if ('locals' in s) s.locals.delete(action);
    // An undo is a command, `<action>$undo`, whose target is the command it
    // reverses: plugins, listeners and persist hear it (log s35.114). Its name
    // is built only for a call that has one.
    if (undoH) { s.undoHandlers.set(action, opts); s.handlers.set(action + '$undo', undoH); }
    if (opts.answer) s.answers.set(action, opts.answer);
    // Its cache groups, declared here: an action that declares none pays nothing.
    if (opts.cacheGroups || opts.cacheGroupInvalidation) offGroups = declareGroups(s, action, opts);
    if (declares) (s as AsyncState).declared.set(action, opts);
  };
  // One handler per action, the newest registration still live. A newer one
  // covers the live one, which is held until its own cleanup, so the newer
  // one leaving gives the action back (B4 f). Inside a hot update the re-run
  // is the same owner: it takes the old one's place (a development server
  // only, so production carries no check).
  const live = s.owners.get(action);
  if (live !== undefined) {
    live(false);
    if (!DEV || _hotUpdate() === undefined) {
      const held = (s.held ??= new Map());
      const list = held.get(action);
      if (list === undefined) held.set(action, [live]);
      else list.push(live);
    }
  }
  s.owners.set(action, reg);
  reg(true);
  // A buffer runs the commands that waited for this handler (buffer.ts).
  s.opts.buffer?.[_BUFFER].release(action);
  // The cleanup removes only what THIS call registered, found by the call
  // itself, never by the handler (one function may be two owners'). KeepAlive
  // with a max registers the new page, then runs the evicted one's cleanup.
  // tests/register-ownership.test.ts, tests/register-live-owner-fixture.test.ts.
  return () => {
    const list = s.held?.get(action);
    if (s.owners.get(action) === reg) {
      reg(false);
      const back = list?.pop();
      if (back === undefined) { s.owners.delete(action); return; }
      if (list!.length === 0) s.held!.delete(action);
      s.owners.set(action, back);
      back(true);
      return;
    }
    // A covered one leaves the held list only.
    const at = list === undefined ? -1 : list.indexOf(reg);
    if (at === -1) return;
    list!.splice(at, 1);
    if (list!.length === 0) s.held!.delete(action);
  };
}

/** One register() call: `true` writes what it registers, `false` removes it. */
type Registration = (on: boolean) => void;

/**
 * @internal register()'s one rule, the test bus's too: a handler is a function
 * where it can run, `null` where it cannot. Under the action's `transport` it
 * runs only as the change shown (`optimistic`) or as the fallback of a
 * transport that declares `localFallback`. `null` declares a sent action's
 * options with no handler. Anything else never runs, and is refused at the
 * line that registered it. Setup only. tests/register-shadow-check.test.ts.
 */
export function _checkHandler(action: string, handler: unknown, opts: RegisterOptions, transport: Transport | undefined): void {
  if (opts.optimistic && (!opts.undo || handler === null)) {
    throw fail('invalid:option', `register("${action}"): optimistic needs ${opts.undo ? 'a handler' : 'an undo'}.${DEV ? (opts.undo ? ' The handler is the change shown.' : ' The undo takes the change back when the work fails.') : ''}`, { action });
  }
  if (handler === null ? transport !== undefined : typeof handler === 'function' && (transport === undefined || opts.optimistic === true || transport.localFallback === true)) return;
  throw fail('invalid:handler', typeof handler !== 'function' && handler !== null
    ? `register("${action}"): the handler is not a function.`
    : handler === null
      ? `register("${action}"): null declares the options of an action a transport sends, and no transport sends "${action}".${DEV ? ' Register a handler.' : ''}`
      : `register("${action}"): a transport sends "${action}", so this handler would never run.${DEV ? ' Register null to declare its options, add optimistic: true to show the change at once, or declare localFallback on a transport whose send calls local().' : ''}`, { action });
}

/**
 * @internal A bus's cache groups: the hub every source calls and every reader
 * listens to (a transport's client, else the first reader's own), and the
 * actions whose cached results join a group (`RegisterOptions.cacheGroups`),
 * and each `cacheGroupInvalidation` declared, whose listener waits for a hub.
 * Made on first need, keyed by the bus's state.
 */
export type BusGroups = { hub: GroupHub | null; readonly members: Map<string, readonly string[]>; readonly declared: Set<Declared> };

/** One `cacheGroupInvalidation`: `start` puts its listener on, `off` takes it off once on. */
type Declared = { readonly start: () => void; off: (() => void) | undefined };

const groupsBy = /* @__PURE__ */ new WeakMap<object, BusGroups>();

function groupsOf(s: object): BusGroups {
  let g = groupsBy.get(s);
  if (g === undefined) groupsBy.set(s, (g = { hub: null, members: new Map(), declared: new Set() }));
  return g;
}

/** @internal `bus`'s cache groups (BusGroups): what a transport joins and cache() reads. */
export function _groupsAt(bus: BaseBus): BusGroups {
  return groupsOf((bus as any)[_INSPECT] ?? bus);
}

/**
 * @internal `hub` becomes the bus's hub, and each declared action's listener
 * goes on. Before it nothing reads an invalidation, so a bus with no hub keeps
 * its bare path. Register and attach in either order end the same.
 * tests/cache-groups-hub.test.ts.
 */
export function _setHub(g: BusGroups, hub: GroupHub): GroupHub {
  g.hub = hub;
  for (const d of g.declared) d.start();
  return hub;
}

/**
 * An action's cache groups: it joins `cacheGroups`, and a success calls the
 * hub with `cacheGroupInvalidation`, through one exact listener for this
 * action alone, on once the bus has a hub (`_setHub`). An `Accepted` calls it
 * once its `done` settles ok, as revalidateRoutes refreshes. Returns what
 * undoes both.
 */
function declareGroups(s: SyncState | AsyncState, action: string, opts: RegisterOptions): () => void {
  const g = groupsOf(s);
  const joins = opts.cacheGroups;
  const stale = opts.cacheGroupInvalidation;
  if (joins) g.members.set(action, joins);
  let d: Declared | undefined;
  if (stale) {
    const landed = (r: CommandResult): void => {
      if (!r.ok) return;
      if (r.value instanceof Accepted) void r.value.done.then(landed);
      else g.hub?.invalidateGroups(stale);
    };
    const own: Declared = { start: () => { own.off = on(s, action, (_cmd, r) => landed(r)); }, off: undefined };
    g.declared.add(own);
    if (g.hub !== null) own.start();
    d = own;
  }
  return () => {
    if (joins) g.members.delete(action);
    if (d) {
      g.declared.delete(d);
      d.off?.();
    }
  };
}

/** Sync `optimistic`: the work's throw runs the action's undo, then goes on. Its own function: the throw path only. */
function undoOnThrow(s: SyncState | AsyncState, action: string, work: (cmd: Command) => unknown): (cmd: Command) => unknown {
  return (cmd) => {
    try { return work(cmd); }
    catch (e) {
      const u = syncDispatch(s as SyncState, action + '$undo', cmd);
      if (!u.ok) _report('error', 'core:failed:undo', `the undo of "${action}" failed after its failure`, u.error, { action });
      throw e;
    }
  };
}

/** Clear the fields both bus variants share. Each bus then resets its own runner. */
function clearState(s: SyncState | AsyncState): void {
  s.handlers.clear();
  s.owners.clear();
  s.held = null;
  s.undoHandlers.clear();
  s.answers.clear();
  if ('declared' in s) {
    s.declared.clear();
    s.locals.clear();
  }
  s.plugins.length = 0;
  s.rules = null;
  s.steps = null;
  s.records.clear();
  recompose(s);
  // Marked off and replaced, as dropAllListeners does: a dispatch walking them
  // from a hook that called clear() stops calling them.
  for (const h of s.afterHooks) h.off = true;
  s.afterHooks = [];
  dropAllListeners(s);
  // The registrations' groups go with them (their listeners just went); the hub stays (a transport's client).
  const g = groupsBy.get(s);
  if (g !== undefined) {
    g.members.clear();
    g.declared.clear();
  }
  s.responders.clear();
  s.opts.buffer?.[_BUFFER].clear();
}

/** Build the BusInspection snapshot - identical shape for sync and async buses. */
function inspect(s: SyncState | AsyncState): BusInspection {
  return {
    actions:          Array.from(s.handlers.keys()),
    undoActions:      Array.from(s.undoHandlers.keys()),
    responderActions: Array.from(s.responders.keys()),
    pluginCount:      s.plugins.length,
    plugins:          _inspectPlugins(s.plugins),
    transports:       'transports' in s ? s.transports.map((e) => ({ pattern: e.pattern, id: e.transport.id ?? 'transport' })) : [],
    afterHookCount:   s.afterHooks.length,
    listenerPatterns: [...Array.from(s.exactListeners.keys()), ...s.wildcardListeners.map(e => e.pattern)],
    sealed:           s.sealed,
    dispatchDepth:    s.dispatchDepth,
  };
}

/**
 * No-handler path. `canDefer` is true for dispatch (which may buffer) and false
 * for query (which must return a value, so 'buffer' degrades to 'error').
 */
function handleMissing(s: SyncState | AsyncState, cmd: Command, canDefer: boolean): CommandResult {
  // A bus with a buffer holds a dispatch until its handler registers (buffer.ts).
  // A query must answer now, so it never waits.
  const buffer = s.opts.buffer;
  if (buffer !== undefined && canDefer) return buffer[_BUFFER].hold(cmd);
  const mode = s.opts.onMissing ?? 'error';
  if (mode === 'ignore') return okResult(undefined);
  const err = fail(
    'missing:handler',
    `No handler registered for "${cmd.action}".` +
      // The advice is DEV only (production carries the fact; the fix is the
      // catalogue's, ERROR_CODE_REGISTRY). On a bus with transports it names
      // the other cause: no transport pattern covers this action.
      (DEV
        ? ` Call bus.register("${cmd.action}", handler) first.` +
          ('transports' in s && s.transports.length !== 0 ? ' Or declare a transport pattern that covers it.' : '')
        : ''),
    { action: cmd.action },
  );
  if (mode === 'throw') throw err;
  if (typeof mode === 'function') {
    try { return mode(cmd); }
    catch (e) { return errResult(e as Error); }
  }
  return errResult(err);
}

/**
 * `handleMissing` behind an async frame, for the async bus's `execute`. That
 * closure returns `tryCatchAsyncHandler`'s promise directly instead of being
 * `async` itself (an `async` body that returns a promise adds a frame, a
 * promise and two resolve ticks per dispatch); this keeps `onMissing: 'throw'`
 * a rejection rather than a synchronous throw into the work's steps.
 */
async function asyncMissing(s: AsyncState, cmd: Command, canDefer: boolean): Promise<CommandResult> {
  return handleMissing(s, cmd, canDefer);
}


/** `action`'s record, built on its first command since the last change (ActionRecord). */
function recordOf(s: SyncState | AsyncState, action: string): ActionRecord {
  const rec = s.records.get(action);
  return rec === undefined ? buildRecord(s, action) : rec;
}

/** Resolves every fact of `action` once, in one literal. Cold: once per action per change. */
function buildRecord(s: SyncState | AsyncState, action: string): ActionRecord {
  const async = 'pendingRequests' in s;
  const rec: ActionRecord = {
    handler: s.handlers.get(action),
    rules: s.rules === null ? null : s.rules(action),
    steps: s.steps === null ? null : s.steps(action),
    transport: async && s.transportFor !== null && !s.locals.has(action) ? s.transportFor(action) : undefined,
    declared: async ? s.declared.get(action) : undefined,
  };
  if (s.records.size >= CHAINS_MAX) s.records.clear();
  s.records.set(action, rec);
  return rec;
}

/**
 * The sync bus's refusal of `cmd` by its action's rules, settled (the
 * after-hooks, the facts, the listeners), or undefined. Dispatch, query and
 * request run it. An async rule on a sync bus answers a Promise, which the
 * development warning names, as an async plugin's did.
 */
function syncRefused(s: SyncState, rec: ActionRecord, cmd: Command): CommandResult | undefined {
  const refused = _refusal(rec.rules!, cmd) as CommandResult | undefined;
  if (refused !== undefined) { devWarnThenableResult(refused, cmd.action); syncRunHooks(s, cmd, refused); }
  return refused;
}

function syncRunHooks(s: SyncState, cmd: Command, result: CommandResult): void {
  // V8 opt: index-based loops with length snapshot - avoids .slice() allocation
  const ah = s.afterHooks;
  for (let i = 0, len = ah.length; i < len; i++) {
    const h = ah[i];
    if (h.off) continue;
    try { h.fn(cmd, result); } catch (e) { hookFailed(cmd, e); }
  }
  if (s.facts !== null) s.facts.settled(cmd, result);
  fanOutListeners(s.exactListeners, s.wildcardListeners, cmd.action, cmd, result);
}

/**
 * The runner, for dispatch: a throw that escapes it is SETTLED first - the
 * after-hooks and listeners see it as an errResult - and then re-thrown. A
 * caller that chose `onMissing: 'throw'` still gets its throw, and every
 * observer that saw the start (the `started` fact) also sees the end;
 * before, that key stayed true. Only onMissing's NO_HANDLER can escape the
 * runner now (a plugin's throw is already a result, see pluginThrew). A
 * function of its own, like tryCatchHandler, so `_syncDispatchInner` stays
 * free of try - see syncQuery's note on why dispatch splits.
 * Pinned by tests/command-loading-fixture.test.ts and tests/plugin-throw-fixture.test.ts.
 */
function syncRunSettling(s: SyncState, cmd: Command, rec: ActionRecord, execute: () => CommandResult): CommandResult {
  try { return syncWork(rec, cmd, execute); }
  catch (e) { syncRunHooks(s, cmd, errResult(e as Error)); throw e; }
}

// Guard, build, run, as syncDispatchCommand does: the Command is built
// before the depth's try/finally, so no exception edge of `stampMeta` lands
// inside it while the literal is half built, and V8 can drop a meta nothing
// reads on the bare path (docs/V8-RULES.md rule 2, log s35.204).
function syncDispatch(s: SyncState, action: string, target: any, payload?: any, executeOverride?: () => CommandResult): CommandResult {
  if (s.dispatchDepth >= MAX_DISPATCH_DEPTH) {
    return maxDepthResult(action);
  }
  if (s.opts.naming !== undefined) validateNaming(action, s.opts.naming);
  const cmd: Command = { action, target, payload, meta: stampMeta(payload), signal: undefined };
  s.dispatchDepth++;
  try { return _syncDispatchInner(s, cmd, executeOverride); }
  finally { s.dispatchDepth--; }
}

function _syncDispatchInner(s: SyncState, cmd: Command, executeOverride?: () => CommandResult): CommandResult {
  const action = cmd.action;

  // Bare-bus fast path. When the bus has no plugins / hooks / listeners
  // and there's no executeOverride (request/respond path), skip the runner
  // indirection and the post-dispatch hook + listener walk. Direct
  // handler call. The five length/size reads and the facts observer are O(1)
  // property accesses (it is null while no command state listens).
  // (A cached `isBare` boolean was tested and showed a 25% regression vs
  // these direct reads - V8's tight ICs on Map.size / Array.length already
  // optimize the inline check; adding a state field changed the hidden
  // class for no benefit. CHANGELOG v1.2.0, the performance table.)
  if (
    executeOverride === undefined &&
    s.plugins.length === 0 &&
    s.afterHooks.length === 0 &&
    s.exactListeners.size === 0 &&
    s.wildcardListeners.length === 0 &&
    s.facts === null
  ) {
    const handler = s.handlers.get(action);
    if (handler === undefined) return handleMissing(s, cmd, true);
    return tryCatchHandler(handler, cmd);
  }
  return _syncRun(s, cmd, executeOverride);
}

/**
 * A transactional batch dispatches a Command it built and keeps, so its
 * rollback undoes the step that ran (Compensating Transaction). The guard and
 * the run are a normal dispatch's; only the Command comes from the caller.
 */
function syncDispatchCommand(s: SyncState, cmd: Command): CommandResult {
  if (s.dispatchDepth >= MAX_DISPATCH_DEPTH) return maxDepthResult(cmd.action);
  s.dispatchDepth++;
  try {
    if (s.opts.naming !== undefined) validateNaming(cmd.action, s.opts.naming);
    return _syncRun(s, cmd);
  }
  finally { s.dispatchDepth--; }
}

/** Run a built Command: every sync dispatch past the bare path, and a batch's. */
function _syncRun(s: SyncState, cmd: Command, executeOverride?: () => CommandResult): CommandResult {
  const action = cmd.action;
  // The action's facts, one read for the whole dispatch (ActionRecord).
  const rec = recordOf(s, action);

  // A buffer holds a dispatch with no handler yet WITHOUT running the pipeline
  // (plugins/hooks/listeners fire on replay, not now). The bare path in
  // _syncDispatchInner holds through handleMissing (nothing fires there).
  // Skipped for the request/respond path (executeOverride). The gate is one
  // read of the options, as `onMissing` was: a gate on the queue's own state
  // read faster only when monomorphic (CHANGELOG 1.x, "lazily allocated").
  if (executeOverride === undefined && s.opts.buffer !== undefined && rec.handler === undefined) {
    return handleMissing(s, cmd, true);
  }

  // The start, before the rules: a rule's refusal settles a started command.
  if (s.facts !== null) s.facts.started(cmd);
  // The action's rules, before every plugin and the work (PluginParts.authorize).
  if (rec.rules !== null) {
    const refused = syncRefused(s, rec, cmd);
    if (refused !== undefined) return refused;
  }
  let result: CommandResult;
  if (executeOverride === undefined && rec.steps === null && s.opts.onMissing !== 'throw') {
    // No step: the handler is called here, as on the bare path, with no
    // closure; hooks and listeners run below (log s35.143).
    const handler = rec.handler;
    result = handler === undefined ? handleMissing(s, cmd, true) : tryCatchHandler(handler, cmd);
  } else {
    const execute = executeOverride ?? ((): CommandResult => {
      const handler = rec.handler;
      if (!handler) return handleMissing(s, cmd, true);
      return tryCatchHandler(handler, cmd);
    });
    // Only an `onMissing: 'throw'` bus can have a throw escape the work, so
    // only that bus pays syncRunSettling's frame; every other bus keeps the
    // bare call it had (speed over size - the check costs bytes, not time).
    result = s.opts.onMissing === 'throw' ? syncRunSettling(s, cmd, rec, execute) : syncWork(rec, cmd, execute);
  }
  devWarnThenableResult(result, action);
  syncRunHooks(s, cmd, result);
  return result;
}

// Dev-only footgun guard: an ASYNC step or rule (idempotent's join, an async
// validator) on a SYNC bus makes the dispatch return its Promise as the
// CommandResult - `result.ok` is undefined and every dispatch silently "fails". Warn once per
// action in dev.
//
// Keeping the check off the per-dispatch path still matters: `process.env`
// reads go through a slow C++ interceptor, and an inline read measured ~150 ns
// here in v1.13.0 (3 plugins + 1 listener bench dropped 1,240 -> 350 ops/s). `DEV` is a
// module-level const for that reason, and so the build can fold it - see
// src/dev.ts: the ESM build emits the expression from the `__VC_DEV__` define,
// and the IIFE builds fold it to `false`, which drops the warning STRINGS from
// production, not just the branch.
//
// The once-per-action set is allocated on first use INSIDE the DEV branch, so
// a production build - where DEV folds to false - neither allocates it at
// module load nor keeps it. Vue 3.6.0-rc.8 (commit 24) moved its own dev-only
// fallthrough bookkeeping behind __DEV__ the same way.
let _thenableWarned: Set<string> | undefined;
function devWarnThenableResult(result: CommandResult, action: string): void {
  if (DEV) {
    if (result && typeof (result as unknown as PromiseLike<unknown>).then === 'function' && !(_thenableWarned ||= new Set()).has(action)) {
      _thenableWarned.add(action);
      _report('warn', 'core:unexpected:promise',
        `dispatch("${action}") on a SYNC bus returned a Promise - an async step or rule ` +
        `(idempotent, an async validator, ...) is installed on a bus created with createCommandBus(). ` +
        `Use createAsyncCommandBus() instead; result.ok is undefined on this dispatch.`,
        undefined, { action },
      );
    }
  }
}

/**
 * Read-only query - runs the rules, the steps and the handler, fires afterHooks.
 *
 * Split like `dispatch`: the outer half owns the depth guard's `try/finally`,
 * on the same counter, so a handler that queries itself stops at
 * MAX_DISPATCH_DEPTH instead of overflowing the stack, and a chain of
 * dispatches and queries counts every level (log s35.67). The Command is
 * built before the try, as syncDispatch builds it (V8-RULES rule 2,
 * tests/sync-query-build-order.test.ts).
 */
function syncQuery(s: SyncState, action: string, target: any, payload?: any): CommandResult {
  if (s.dispatchDepth >= MAX_DISPATCH_DEPTH) {
    return maxDepthResult(action);
  }
  if (s.opts.naming !== undefined) validateNaming(action, s.opts.naming);
  const cmd: Command = { action, target, payload, meta: stampMeta(payload), signal: undefined };
  s.dispatchDepth++;
  try { return _syncQueryInner(s, cmd); }
  finally { s.dispatchDepth--; }
}

function _syncQueryInner(s: SyncState, cmd: Command): CommandResult {
  const action = cmd.action;
  // Bare-bus fast path - mirrors the one in _syncDispatchInner. Queries skip
  // no `started` fact, so the condition omits nothing more.
  if (
    s.plugins.length === 0 &&
    s.afterHooks.length === 0 &&
    s.exactListeners.size === 0 &&
    s.wildcardListeners.length === 0 &&
    s.facts === null
  ) {
    const handler = s.handlers.get(action);
    if (handler === undefined) return handleMissing(s, cmd, false);
    return tryCatchHandler(handler, cmd);
  }
  const rec = recordOf(s, action);
  // A query's start, which the command state does not count (Facts.queried).
  if (s.facts !== null) s.facts.queried(cmd);
  // The action's rules still answer: they are the command's own.
  if (rec.rules !== null) {
    const refused = syncRefused(s, rec, cmd);
    if (refused !== undefined) return refused;
  }
  let result: CommandResult;
  if (rec.steps === null) {
    // No step: the handler directly, with no closure.
    const handler = rec.handler;
    result = handler === undefined ? handleMissing(s, cmd, false) : tryCatchHandler(handler, cmd);
  } else {
    result = syncWork(rec, cmd, (): CommandResult => {
      const handler = rec.handler;
      if (!handler) return handleMissing(s, cmd, false);
      return tryCatchHandler(handler, cmd);
    });
  }
  devWarnThenableResult(result, action);
  syncRunHooks(s, cmd, result);
  return result;
}

/** Fire a domain event - notifies on() listeners, no handler required, no result. */
function syncEmit(s: SyncState, event: string, data?: any): void {
  // Fast path: no listeners -> return without allocating anything. Real apps
  // emit many events with no subscribers (lifecycle, debug, conditional
  // listeners) - this branch turns those into a hash lookup + length check.
  if (!s.exactListeners.has(event) && s.wildcardListeners.length === 0) return;

  // emit is fire-and-forget - meta (id/correlationId/causationId) is unused
  // by the typical listener, so skip stampMeta to avoid the uid() call and
  // 4-field object allocation. Listeners that DO need meta on an emit can
  // call dispatch instead. The Command type already has `meta?` as optional.
  const cmd: Command = { action: event, target: data };
  fanOutListeners(s.exactListeners, s.wildcardListeners, event, cmd, EMIT_RESULT);
}

/**
 * `BatchOptions` documents `transactional` as "mutually exclusive with
 * `continueOnError`", but nothing enforced it: code order silently let
 * transactional win, so a caller who set both got all-or-nothing semantics
 * while reading their own options as best-effort. Loud in dev, per the
 * house convention.
 */
function warnBatchOptionConflict(opts: BatchOptions): void {
  if (DEV && opts.transactional && opts.continueOnError) {
    _report('warn', 'core:invalid:option',
      'dispatchBatch({ transactional: true, continueOnError: true }) - these are ' +
        'mutually exclusive. `transactional` wins: the batch stops at the first failure and rolls back. ' +
        'Drop one of the two.',
    );
  }
}

function syncDispatchBatch(s: SyncState, commands: BatchCommand[], opts: BatchOptions = {}): BatchResult {
  return _syncBatch(commands, opts, (cmd) => syncDispatchCommand(s, cmd), (action) => s.undoHandlers.has(action), (a, t) => syncDispatch(s, a, t));
}

/**
 * @internal The sync batch rule, for the bus and its test double
 * (`createTestBus`): one rule, so the double cannot diverge
 * (tests/testbus-batch.test.ts). `run` dispatches a built Command; a
 * transactional batch undoes the Commands that ran, newest first, through
 * `dispatch`, for the actions `undoable` names.
 */
export function _syncBatch(
  commands: BatchCommand[],
  opts: BatchOptions,
  run: (cmd: Command) => CommandResult,
  undoable: (action: string) => boolean,
  dispatch: (action: string, target: any) => CommandResult,
): BatchResult {
  warnBatchOptionConflict(opts);
  const results: CommandResult[] = [];
  const ran: Command[] = [];
  let firstError: Error | undefined;
  let failCount = 0;
  for (let ci = 0; ci < commands.length; ci++) {
    const { action, target, payload } = commands[ci];
    const cmd: Command = { action, target, payload, meta: stampMeta(payload), signal: undefined };
    ran.push(cmd);
    const result = run(cmd);
    results.push(result);
    if (!result.ok) {
      failCount++;
      if (opts.transactional) {
        // Rollback: undo every command that succeeded, newest first. All of
        // 0..ci-1 succeeded: a transactional batch stops at its first failure.
        const rollbacks: CommandResult[] = [];
        for (let j = ci - 1; j >= 0; j--) if (undoable(ran[j].action)) rollbacks.push(_undo({ dispatch }, ran[j]));
        return { ok: false, results, error: result.error, successCount: ci, failCount: 1, rollbacks };
      }
      if (!opts.continueOnError) return { ok: false, results, error: result.error, successCount: results.length - failCount, failCount };
      if (!firstError) firstError = result.error;
    }
  }
  const successCount = results.length - failCount;
  return firstError ? { ok: false, results, error: firstError, successCount, failCount } : { ok: true, results, successCount, failCount };
}


/**
 * A transport is the work, declared at the bus, never a plugin. The test bus's rule too
 * (tests/transport-is-the-work.test.ts). The one rule: an object with a part
 * the bus places (`started`, `settled`, `authorize`, `validate`, `reuse`,
 * `admit`, `begin`, `attach`) and no `send` (a transport's, which may
 * carry `attach`); anything else is refused, a function too: no
 * part holds `next` (tests/plugin-declares-parts.test.ts). A plugin installs
 * once: a second use() would place its parts twice. Two plugins sharing an
 * `id` install, but their failures carry one owner, so development says it
 * (tests/plugin-install-once.test.ts).
 */
function assertPlugin(plugin: unknown, installed: readonly PluginParts[]): void {
  const p = plugin as PluginParts | null;
  const placed = typeof plugin === 'object' && p !== null && typeof (p as Partial<Transport>).send !== 'function' && (typeof p.started === 'function' || typeof p.settled === 'function' || typeof p.authorize === 'function' || typeof p.validate === 'function' || typeof p.reuse === 'function' || typeof p.admit === 'function' || typeof p.begin === 'function' || typeof p.attach === 'function');
  if (!placed) {
    throw fail('invalid:plugin', `use() takes a plugin's parts: an object with a part the bus places.${DEV ? ' A function plugin holding next() is gone: declare its parts (started, settled, authorize, validate, reuse, admit, begin). A transport is declared at the bus: createAsyncCommandBus({ transport }).' : ''}`, { context: { plugin: typeof plugin } });
  }
  if (installed.includes(p!)) throw fail('invalid:plugin', `use() installs a plugin once, and this one is installed.${DEV ? ' Take it out with the function use() returned first, or install a new instance.' : ''}`, { context: { id: p!.id } });
  if (DEV && p!.id !== undefined && installed.some((q) => q.id === p!.id)) _report('warn', 'core:already:plugin', `Two plugins share the id "${p!.id}": their failures carry one owner. Give each its own id if they differ.`, undefined, { plugin: p!.id });
}

/**
 * use() for both buses: the bus places each part of the plugin. `started`
 * and `settled` join the facts slot, `authorize` and `validate` the rules,
 * `reuse`, `admit` and `begin` the work's steps, `attach` gets this bus. The
 * returned function takes them all out.
 */
function usePlugin(s: SyncState | AsyncState, plugin: PluginParts, bus: BaseBus): () => void {
  assertNotSealed(s, 'use');
  assertPlugin(plugin, s.plugins);
  // Before the plugin is placed: an attach that throws refuses the install,
  // and nothing of the plugin stays (tests/supersede.test.ts).
  const detach = plugin.attach?.(bus);
  s.plugins.push(plugin);
  const observes = plugin.started !== undefined || plugin.settled !== undefined;
  const ruled = plugin.authorize !== undefined || plugin.validate !== undefined;
  const steps = plugin.reuse !== undefined || plugin.admit !== undefined || plugin.begin !== undefined;
  const place = (): void => {
    s.records.clear();
    if (observes) recompose(s);
    if (ruled) s.rules = _rulesOf(s.plugins);
    if (steps) s.steps = _stepsOf(s.plugins);
  };
  place();
  return () => { const i = s.plugins.indexOf(plugin); if (i !== -1) { s.plugins.splice(i, 1); place(); detach?.(); } };
}

/** The sync bus's work behind the action's steps (PluginParts.reuse). */
function syncWork(rec: ActionRecord, cmd: Command, execute: () => CommandResult): CommandResult {
  return rec.steps === null ? execute() : _stepped(rec.steps, cmd, execute) as CommandResult;
}

// ---------------------------------------------------------------------------
// Shared listener and hook helpers - used by both sync and async buses.
// Both SyncState and AsyncState carry exactListeners/wildcardListeners with
// identical types, so a single implementation covers both.
// ---------------------------------------------------------------------------

type ListenerBucket = {
  exactListeners: Map<string, ListenerEntry[]>;
  wildcardListeners: WildcardEntry[];
};

// Self-polyfill: same `??=` idiom TS's own downlevel `using` helper applies,
// so whichever side runs first, both agree on the same well-known symbol -
// works whether the runtime has native Explicit Resource Management or not.
const _SYM_DISPOSE: symbol = ((Symbol as any).dispose ??= Symbol());

/**
 * Finish an on()/once() unsubscribe fn: bind it to `signal` (self-detaching,
 * fires at most once - the abort listener doubles as the manual-off path, so
 * there is only one removeEventListener site) and tag it with Symbol.dispose
 * so `using off = bus.on(...)` works. An already-aborted signal unsubscribes
 * synchronously before returning - same observable effect as never
 * subscribing, matches DOM `addEventListener`, no separate pre-check needed
 * in `on()`. Cold path - runs once per subscription, never touches dispatch.
 */
function finalizeOff(off: () => void, signal?: AbortSignal): () => void {
  if (signal) {
    const raw = off;
    off = () => { signal.removeEventListener('abort', off); raw(); };
    if (signal.aborted) off();
    else signal.addEventListener('abort', off);
  }
  (off as any)[_SYM_DISPOSE] = off;
  return off;
}

/**
 * Subscribe. Adding pushes onto the live array (a dispatch walking it stops at
 * the length it started with); removing marks the entry `off` and replaces
 * the array with one without it, never splicing the one a dispatch may be
 * walking (see fanOutListeners). Both are cold paths: per subscription.
 */
function on(s: ListenerBucket, pattern: string, listener: Listener, opts?: ListenerOptions): () => void {
  const signal = opts?.signal;
  const prefix = _patternPrefix(pattern);
  if (prefix !== undefined) {
    // Parse once, here, where the pattern has just been classified - see
    // WildcardEntry.
    const entry: WildcardEntry = { pattern, prefix, listener, off: false };
    s.wildcardListeners.push(entry);
    return finalizeOff(() => {
      if (entry.off) return;
      entry.off = true;
      s.wildcardListeners = s.wildcardListeners.filter((e) => e !== entry);
    }, signal);
  }
  const entry: ListenerEntry = { pattern, prefix: '', listener, off: false };
  let bucket = s.exactListeners.get(pattern);
  if (bucket === undefined) { bucket = []; s.exactListeners.set(pattern, bucket); }
  bucket.push(entry);
  return finalizeOff(() => {
    if (entry.off) return;
    entry.off = true;
    // Present: every path that drops a bucket marks its entries off first.
    const rest = s.exactListeners.get(pattern)!.filter((e) => e !== entry);
    if (rest.length === 0) s.exactListeners.delete(pattern);
    else s.exactListeners.set(pattern, rest);
  }, signal);
}

/** Unsubscribe every listener: marked `off`, so a dispatch walking them stops calling them. */
function dropAllListeners(s: ListenerBucket): void {
  for (const b of s.exactListeners.values()) for (const e of b) e.off = true;
  for (const e of s.wildcardListeners) e.off = true;
  s.exactListeners.clear();
  s.wildcardListeners = [];
}

/**
 * once() unsubscribes itself *before* calling the listener - matches
 * DOM addEventListener({ once: true }) semantics.
 */
function once(s: ListenerBucket, pattern: string, listener: Listener, opts?: ListenerOptions): () => void {
  const unsub = on(s, pattern, (cmd, result) => { unsub(); listener(cmd, result); }, opts);
  return unsub;
}

function offAll(s: ListenerBucket, pattern?: string): void {
  if (pattern === undefined) {
    dropAllListeners(s);
    return;
  }
  if (_patternPrefix(pattern) !== undefined) {
    for (const e of s.wildcardListeners) if (e.pattern === pattern) e.off = true;
    s.wildcardListeners = s.wildcardListeners.filter((e) => !e.off);
  } else {
    const b = s.exactListeners.get(pattern);
    if (b !== undefined) for (const e of b) e.off = true;
    s.exactListeners.delete(pattern);
  }
}

/**
 * Add a hook by the listeners' rule (see on() and fanOutListeners): adding
 * pushes onto the live array, removing marks the entry `off` and replaces
 * the array, never splicing the one a dispatch may be walking. So a dispatch
 * runs the hooks that existed when it started, skips one removed during it,
 * and runs one added during it from the next dispatch
 * (tests/hook-removal-parity.test.ts). Cold path: per subscription.
 */
function addHook(s: SyncState | AsyncState, key: 'afterHooks', fn: unknown, method: string): () => void {
  assertNotSealed(s, method);
  // One reader for both lists of both buses; the hook's own type is the caller's.
  const lists = s as unknown as Record<typeof key, HookEntry<unknown>[]>;
  const entry: HookEntry<unknown> = { fn, off: false };
  lists[key].push(entry);
  return () => {
    if (entry.off) return;
    entry.off = true;
    lists[key] = lists[key].filter((e) => e !== entry);
  };
}

function syncRequest(s: SyncState, action: string, target: any, payload?: any, reqOpts: { timeout?: number; signal?: AbortSignal } = {}): Promise<CommandResult> {
  const signal = reqOpts.signal;
  const responder = s.responders.get(action);
  // Pre-flight abort, as on the async bus.
  if (signal?.aborted) return Promise.resolve(abortedResult(action, signal));
  if (!responder) return Promise.resolve(syncDispatch(s, action, target, payload));

  // The responder is the work, behind the action's rules and steps.
  const cmd: Command = { action, target, payload, meta: stampMeta(payload), signal: undefined };
  const execute = (): CommandResult => {
    try { return okResult(responder(cmd)); }
    catch (e) { return errResult(e as Error); }
  };
  const rec = recordOf(s, action);
  if (s.facts !== null) s.facts.queried(cmd);
  // The action's rules answer before the responder, as on the async bus.
  if (rec.rules !== null) {
    const refused = syncRefused(s, rec, cmd);
    if (refused !== undefined) return Promise.resolve(refused);
  }

  // No try/catch: a step's throw is its plugin's failed:plugin result, and
  // `execute` is the responder, never onMissing.
  const pluginResult = syncWork(rec, cmd, execute);

  syncRunHooks(s, cmd, pluginResult);

  // Unwrap async responder value if needed
  const maybeAsync = pluginResult.value;
  // Only a pending value can time out or be cancelled, so only it takes the
  // timer and the cancel below; every other result settles as it is (the
  // sync-responder row of tests/request-dispose-ab.test.ts measures what an
  // always-armed timer costs).
  if (!pluginResult.ok || !maybeAsync || typeof maybeAsync.then !== 'function') return Promise.resolve(pluginResult);

  // `cmd` keeps the five fields every command has, its `signal` undefined: the caller's signal
  // settles THIS promise and never reaches the responder (see Command.signal
  // and the shape note in docs/performance.md). One closure serves both
  // dispose(), which runs it (see SyncState.waiting), and the caller's abort:
  // abortedResult reads a reason only off an aborted signal, so from
  // dispose() it is the plain core:aborted:dispatch either way.
  const timeout = requestTimeout(reqOpts.timeout);
  const pending = (s.waiting ||= new Set());
  return new Promise((resolve) => {
    const done = (r: CommandResult): void => {
      clearTimeout(timeoutId);
      pending.delete(cancel);
      signal?.removeEventListener('abort', cancel);
      resolve(r);
    };
    const cancel = (): void => done(abortedResult(action, signal));
    const timeoutId = setTimeout(() => done(requestTimeoutResult(action, timeout)), timeout);
    pending.add(cancel);
    signal?.addEventListener('abort', cancel);
    maybeAsync.then((v: any) => done(okResult(v)), (e: Error) => done(errResult(e)));
  });
}

function respond(s: SyncState | AsyncState, action: string, handler: (cmd: Command) => any | Promise<any>): () => void {
  assertNotSealed(s, 'respond');
  validateNaming(action, s.opts.naming);
  s.responders.set(action, handler);
  return () => s.responders.delete(action);
}

function syncClear(s: SyncState): void {
  clearState(s);
}

/** dispose() for both buses; `clear` is the bus's own clear(). */
function disposeBus<S extends SyncState | AsyncState>(s: S, clear: (s: S) => void): void {
  // Plugin dispose() first, before clear() drops the entries: a plugin cancels
  // its timers, retry ends its backoff sleeps. Cold path.
  for (let i = s.plugins.length - 1; i >= 0; i--) s.plugins[i].dispose?.();
  if ('retry' in s) {
    s.retry?.dispose();
    // Each transport once, however many patterns name it.
    for (const t of new Set(s.transports.map((e) => e.transport))) t.dispose?.();
    (s.opts as AsyncCommandBusOptions).outbox?.dispose();
  }
  clear(s);
  // Each cancel settles its request, which removes itself (see syncRequest and asyncRequest).
  if (s.waiting) for (const cancel of s.waiting) cancel();
}

/**
 * The members both buses share, over either state; `clear` is the bus's own.
 * The symbol keys are for tree-shakeable introspection, not the public
 * interface. _INSPECT carries the STATE, not `() => inspect(s)`: a closure
 * would hold inspect() from every bus ever constructed, so its body shipped to
 * consumers that never import inspectBus (measured at 128 brotli on a minimal
 * consumer, v1.22.0). Handing over the state keeps inspect() reachable only from
 * inspectBus.
 */
function busParts<S extends SyncState | AsyncState>(s: S, clear: (s: S) => void) {
  return {
    onAfter:           (h: S['afterHooks'][number]['fn'])  => addHook(s, 'afterHooks', h, 'onAfter'),
    on:                (pat: string, l: Listener, o?: ListenerOptions) => on(s, pat, l, o),
    once:              (pat: string, l: Listener, o?: ListenerOptions) => once(s, pat, l, o),
    offAll:            (pat?: string)                    => offAll(s, pat),
    respond:           (a: string, h: (cmd: Command) => any) => respond(s, a, h),
    hasHandler:        (a: string)                       => s.handlers.has(a),
    registeredActions: ()                                => Array.from(s.handlers.keys()),
    getUndoHandler:    (a: string)                       => s.undoHandlers.get(a)?.undo,
    getUndoCheck:      (a: string)                       => s.undoHandlers.get(a)?.canUndo,
    clear:             ()                                => { assertNotSealed(s, 'clear'); clear(s); },
    dispose:           ()                                => disposeBus(s, clear),
    seal:              ()                                => { s.sealed = true; },
    isSealed:          ()                                => s.sealed,
    [_UNSEAL]:         ()                                => { s.sealed = false; },
    [_INSPECT]:        s,
  };
}

// ---------------------------------------------------------------------------
// createCommandBus
// ---------------------------------------------------------------------------

/**
 * Create a synchronous command bus.
 *
 * @example
 * // Basic usage
 * const bus = createCommandBus();
 * bus.register('cart/add', (cmd) => addToCart(cmd.target, cmd.payload));
 * const result = bus.dispatch('cart/add', { id: 1 }, { qty: 2 });
 * if (result.ok) console.log('Added:', result.value);
 *
 * @example
 * // Type-safe with CommandMap
 * type App = {
 *   'cart/add': { target: { id: number }; payload: { qty: number }; result: void };
 * };
 * const bus = createCommandBus<App>();
 * bus.dispatch('cart/add', { id: 1 }, { qty: 2 }); // fully typed
 *
 * @example
 * // With plugins, hooks, and listeners
 * const bus = createCommandBus();
 * bus.use(logger());          // plugin wraps every dispatch
 * bus.onAfter((cmd, res) => { }); // runs after handler
 * bus.on('cart/*', (cmd, res) => { }); // wildcard listener
 */
export function createCommandBus<M extends CommandMap = CommandMap>(options: CommandBusOptions = {}): CommandBus<M> {
  const s: SyncState = {
    opts: options,
    handlers: new Map(), undoHandlers: new Map(), answers: new Map(),
    plugins: [], afterHooks: [],
    exactListeners: new Map(), wildcardListeners: [],
    responders: new Map(),
    steps: null,
    records: new Map(),
    owners: new Map(), held: null,
    dispatchDepth: 0,
    sealed: false,
    waiting: null,
    facts: null,
    rules: null,
  };
  const bus: CommandBus<M> = {
    // Sync bus accepts the options arg for type compatibility with BaseBus,
    // but ignores `signal` - sync dispatches are atomic and not cancelable.
    dispatch:          (a, t, p, _o)   => syncDispatch(s, a as string, t, p),
    query:             (a, t, p)       => syncQuery(s, a as string, t, p),
    emit:              (e, d)          => syncEmit(s, e, d),
    dispatchBatch:     (cmds, o)       => syncDispatchBatch(s, cmds, o),
    register:          (a, h, o)       => register(s, a as string, h as Handler, o, undoOnThrow),
    use:               (p)             => usePlugin(s, p, bus),
    request:           (a, t, p, o)   => syncRequest(s, a as string, t, p, o),
    ...busParts(s, syncClear),
  };
  options.buffer?.[_BUFFER].attach(bus);
  return bus;
}

// ---------------------------------------------------------------------------
// Retry policy (docs/retry.md)
// ---------------------------------------------------------------------------

type Retrier = {
  /** Call, and re-send by the class rule. */
  run(cmd: Command, call: () => CommandResult | Promise<CommandResult>): Promise<CommandResult>;
  /** The no-step path's half of `run` before the first send: an idempotent action's key stamped. */
  begin(cmd: Command): void;
  /** Its other half: a success as it came, a failure re-sent through the work by the class rule. */
  end(result: CommandResult, cmd: Command, s: AsyncState, rec: ActionRecord, dispatching: boolean): CommandResult | Promise<CommandResult>;
  /** End every wait (the bus's dispose()). */
  dispose(): void;
};

/**
 * The value of the most specific pattern matching an action: an exact name,
 * then the longest prefix, then `*`, whatever the written order. Two different
 * patterns of one rank never match the same action. Resolved once per action
 * (V8-RULES 3, measured M1). The one reader for `retry.actionPolicies` and the
 * bus's `transport` map. An action `skip` names resolves to undefined, once too.
 * The hit path is its own small function, so V8 inlines it into the dispatch.
 * The whole lookup in one closure stayed a call on every local dispatch
 * (`--trace-turbo-inlining`, log 36.45). `null` caches "none".
 */
function mostSpecific<T>(map: Readonly<Record<string, T>>, skip?: (action: string) => boolean, adapt?: (action: string, value: T) => T): (action: string) => T | undefined {
  const rank = (p: string): number => _patternPrefix(p)?.length ?? Infinity;
  const patterns = Object.keys(map).sort((a, b) => rank(b) - rank(a));
  const known = new Map<string, T | null>();
  const resolve = (action: string): T | undefined => {
    let value: T | null = null;
    if (skip === undefined || !skip(action)) for (const p of patterns) if (matchesPattern(p, action)) { value = adapt ? adapt(action, map[p]) : map[p]; break; }
    if (known.size >= CHAINS_MAX) known.clear();
    known.set(action, value);
    return value ?? undefined;
  };
  return (action) => {
    const value = known.get(action);
    return value === undefined ? resolve(action) : value ?? undefined;
  };
}

/**
 * The one rule for a command's idempotency key, decided once per dispatch: a
 * key already stamped stays, else the key given (an app's own, as given), else
 * the dispatch's id. The id is opaque and the same on every attempt, as
 * Idempotency-Key draft-07 2.2 recommends: a key is a header, which proxies
 * and logs keep, so no command content goes in it. idempotent() and the retry
 * stamp through it. tests/idempotency-key.test.ts.
 */
export function _keyed(meta: CommandMeta | undefined, key?: string): void {
  if (meta) meta.idempotencyKey ??= key ?? meta.id;
}

/**
 * @internal The other rule: an outbox record's key replaces any key stamped,
 * so the record's key wins wherever `idempotent` is installed. The held
 * command and its replay stamp through it. tests/idempotency-key.test.ts.
 */
export function _recordKeyed(cmd: Command, key: string): void {
  cmd.meta!.idempotencyKey = key;
}

/** The per-bus budget (gRPC A6): a retry runs only while more than half remain. */
const RETRY_TOKENS = 10;

/**
 * The async bus's retry, as the success models place it (the AWS SDKs, the
 * .NET standard resilience handler, Temporal activities): at the call that
 * produces the outcome, bounded, jittered and budgeted.
 *
 * - **Class rule.** Final, never: the other side's verdict, an abort, a depth
 *   bound, a library bug. Transient, always: `limited`, a 408 `timeout`.
 *   Uncertain (the first attempt may have landed: no reply, a 502 or 504),
 *   and any failure with a declared `retryIn`: only for an action declared
 *   idempotent, or a command carrying an idempotency key (RFC 9110 9.2.2,
 *   10.2.3: a wait says when, never whether). Held back for want of either,
 *   a no-reply failure is marked `outcome: 'unknown'` and DEV warns. An
 *   action declared idempotent gets its dispatch's id as its key, so every
 *   attempt carries the same one. A replay (`meta.origin: 'replay'`, the
 *   outbox's) is already a scheduled re-send: its scheduler owns the retry,
 *   so the two do not multiply.
 * - **Waits.** Full jitter, uniform under `baseDelay * 2^(n-1)`, so clients
 *   that failed together do not come back together; a declared `retryIn` as
 *   given. The computed wait is capped at `maxDelay`; a declared one longer
 *   than `maxDelay` is not re-sent (the failure is returned), never sent
 *   early. dispose() and the dispatch's own signal end a wait, and the
 *   dispatch settles `core:aborted:dispatch`.
 * - **Budget.** A retry-eligible failure spends a token, a success refunds a
 *   tenth; below half, failures are returned at once, so retries cannot
 *   multiply the load on a backend that is down.
 *
 * A success costs one `.then` and no allocation beyond it; the loop and its
 * waits exist only for a failure (tests/retry-happy-path.test.ts).
 */
function createRetrier(options: RetryOptions): Retrier {
  const maxAttempts = countOption(options.maxAttempts, _RETRY_ATTEMPTS, 1);
  const baseDelay = countOption(options.baseDelay, _RETRY_BASE_MS);
  const maxDelay = countOption(options.maxDelay, _RETRY_MAX_MS, 0, MAX_TIMEOUT_MS);
  // No policy declared, no lookup on the dispatch path.
  const policies = options.actionPolicies ?? {};
  const declared = Object.keys(policies).length === 0 ? null : mostSpecific(policies);
  const waits = createSleeper();
  let tokens = RETRY_TOKENS;

  function settled(result: CommandResult, cmd: Command, call: () => CommandResult | Promise<CommandResult>, declaration: RetryPolicy | undefined): CommandResult | Promise<CommandResult> {
    if (result.ok) return refunded(result);
    return again(result, cmd, call, declaration);
  }

  function refunded(result: CommandResult): CommandResult {
    if (tokens < RETRY_TOKENS) tokens = Math.min(RETRY_TOKENS, tokens + 0.1);
    return result;
  }

  function begin(cmd: Command): RetryPolicy | undefined {
    const declaration = policyOf(cmd.action);
    if (declaration === 'idempotent') _keyed(cmd.meta);
    return declaration;
  }

  function policyOf(action: string): RetryPolicy | undefined {
    return declared === null ? undefined : declared(action);
  }

  async function again(result: CommandResult, cmd: Command, call: () => CommandResult | Promise<CommandResult>, declaration: RetryPolicy | undefined): Promise<CommandResult> {
    const bound = declaration === false ? 1 : typeof declaration === 'number' ? countOption(declaration, maxAttempts, 1) : maxAttempts;
    for (let attempt = 1; ; attempt++) {
      if (result.ok) return settled(result, cmd, call, declaration);
      const error = result.error as BusError;
      const retryIn = error?.context?.retryIn;
      const condition = failureCondition(error, cmd.signal);
      // A declared wait longer than maxDelay is returned, never re-sent early:
      // Retry-After is a minimum (RFC 9110). tests/retry-after-long.test.ts.
      // The one rule (retryClass, shared with the http client): transient for
      // any action; uncertain, or a declared wait, only for an identified one.
      const cls = retryClass(error, condition);
      const open = !(typeof retryIn === 'number' && retryIn > maxDelay) && cmd.meta?.origin !== 'replay';
      const eligible = open && (cls === 'transient' || ((cls === 'uncertain' || typeof retryIn === 'number') &&
        (declaration === 'idempotent' || cmd.meta?.idempotencyKey !== undefined)));
      if (eligible) tokens = Math.max(0, tokens - 1);
      if (!eligible || attempt >= bound || tokens <= RETRY_TOKENS / 2) {
        // A failure that was sent more than once says how many times.
        if (attempt > 1 && error instanceof BusError) (error as { context?: object }).context = { ...error.context, attempts: attempt };
        // Held back for lack of identity: reported, never silent.
        if (!eligible && open && attempt < bound) _heldBack(error, retryIn, cmd.action);
        return result;
      }
      // A NaN wait is no wait: it re-sent at once instead of backing off. A
      // declared one is at most maxDelay here (`open` above).
      const wait = isDelay(retryIn) ? retryIn : _backoff(attempt - 1, baseDelay, maxDelay);
      if (!(await waits.sleep(delayOption(wait, 0), cmd.signal))) return abortedResult(cmd.action, cmd.signal);
      result = await call();
    }
  }

  return {
    run(cmd, call) {
      const declaration = begin(cmd);
      return Promise.resolve(call()).then((r) => settled(r, cmd, call, declaration));
    },
    begin,
    end(result, cmd, s, rec, dispatching) {
      return result.ok ? refunded(result) : again(result, cmd, () => work(s, rec, cmd, dispatching), policyOf(cmd.action));
    },
    dispose: waits.wakeAll,
  };
}

// ---------------------------------------------------------------------------
// Module-level async bus operations
// ---------------------------------------------------------------------------

/** The listeners, run at the dispatch's depth (see asyncDispatch). */
function asyncFanOut(s: AsyncState, cmd: Command, result: CommandResult, depth: number): void {
  const at = s.dispatchDepth;
  s.dispatchDepth = depth;
  try {
    if (s.facts !== null) s.facts.settled(cmd, result);
    fanOutListeners(s.exactListeners, s.wildcardListeners, cmd.action, cmd, result);
  }
  finally { s.dispatchDepth = at; }
}

/**
 * The after-hooks, then the listeners. A plain loop, so a dispatch whose hooks
 * return nothing pays no frame and no await (two microtask turns,
 * tests/async-after-hooks.test.ts): callers `const h = asyncRunHooks(...); if
 * (h) await h;`. It walks `ah` to `len`, the list and length the dispatch
 * started with (addHook). A hook's thenable hands the rest to its settling,
 * and only then are its two closures built.
 */
function asyncRunHooks(s: AsyncState, cmd: Command, result: CommandResult, depth: number, ah = s.afterHooks, i = 0, len = ah.length): void | Promise<void> {
  for (; i < len; i++) {
    const h = ah[i];
    if (h.off) continue;
    try {
      const at = s.dispatchDepth;
      s.dispatchDepth = depth;
      let r: unknown;
      try { r = h.fn(cmd, result); }
      finally { s.dispatchDepth = at; }
      if (r && typeof (r as PromiseLike<void>).then === 'function') {
        const rest = (): void | Promise<void> => asyncRunHooks(s, cmd, result, depth, ah, i + 1, len);
        return Promise.resolve(r).then(rest, (e) => { hookFailed(cmd, e); return rest(); });
      }
    } catch (e) { hookFailed(cmd, e); }
  }
  asyncFanOut(s, cmd, result, depth);
}

/** An onAfter hook's throw or rejection: reported, and the dispatch goes on. Failure path only. */
function hookFailed(cmd: Command, e: unknown): void {
  _report('error', 'core:failed:hook', `an onAfter hook threw on "${cmd.action}"`, e, { action: cmd.action });
}

/**
 * On the async bus `dispatchDepth` is the depth of the dispatch whose code is
 * running NOW, not a count of dispatches in flight: counting across an await
 * refused the 17th of 17 concurrent, unnested dispatches (log s35.67). A
 * dispatch is its parent's depth + 1; every stretch of it that calls user code
 * (rules, the steps and the work, after-hooks, listeners) runs at its own depth and
 * restores the one it found, so a dispatch started from that code is nested
 * and one started anywhere else is not. A loop through the user's own await
 * is not followed (there is no async context to follow it by).
 * Not `async`: the first stretch runs synchronously inside the caller, and
 * the inner promise is returned as is (no second frame).
 */
function asyncDispatch(s: AsyncState, action: string, target: any, payload?: any, executeOverride?: (cmd: Command) => Promise<CommandResult>, signal?: AbortSignal): Promise<CommandResult> {
  const outer = s.dispatchDepth;
  if (outer >= MAX_DISPATCH_DEPTH) {
    return Promise.resolve(maxDepthResult(action));
  }
  s.dispatchDepth = outer + 1;
  try { return _asyncDispatchInner(s, outer + 1, action, target, payload, executeOverride, signal); }
  finally { s.dispatchDepth = outer; }
}

/**
 * Build a stable AbortError result. Prefers a user-provided explicit reason
 * (e.g. `ac.abort(new MyError('cancelled'))`) over the lib's BusError, but
 * falls back to BusError for the default `ac.abort()` case so consumers can
 * switch on `error.code === 'core:aborted:dispatch'`.
 *
 * After-hooks still fire from the caller, so observability is intact.
 *
 * `signal` is optional: dispose() settles a waiting request() with none, and
 * gets the BusError.
 * @internal - also used by transports.ts for mid-flight signal handling.
 */
export function abortedResult(action: string, signal?: AbortSignal): CommandResult {
  const reason = signal && (signal as any).reason;
  // Default DOMException (name: 'AbortError') is what `ac.abort()` produces
  // with no arg; substitute our BusError so the code field is queryable.
  const isDefaultAbort = reason && reason.name === 'AbortError' && reason.constructor !== BusError;
  if (reason instanceof Error && !isDefaultAbort) return errResult(reason);
  return errResult(fail('aborted:dispatch', `Dispatch "${action}" was aborted.`, { action, cause: reason }));
}

function _asyncDispatchInner(s: AsyncState, depth: number, action: string, target: any, payload?: any, executeOverride?: (cmd: Command) => Promise<CommandResult>, signal?: AbortSignal): Promise<CommandResult> {
  return _asyncRun(s, depth, { action, target, payload, meta: stampMeta(payload), signal }, executeOverride);
}

/** The async side of `syncDispatchCommand`: a batch runs the Command it keeps. */
function asyncDispatchCommand(s: AsyncState, cmd: Command): Promise<CommandResult> {
  const outer = s.dispatchDepth;
  if (outer >= MAX_DISPATCH_DEPTH) return Promise.resolve(maxDepthResult(cmd.action));
  s.dispatchDepth = outer + 1;
  try { return _asyncRun(s, outer + 1, cmd); }
  finally { s.dispatchDepth = outer; }
}

/**
 * The work, for dispatch() and query() alike: the action's transport, else
 * its local handler, else the missing-handler outcome. No closure here: one
 * would give every call a context, a local action's too (log 36.45).
 */
function work(s: AsyncState, rec: ActionRecord, cmd: Command, dispatching: boolean): CommandResult | Promise<CommandResult> {
  const transport = rec.transport;
  return transport === undefined ? runLocalNow(s, rec, cmd, dispatching) : sendFrom(s, rec, transport, cmd, dispatching);
}

/** A sent action: the transport gets the local work as its fallback. */
function sendFrom(s: AsyncState, rec: ActionRecord, transport: Transport, cmd: Command, dispatching: boolean): Promise<CommandResult> {
  return send(transport, cmd, () => runLocal(s, rec, cmd, dispatching), s);
}

/** The action's local handler, or the missing-handler outcome: a sync handler's at once. */
function runLocalNow(s: AsyncState, rec: ActionRecord, cmd: Command, dispatching: boolean): CommandResult | Promise<CommandResult> {
  const handler = rec.handler;
  return handler ? tryCatchAsyncHandler(handler, cmd) : asyncMissing(s, cmd, dispatching);
}

/** The same as a promise, for a contract that takes one: a transport's `local`, the shown change, a replay. */
function runLocal(s: AsyncState, rec: ActionRecord, cmd: Command, dispatching: boolean): Promise<CommandResult> {
  return Promise.resolve(runLocalNow(s, rec, cmd, dispatching));
}

/**
 * The send, the test bus's too: the transport answers the command. A throw or
 * rejection is the transport's own failure (`<its id>:failed:send`), the
 * caller's abort excepted. Given the bus `s`, a success it carried is written
 * where the work is, inside the call the retry re-sends: the action's
 * `answer`, then each store state the reply declared, last, so what the
 * server named wins and every plugin outside sees it. Store ids are external
 * strings: own keys only, in a Map (src/dict.ts). Decided when the send
 * starts. One `.then` on the transport's own promise: an async frame cost a
 * sent dispatch about 19 ns more (log 36.45).
 */
function send(transport: Transport, cmd: Command, local: () => Promise<CommandResult>, s?: AsyncState): Promise<CommandResult> {
  let r: CommandResult | Promise<CommandResult>;
  try { r = transport.send(cmd, local); }
  catch (e) { return Promise.resolve(sendFailed(e, transport, cmd)); }
  const failed = (e: unknown): CommandResult => sendFailed(e, transport, cmd);
  return s === undefined || (s.answers.size === 0 && s.stores.entries.size === 0)
    ? Promise.resolve(r).then(undefined, failed)
    : Promise.resolve(r).then((res) => answered(s, cmd, res), failed);
}

/** A transport's throw or rejection: its `failed:send`, the caller's abort excepted. Failure path only. */
function sendFailed(e: unknown, transport: Transport, cmd: Command): CommandResult {
  return ownAbort(e, cmd) ?? errResult(_failures(transport.id ?? 'transport')('failed:send', `The transport threw on "${cmd.action}".`, { action: cmd.action, cause: e }));
}

/**
 * A sent success handed to the action's `answer`, then each store state its
 * reply named, a fact on the stores' lane. An `Accepted` is not the final
 * state: both apply when its `done` settles ok, with its value (`later`).
 */
function answered(s: AsyncState, cmd: Command, res: CommandResult): CommandResult {
  if (!res.ok || !_appliedRemotely.has(cmd)) return res;
  if (res.value instanceof Accepted) return later(s, cmd, res as CommandResult & { value: Accepted });
  const stores = _appliedRemotely.get(cmd);
  try {
    s.answers.get(cmd.action)?.(cmd, res.value);
    const lane = s.stores.lane;
    if (stores && lane !== null) for (const id of Object.keys(stores)) lane.emit(id, { cmd, state: stores[id] });
  } catch (e) { return errResult(e as Error); }
  return res;
}

/**
 * A sent `Accepted`, applied when its `done` settles, as cache groups are
 * (declareGroups). The answer's `done` settles after the stores are written,
 * a throwing `answer` its failure. With no `answer` for the action and no
 * store on the bus, nothing is followed until the app reads `done`. The 202
 * path only. tests/accepted-applies-on-done.test.ts.
 */
function later(s: AsyncState, cmd: Command, res: CommandResult & { value: Accepted }): CommandResult {
  if (!s.answers.has(cmd.action) && s.stores.lane === null) return res;
  const applied = res.value.done.then((r: CommandResult) => answered(s, cmd, r));
  return okResult(new Accepted(() => applied));
}

/** Run a built Command: the body every async dispatch shares. */
async function _asyncRun(s: AsyncState, depth: number, cmd: Command, executeOverride?: (cmd: Command) => Promise<CommandResult>): Promise<CommandResult> {
  const action = cmd.action;
  const signal = cmd.signal;
  if (s.opts.naming !== undefined) validateNaming(action, s.opts.naming);
  // The action's facts, one read for the whole dispatch (ActionRecord).
  const rec = recordOf(s, action);

  // Pre-flight abort: if the signal is already tripped, skip the handler entirely.
  // After-hooks still run so loggers / metrics see the aborted command.
  if (signal?.aborted) {
    const result = abortedResult(action, signal);
    const h = asyncRunHooks(s, cmd, result, depth);
    if (h) await h;
    return result;
  }

  // Note: a bare-bus fast path was tested for async dispatch and showed no
  // measurable win (v1.2.0: 3,586 -> 3,360 ops/sec across 3 runs - within noise, may
  // be a slight regression). The async path's await + Promise machinery is
  // a larger fraction of the per-call cost than the runner indirection, so
  // skipping the runner doesn't move the needle. Sync dispatch DID win
  // (+18%) so the same fast path is kept in `_syncDispatchInner`.

  // A buffer holds a dispatch with no handler yet WITHOUT running the pipeline
  // (plugins/hooks/listeners fire on replay, not now). Skipped for request/respond.
  // A command a transport carries has somewhere to run: never held.
  if (executeOverride === undefined && s.opts.buffer !== undefined && rec.handler === undefined && rec.transport === undefined) {
    return handleMissing(s, cmd, true);
  }

  // Each user call runs at this dispatch's depth (see asyncDispatch): after
  // an await, `dispatchDepth` holds whatever was running when it resumed.
  // The start, before the rules: a rule's refusal settles a started command.
  if (s.facts !== null) s.facts.started(cmd);
  // The action's rules, before every plugin, a turn, the shown change and the
  // work: a refused command is never applied (PluginParts.authorize).
  if (rec.rules !== null) {
    let refused = asyncRefused(s, rec, depth, cmd);
    if (refused !== undefined && typeof (refused as PromiseLike<unknown>).then === 'function') refused = await refused;
    if (refused !== undefined) {
      const h = asyncRunHooks(s, cmd, refused as CommandResult, depth);
      if (h) await h;
      return refused as CommandResult;
    }
  }
  // An action registered `optimistic` or `exclusive` runs apart, in its own
  // function, so this body keeps its one runner call; every other action pays
  // one read.
  const declared = rec.declared;
  if (declared !== undefined && executeOverride === undefined) {
    return declared.optimistic ? optimisticRun(s, depth, cmd, declared.exclusive, rec) : exclusiveRun(s, depth, cmd, declared.exclusive as Exclusive, true, rec);
  }
  // The work: request()'s responder (the call's own answer), else the action's
  // transport, else its local handler. request() hands its responder the
  // dispatch's own command, as the sync bus does.
  // Settle, then re-throw - the async side of syncRunSettling. This function
  // is already async (it awaits a rule's answer), so it gains no frame and no
  // promise for it.
  let result: CommandResult;
  try {
    const at = s.dispatchDepth;
    s.dispatchDepth = depth;
    let p: CommandResult | Promise<CommandResult>;
    try { p = asyncWork(s, rec, cmd, true, executeOverride && ((): Promise<CommandResult> => executeOverride(cmd))); }
    finally { s.dispatchDepth = at; }
    result = await p;
    if (executeOverride === undefined) {
      const ended = retried(s, rec, cmd, result, true);
      if (ended !== result) result = await ended;
    }
  }
  catch (e) { const h = asyncRunHooks(s, cmd, errResult(e as Error), depth); if (h) await h; throw e; }
  const h = asyncRunHooks(s, cmd, result, depth);
  if (h) await h;
  return result;
}

/**
 * The async bus's work behind the action's steps (PluginParts.reuse): the
 * retry and the work, or the steps around them, once. With no steps and no
 * `execute` (request()'s responder) the work is called itself and the caller
 * hands its result to `retried`: no thunk and no `.then` on a success
 * (tests/retry-happy-path.test.ts). A thunk is built only for steps or a
 * responder (V8-RULES 4).
 */
function asyncWork(s: AsyncState, rec: ActionRecord, cmd: Command, dispatching: boolean, execute?: () => CommandResult | Promise<CommandResult>): CommandResult | Promise<CommandResult> {
  const list = rec.steps;
  const retry = s.retry;
  if (list === null && execute === undefined) {
    if (retry !== null) retry.begin(cmd);
    return work(s, rec, cmd, dispatching);
  }
  const call = execute ?? ((): CommandResult | Promise<CommandResult> => work(s, rec, cmd, dispatching));
  if (list === null) return retry === null ? call() : retry.run(cmd, call);
  return _stepped(list, cmd, (): CommandResult | Promise<CommandResult> => (retry === null ? call() : retry.run(cmd, call)));
}

/** A no-step result through the retry's rule (asyncWork): itself on a success, a promise of the re-sends on a failure. */
function retried(s: AsyncState, rec: ActionRecord, cmd: Command, result: CommandResult, dispatching: boolean): CommandResult | Promise<CommandResult> {
  const retry = s.retry;
  return retry === null || rec.steps !== null ? result : retry.end(result, cmd, s, rec, dispatching);
}

/** The async bus's refusal of `cmd` by its action's rules, run at the dispatch's depth (a rule may dispatch), or undefined. */
function asyncRefused(s: AsyncState, rec: ActionRecord, depth: number, cmd: Command): CommandResult | Promise<CommandResult | undefined> | undefined {
  const list = rec.rules!;
  const at = s.dispatchDepth;
  s.dispatchDepth = depth;
  try { return _refusal(list, cmd); }
  finally { s.dispatchDepth = at; }
}

/** A key's turn (`RegisterOptions.exclusive`): `entered` settles when the earlier holders are done, `leave` frees it. */
type Turn = { entered: Promise<void>; leave: () => void };

/**
 * Take `key`'s turn now, in dispatch order: on this bus (the scheduler's
 * lanes, made by the first such command), or across tabs through Web Locks
 * where `scope` asks and the API is there. A lock request that fails lets
 * the command go: it is not stalled.
 */
function enterTurn(s: AsyncState, key: string, lane: Exclusive): Turn {
  let open!: () => void;
  const entered = new Promise<void>((r) => { open = r; });
  let leave!: () => void;
  const left = new Promise<void>((r) => { leave = r; });
  const hold = (): Promise<void> => { open(); return left; };
  if (lane.scope === 'cross-tab') {
    // Read when the command runs, so a page that gains the API is seen.
    const locks = (globalThis as { navigator?: { locks?: { request?: (name: string, fn: () => Promise<void>) => Promise<void> } } }).navigator?.locks;
    if (typeof locks?.request === 'function') {
      locks.request(`${lane.lockPrefix ?? 'vapor-chamber:exclusive'}:${key}`, hold).then(undefined, open);
      return { entered, leave };
    }
  }
  void (s.lanes ??= createLanes()).run(key, hold);
  return { entered, leave };
}

/** `cmd`'s key under `exclusive`: the action by default, null to run at once. */
function keyOf(cmd: Command, lane: Exclusive): string | null {
  const raw = lane.key ? lane.key(cmd) : cmd.action;
  return raw == null ? null : String(raw);
}

/** `fn` at a dispatch's depth: the work that waited for its turn runs nested as the dispatch's own. */
function atDepth<T>(s: AsyncState, depth: number, fn: () => T): T {
  const at = s.dispatchDepth;
  s.dispatchDepth = depth;
  try { return fn(); }
  finally { s.dispatchDepth = at; }
}

/**
 * An `exclusive` action's dispatch or query, past its rules. Its turn
 * is taken now; the plugins run at once, and the work (with every retry)
 * waits for the turn, which is freed when the dispatch settles. So a refusal
 * never queues, and a retried command keeps its turn. Its own function, so
 * the common run keeps its one runner call. A key that throws fails the
 * dispatch alone. tests/register-exclusive.test.ts.
 */
async function exclusiveRun(s: AsyncState, depth: number, cmd: Command, lane: Exclusive, dispatching: boolean, rec: ActionRecord): Promise<CommandResult> {
  let result: CommandResult;
  let turn: Turn | undefined;
  try {
    const key = keyOf(cmd, lane);
    turn = key === null ? undefined : enterTurn(s, key, lane);
  } catch (e) {
    result = errResult(e as Error);
    const h = asyncRunHooks(s, cmd, result, depth);
    if (h) await h;
    return result;
  }
  const entered = turn?.entered;
  const execute = entered === undefined
    ? (): CommandResult | Promise<CommandResult> => work(s, rec, cmd, dispatching)
    : (): CommandResult | Promise<CommandResult> => entered.then(() => atDepth(s, depth, () => work(s, rec, cmd, dispatching)));
  // Nothing escapes the work here: a declaration leaves with its handler, so
  // onMissing's throw cannot reach a declared action (B4 f).
  // tests/register-exclusive.test.ts.
  result = await atDepth(s, depth, () => asyncWork(s, rec, cmd, dispatching, execute));
  turn?.leave();
  const h = asyncRunHooks(s, cmd, result, depth);
  if (h) await h;
  return result;
}

/**
 * An `optimistic` action's run: the plugins and the work as any dispatch's,
 * answered at once with an `Accepted`. For an action a transport sends, its
 * local handler is the change shown: it runs when the plugins hand on, before
 * any turn (`exclusive`) is waited for, so the change shows at dispatch, and
 * it is the transport's local fallback, never run twice. When the result
 * lands, a failure runs the undo (nested under this dispatch), then the
 * after-hooks and listeners hear the result, and `done` settles with it. A
 * plugin's refusal ran nothing, so nothing is shown or undone.
 * tests/register-optimistic.test.ts, tests/store-optimistic.test.ts.
 */
function optimisticRun(s: AsyncState, depth: number, cmd: Command, lane: Exclusive | undefined, rec: ActionRecord): CommandResult {
  let ran = false;
  let turn: Turn | undefined;
  let shown: Promise<CommandResult> | undefined;
  const transport = rec.transport;
  let p: Promise<CommandResult>;
  try {
    const key = lane === undefined ? null : keyOf(cmd, lane);
    if (key !== null) turn = enterTurn(s, key, lane as Exclusive);
    const entered = turn?.entered;
    // An optimistic action always has its handler, so with a transport the
    // change is shown (below) before the send, and is its local fallback.
    const go = (): Promise<CommandResult> => transport === undefined
      ? runLocal(s, rec, cmd, true)
      : send(transport, cmd, () => shown as Promise<CommandResult>, s);
    const execute = (): Promise<CommandResult> => {
      if (!ran) {
        ran = true;
        if (transport !== undefined) shown = runLocal(s, rec, cmd, true);
      }
      return entered === undefined ? go() : entered.then(() => atDepth(s, depth, go));
    };
    p = Promise.resolve(atDepth(s, depth, () => asyncWork(s, rec, cmd, true, execute)));
  } catch (e) { p = Promise.reject(e); }
  const done = p.then(undefined, (e: unknown) => errResult(e as Error)).then(async (r) => {
    turn?.leave();
    if (!r.ok && ran) {
      const u = await atDepth(s, depth, () => asyncDispatch(s, cmd.action + '$undo', cmd));
      if (!u.ok) _report('error', 'core:failed:undo', `the undo of "${cmd.action}" failed after its failure`, u.error, { action: cmd.action });
    }
    const h = asyncRunHooks(s, cmd, r, depth);
    if (h) await h;
    return r;
  });
  return okResult(new Accepted(() => done));
}

/**
 * Async read-only query - runs the rules, the steps and the handler, fires
 * afterHooks.
 *
 * One function, not a wrapper. This one was not merely free indirection: the
 * wrapper was itself `async` and its whole body was `return await inner(...)`,
 * so every query allocated a second promise and resumed a second async frame -
 * one extra microtask turn per query, on top of the awaits it actually needs.
 * It nests like `dispatch` (see asyncDispatch), with the guard inside: the
 * first stretch of an async function runs synchronously in the caller, so
 * the depth it reads there is its parent's.
 */
async function asyncQuery(s: AsyncState, action: string, target: any, payload?: any): Promise<CommandResult> {
  const depth = s.dispatchDepth + 1;
  if (depth > MAX_DISPATCH_DEPTH) return maxDepthResult(action);
  if (s.opts.naming !== undefined) validateNaming(action, s.opts.naming);
  const cmd: Command = { action, target, payload, meta: stampMeta(payload), signal: undefined };
  const rec = recordOf(s, action);
  if (s.facts !== null) s.facts.queried(cmd);
  // The action's rules answer a query too: they are the command's own.
  if (rec.rules !== null) {
    let refused = asyncRefused(s, rec, depth, cmd);
    if (refused !== undefined && typeof (refused as PromiseLike<unknown>).then === 'function') refused = await refused;
    if (refused !== undefined) {
      const h = asyncRunHooks(s, cmd, refused as CommandResult, depth);
      if (h) await h;
      return refused as CommandResult;
    }
  }
  // A query of an `exclusive` action waits for its key too, run apart.
  const lane = rec.declared?.exclusive;
  if (lane !== undefined) return exclusiveRun(s, depth, cmd, lane, false, rec);
  const at = s.dispatchDepth;
  s.dispatchDepth = depth;
  let p: CommandResult | Promise<CommandResult>;
  try { p = asyncWork(s, rec, cmd, false); }
  finally { s.dispatchDepth = at; }
  let result = await p;
  const ended = retried(s, rec, cmd, result, false);
  if (ended !== result) result = await ended;
  const h = asyncRunHooks(s, cmd, result, depth);
  if (h) await h;
  return result;
}

/** Async emit - notifies on() listeners, no handler required, no result. */
function asyncEmit(s: AsyncState, event: string, data?: any): void {
  // Same fast path + minimal-allocation strategy as syncEmit. See that
  // function's comment block for the full reasoning.
  if (!s.exactListeners.has(event) && s.wildcardListeners.length === 0) return;
  const cmd: Command = { action: event, target: data };
  fanOutListeners(s.exactListeners, s.wildcardListeners, event, cmd, EMIT_RESULT);
}

async function asyncDispatchBatch(s: AsyncState, commands: BatchCommand[], opts: BatchOptions = {}): Promise<BatchResult> {
  warnBatchOptionConflict(opts);
  const signal = opts.signal;
  const results: CommandResult[] = [];
  const ran: Command[] = [];
  let firstError: Error | undefined;
  let failCount = 0;

  // Pre-flight abort - return without dispatching anything.
  if (signal?.aborted) {
    const abortErr = abortedResult('batch', signal).error!;
    return { ok: false, results: [], error: abortErr, successCount: 0, failCount: 0 };
  }

  for (let ci = 0; ci < commands.length; ci++) {
    // Mid-flight abort - stop dispatching further commands. Already-completed
    // results are kept for inspection; abortError is the result error.
    if (signal?.aborted) {
      const abortErr = abortedResult('batch', signal).error!;
      const successCount = results.length - failCount;
      if (opts.transactional && successCount > 0) {
        const rollbacks = await asyncRollback(s, ran, results.length);
        return { ok: false, results, error: abortErr, successCount: 0, failCount, rollbacks };
      }
      return { ok: false, results, error: abortErr, successCount, failCount };
    }

    const { action, target, payload } = commands[ci];
    // Per-command signal flows through dispatch so individual handlers can observe abort.
    const cmd: Command = { action, target, payload, meta: stampMeta(payload), signal };
    ran.push(cmd);
    const result = await asyncDispatchCommand(s, cmd);
    results.push(result);
    if (!result.ok) {
      failCount++;
      if (opts.transactional) {
        const rollbacks = await asyncRollback(s, ran, ci);
        return { ok: false, results, error: result.error, successCount: ci, failCount: 1, rollbacks };
      }
      if (!opts.continueOnError) return { ok: false, results, error: result.error, successCount: results.length - failCount, failCount };
      if (!firstError) firstError = result.error;
    }
  }
  const successCount = results.length - failCount;
  return firstError ? { ok: false, results, error: firstError, successCount, failCount } : { ok: true, results, successCount, failCount };
}

/** Async rollback: commands 0..failedAt-1 in reverse order, all succeeded (a transactional batch stops at its first failure). */
async function asyncRollback(s: AsyncState, ran: Command[], failedAt: number): Promise<CommandResult[]> {
  const rollbacks: CommandResult[] = [];
  for (let j = failedAt - 1; j >= 0; j--) {
    if (!s.undoHandlers.has(ran[j].action)) continue;
    rollbacks.push(await _undo({ dispatch: (a, t) => asyncDispatch(s, a, t) }, ran[j]));
  }
  return rollbacks;
}



/**
 * A request in flight that identical callers join: its dispatch, and the
 * controller the responder reads on cmd.signal (when the first caller gave a
 * signal), aborted once every caller holding the request has aborted. A
 * caller with no signal holds it until it lands (`live` Infinity).
 */
type SharedRequest = { done: Promise<CommandResult>; ctrl: AbortController | undefined; live: number };

async function asyncRequest(s: AsyncState, action: string, target: any, payload?: any, reqOpts: { timeout?: number; signal?: AbortSignal } = {}): Promise<CommandResult> {
  const signal = reqOpts.signal;

  // Pre-flight abort - return immediately, don't dedup or dispatch.
  if (signal?.aborted) return abortedResult(action, signal);

  // Dedup key - the canonical commandKey: order-independent and nested-faithful,
  // so the same logical request collapses regardless of key order while distinct
  // nested targets stay separate (no false-dedup). Shared with pace and the cache.
  // Identical means the payload too, when one is given: two payloads are two
  // requests (tests/request-join.test.ts).
  const dedupKey = commandKey(action, payload === undefined ? target : [target, payload]);

  // Join an identical request in flight, unless every caller holding it has
  // aborted; else start one. Its responder is the dispatch's work and
  // receives the dispatch's own command.
  let run = s.pendingRequests.get(dedupKey);
  if (run && !run.ctrl?.signal.aborted) run.live += signal ? 1 : Infinity;
  else {
    const responder = s.responders.get(action);
    const executeOverride = responder ? async (cmd: Command): Promise<CommandResult> => {
      try { return okResult(await responder(cmd)); }
      catch (e) { return errResult(e as Error); }
    } : undefined;
    const ctrl = signal ? new AbortController() : undefined;
    const started: SharedRequest = { done: asyncDispatch(s, action, target, payload, executeOverride, ctrl?.signal), ctrl, live: signal ? 1 : Infinity };
    // Removed only if it is still this request's: a later one may own the key.
    started.done.then(() => { if (s.pendingRequests.get(dedupKey) === started) s.pendingRequests.delete(dedupKey); });
    s.pendingRequests.set(dedupKey, started);
    run = started;
  }
  const shared = run;

  // Each caller's own promise, as on the sync bus: the dispatch, its timer,
  // its abort and dispose() (see AsyncState.waiting) all call done(), and the
  // first one wins. Its signal cancels its promise, never another caller's
  // (the HTTP client's dedupe rule).
  const timeout = requestTimeout(reqOpts.timeout);
  const pending = (s.waiting ||= new Set());
  return new Promise<CommandResult>((resolve) => {
    const done = (r: CommandResult): void => {
      clearTimeout(timeoutId);
      pending.delete(cancel);
      signal?.removeEventListener('abort', onAbort);
      resolve(r);
    };
    const cancel = (): void => done(abortedResult(action, signal));
    const onAbort = (): void => {
      cancel();
      if (--shared.live === 0) shared.ctrl?.abort(signal!.reason);
    };
    const timeoutId = setTimeout(() => done(requestTimeoutResult(action, timeout)), timeout);
    pending.add(cancel);
    signal?.addEventListener('abort', onAbort);
    shared.done.then(done);
  });
}


function asyncClear(s: AsyncState): void {
  clearState(s);
  s.pendingRequests.clear();
  s.stores.entries.clear();
  s.stores.lane?.clear();
}

/**
 * The bus's `transport` option as patterns: one transport is every action's
 * (`*`). With an outbox, an action resolves through its `adapt`, once.
 */
function declaredTransports(option: AsyncCommandBusOptions['transport'], outbox?: BusOutbox): Pick<AsyncState, 'transports' | 'transportFor'> {
  if (option === undefined) return { transports: [], transportFor: null };
  const map = typeof (option as Transport).send === 'function' ? { '*': option as Transport } : option as Readonly<Record<string, Transport>>;
  return {
    transports: Object.keys(map).map((pattern) => ({ pattern, transport: map[pattern] })),
    // A `$` action is the library's: handled locally, never sent (library-names.ts).
    transportFor: mostSpecific(map, _isLibraryAction, outbox?.adapt),
  };
}

/**
 * @internal A record as the command its replay sends: stamped as a
 * dispatch's, carrying the record's key and origin 'replay'.
 */
export function _replayOf(action: string, target: unknown, payload: unknown, key: string): Command {
  const cmd: Command = { action, target, payload, meta: stampMeta(payload), signal: undefined };
  _recordKeyed(cmd, key);
  cmd.meta!.origin = 'replay';
  return cmd;
}

/**
 * @internal The async bus's send of an outbox record (outbox.ts): the replay
 * through the action's transport `unwrap` gives (the outbox's wrapper's inner
 * one) at the work step (`send`, `answered`), else its local handler. Not
 * dispatched. `bus` is the state the bus handed the outbox.
 */
export function _sendAt(bus: unknown, unwrap: (t: Transport) => Transport, action: string, target: unknown, payload: unknown, key: string): Promise<CommandResult> {
  const s = bus as AsyncState;
  const cmd = _replayOf(action, target, payload, key);
  const rec = recordOf(s, action);
  const t = rec.transport;
  return t === undefined ? runLocal(s, rec, cmd, true) : send(unwrap(t), cmd, () => runLocal(s, rec, cmd, true), s);
}

/**
 * Each declared transport once, however many patterns name it, given the
 * bus (`Transport.attach`). At creation only, the test bus's too. The push
 * applier stays with the transports that read pushes, so a bundle of
 * transports that read none never carries it.
 */
function attachTransports(bus: BaseBus, transports: AsyncState['transports']): void {
  for (const t of new Set(transports.map((e) => e.transport))) t.attach?.(bus);
}

// ---------------------------------------------------------------------------
// createAsyncCommandBus
// ---------------------------------------------------------------------------

/**
 * Create an asynchronous command bus. Handlers return Promises.
 *
 * @example
 * const bus = createAsyncCommandBus();
 * bus.register('user/fetch', async (cmd) => {
 *   const user = await fetch(`/api/users/${cmd.target.id}`).then(r => r.json());
 *   return user;
 * });
 * const result = await bus.dispatch('user/fetch', { id: 42 });
 * if (result.ok) console.log(result.value); // { name: 'Alice', ... }
 */
export function createAsyncCommandBus<M extends CommandMap = CommandMap>(options: AsyncCommandBusOptions = {}): AsyncCommandBus<M> {
  const retry = options.retry === false ? null : createRetrier(options.retry ?? {});
  const answers: AsyncState['answers'] = new Map();
  const stores: BusStores = { entries: new Map(), lane: null };
  const outbox = options.outbox?.[_OUTBOX];
  const s: AsyncState = {
    ...declaredTransports(options.transport, outbox),
    opts: options,
    handlers: new Map(), undoHandlers: new Map(), answers, declared: new Map(), lanes: null, locals: new Map(),
    plugins: [], afterHooks: [],
    exactListeners: new Map(), wildcardListeners: [],
    responders: new Map(),
    pendingRequests: new Map(),
    steps: null,
    records: new Map(),
    owners: new Map(), held: null,
    retry,
    stores,
    dispatchDepth: 0,
    sealed: false,
    waiting: null,
    facts: null,
    rules: null,
  };
  const bus: AsyncCommandBus<M> = {
    dispatch:          (a, t, p, o)  => asyncDispatch(s, a as string, t, p, undefined, o?.signal),
    query:             (a, t, p)     => asyncQuery(s, a as string, t, p),
    emit:              (e, d)        => asyncEmit(s, e, d),
    dispatchBatch:     (cmds, o)     => asyncDispatchBatch(s, cmds, o),
    register:          (a, h, o)     => register(s, a as string, h as AsyncHandler, o),
    use:               (p)           => usePlugin(s, p, bus),
    request:           (a, t, p, o)  => asyncRequest(s, a as string, t, p, o),
    ...busParts(s, asyncClear),
  };
  _busStores.set(bus, stores);
  const sendsFor = s.transportFor;
  if (sendsFor !== null) _sendsOn.set(bus, (action) => sendsFor(action) !== undefined);
  attachTransports(bus, s.transports);
  outbox?.attach(s);
  options.buffer?.[_BUFFER].attach(bus);
  return bus;
}

// ---------------------------------------------------------------------------
// unsealBus - dev/HMR only, tree-shakeable in production
// ---------------------------------------------------------------------------

/**
 * Unseal a sealed bus. **Dev/HMR only** - if your production code never imports
 * `unsealBus`, it gets tree-shaken out entirely, making `seal()` irreversible.
 *
 * @example
 * // vite-hmr.ts
 * import { unsealBus } from 'vapor-chamber';
 * if (import.meta.hot) {
 *   unsealBus(bus);
 *   bus.clear();
 *   // re-register handlers...
 *   bus.seal();
 * }
 */
export function unsealBus(bus: BaseBus): void {
  const fn = (bus as any)[_UNSEAL];
  if (typeof fn === 'function') fn();
}

/**
 * @internal Install the library's own observer past the seal. `seal()` protects the
 * handler/plugin topology, not the observation layer, so the bus is sealed
 * again before this returns. tests/composables-sealed-bus.test.ts.
 */
export function _pastSeal<T>(bus: BaseBus, install: () => T): T {
  const sealed = bus.isSealed();
  if (sealed) unsealBus(bus);
  try { return install(); }
  finally { if (sealed) bus.seal(); }
}

/**
 * @internal True for a bus made by createCommandBus, whose dispatches settle
 * in LIFO order. False for createAsyncCommandBus's, and for any bus this module
 * did not make (no state to read), since its order is unknown. Reads the state
 * `_INSPECT` carries, so inspect() stays out of a consumer that calls this.
 */
export function _isSyncBus(bus: BaseBus): boolean {
  const s = (bus as any)[_INSPECT];
  return s !== undefined && !('pendingRequests' in s);
}

/** @internal True for a bus `createAsyncCommandBus` made. */
export function _isAsyncBus(bus: BaseBus): boolean {
  const s = (bus as any)[_INSPECT];
  return s !== undefined && 'pendingRequests' in s;
}

/**
 * @internal False for an async bus that cannot reject: one that declares
 * neither `onMissing: 'throw'` nor a naming rule with `onViolation: 'throw'`,
 * both fixed at creation. True for any other bus. tests/usecommand-settles.test.ts.
 */
export function _mayReject(bus: BaseBus): boolean {
  const s = (bus as any)[_INSPECT];
  return s === undefined || !('pendingRequests' in s) || s.opts.onMissing === 'throw' || s.opts.naming?.onViolation === 'throw';
}

/**
 * @internal A transport's own outbox (a `wsTransport`'s) on the bus that
 * declares the transport, from `Transport.attach`: on an async bus its
 * replays are sent at that bus's work step. False on any other bus (the test
 * bus), where the transport sends them itself.
 */
export function _outboxOn(bus: BaseBus, outbox: BusOutbox): boolean {
  const s = (bus as any)[_INSPECT];
  if (s === undefined || !('pendingRequests' in s)) return false;
  outbox.attach(s);
  return true;
}

/**
 * @internal What sets `bus`'s facts observer: the `facts` slot of a bus this
 * module made, the test bus's own `[_FACTS]`, else undefined (a bus this
 * library did not make). Read once, when a command state is made.
 */
export function _factsSetter(bus: BaseBus): ((facts: Facts | null) => void) | undefined {
  const s = (bus as any)[_INSPECT] as SyncState | AsyncState | undefined;
  if (s !== undefined) return (facts) => { _ownFacts.set(s, facts); recompose(s); };
  const set = (bus as { [_FACTS]?: (facts: Facts | null) => void })[_FACTS];
  return typeof set === 'function' ? set : undefined;
}

/** @internal A transport can send again (a socket opened): the bus's outbox flushes what it holds. */
export function _opened(bus: BaseBus): void {
  ((bus as any)[_INSPECT]?.opts as AsyncCommandBusOptions | undefined)?.outbox?.[_OUTBOX].opened();
}

// ---------------------------------------------------------------------------
// inspectBus - dev/debug only, tree-shakeable in production
// ---------------------------------------------------------------------------

/**
 * Complete snapshot of a bus's internal topology.
 * Returned by `inspectBus()` for debugging, DevTools, and ops diagnostics.
 *
 * @example
 * import { inspectBus } from 'vapor-chamber';
 * const info = inspectBus(bus);
 * console.log(info.actions);        // ['cartAdd', 'cartRemove']
 * console.log(info.undoActions);     // ['cartAdd'] - only these can rollback
 * console.log(info.pluginCount);     // 3
 * console.log(info.sealed);          // true
 */
export type BusInspection = {
  /** All registered action names. */
  actions: string[];
  /** Actions that have undo handlers registered. */
  undoActions: string[];
  /** Actions that have respond() handlers registered. */
  responderActions: string[];
  /** Number of installed plugins. */
  pluginCount: number;
  /** The installed plugins in install order, each as it declares itself. */
  plugins: PluginInspection[];
  /** The transports declared at the bus, by pattern, as written; empty on a sync bus. */
  transports: Array<{ pattern: string; id: string }>;
  /** Number of afterHooks. */
  afterHookCount: number;
  /** Pattern listeners: each entry is the pattern string. */
  listenerPatterns: string[];
  /** Whether the bus is sealed. */
  sealed: boolean;
  /** Current nested dispatch depth (0 when idle). */
  dispatchDepth: number;
};

/**
 * One installed plugin in `BusInspection.plugins`: what it declares, never its
 * function. `id` is its declared id (`undefined` when it declares none, never
 * `Function.name`, which a minifier renames). `actions` is a copy of its
 * `actions` scope. `actionFilter` says whether it has one: a function is not
 * serializable.
 */
export type PluginInspection = {
  id: string | undefined;
  actions: string[] | undefined;
  actionFilter: boolean;
  /** The parts it declares, in the order the bus runs them. */
  parts: string[];
};

// The parts `use()` places, in the order the bus runs them: facts, rules, steps, then attach.
const PARTS = ['started', 'settled', 'authorize', 'validate', 'reuse', 'admit', 'begin', 'attach'] as const;
/** The parts `plugin` declares, in that order: inspect lists them, a part's throw report carries them. */
function _partsOf(plugin: PluginParts): string[] { return PARTS.filter((k) => typeof plugin[k] === 'function'); }

/**
 * @internal The installed plugins in install order, as `inspectBus` reports
 * them; the TestBus reports through it too, so the two cannot differ.
 * tests/inspect-plugins.test.ts.
 */
export function _inspectPlugins(plugins: readonly PluginParts[]): PluginInspection[] {
  return plugins.map((plugin) => ({
    id: plugin.id,
    actions: plugin.actions?.slice(),
    actionFilter: plugin.actionFilter !== undefined,
    parts: _partsOf(plugin),
  }));
}

/**
 * Inspect a bus's full topology. **Dev/debug only** - if your production code
 * never imports `inspectBus`, it gets tree-shaken out entirely.
 *
 * Returns a plain snapshot object - safe to serialize, log, or send to DevTools.
 *
 * @example
 * import { inspectBus } from 'vapor-chamber';
 * const info = inspectBus(bus);
 * console.table(info);
 *
 * // Check if all checkout actions have undo handlers
 * const missing = info.actions.filter(a => !a.includes('$') && !info.undoActions.includes(a)); // `$` names are the library's (`cartAdd$undo`)
 * if (missing.length) console.warn('Missing undo for:', missing);
 */
export function inspectBus(bus: BaseBus): BusInspection {
  const state = (bus as any)[_INSPECT];
  if (state) return inspect(state);
  // Fallback for TestBus or unknown implementations
  return {
    actions: bus.registeredActions(),
    undoActions: [],
    responderActions: [],
    pluginCount: 0,
    plugins: [],
    transports: [],
    afterHookCount: 0,
    listenerPatterns: [],
    sealed: bus.isSealed(),
    dispatchDepth: 0,
  };
}
