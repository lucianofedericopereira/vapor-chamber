/**
 * vapor-chamber - the failure every part of the library raises.
 *
 * `BusError`, its code vocabulary (`owner:condition:subject`, plan 4.1-4.2),
 * the owner-bound factory and the two readers. Its own module, free of the
 * bus, so a part that keeps the bus out of its graph on purpose (the router,
 * plan 8d) raises the same failure the core does: one shape for every failure
 * (plan settled item 2), one reader for all of them.
 */
import { DEV } from './dev';

/**
 * What went wrong, from a closed vocabulary the library owns (plan 4.2). The
 * retry policy and a logger read it; a receiver that has never seen a code
 * still knows its condition. `unauthenticated` and `conflict` are the two
 * distinctions gRPC's canonical codes draw that `refused` and `already` hid
 * (sign in, then retry; the state changed underneath); the 1:1 table against
 * gRPC is plan 4.2.
 */
export type Condition =
  | 'missing' | 'already' | 'conflict' | 'invalid' | 'refused' | 'unauthenticated'
  | 'limited' | 'timeout' | 'lost' | 'aborted' | 'exceeded' | 'failed' | 'unexpected' | 'unknown';
/** What a site passes: `condition:subject`. The owner is the wiring's (plan 4.5). */
export type FailCode = `${Condition}:${string}`;
/**
 * A whole code, `owner:condition:subject`: who raised it (set by the wiring,
 * never by the site), what went wrong, and what it is about.
 *
 * @example
 * if (result.error instanceof BusError) {
 *   switch (result.error.code) {
 *     case 'core:missing:handler':          // register a handler
 *     case 'core:refused:hook':             // a before-hook cancelled it
 *     case 'circuitBreaker:limited:action': // the circuit is open
 *   }
 * }
 */
export type BusErrorCode = `${string}:${Condition}:${string}`;
export type FailOptions = { action?: string; context?: Record<string, unknown>; cause?: unknown };
/** A failure factory bound to its owner. A party only ever holds its own. */
export type Fail = (code: FailCode, message: string, opts?: FailOptions) => BusError;

/**
 * BusError - a failure the library, a plugin or a transport raised.
 *
 * Extends native Error so it works everywhere errors work (catch, result.error).
 * `code` is `owner:condition:subject`; `ownerOf()` and `conditionOf()` read its
 * parts. Severity is not on it: whoever logs a failure decides how loud it is
 * (the catalogue's `severity` is the suggested level).
 *
 * @example
 * const result = bus.dispatch('missing', {});
 * if (!result.ok && result.error instanceof BusError) {
 *   console.log(result.error.code);           // 'core:missing:handler'
 *   console.log(conditionOf(result.error));   // 'missing'
 *   console.log(result.error.action);         // 'missing'
 * }
 */
// The owner the next BusError is minted for: a one-shot slot, the pattern of
// `_nextOrigin`. Only `_failures` writes it, so a constructor call anywhere
// else mints for 'app'.
let mintOwner = 'app';

/** A problem's `type`, plus its condition: one section of docs/errors.md each. */
const PROBLEM_TYPE = 'https://github.com/lucianofedericopereira/vapor-chamber/blob/main/docs/errors.md#';

export class BusError extends Error {
  // Private, so no holder can rewrite it: the owner is the wiring's, and the
  // condition (the retry verdict) is the raiser's. A private field is an
  // ordinary in-object slot to V8, so it costs what a plain field costs.
  #code: BusErrorCode;
  /** The action name involved (if applicable). */
  declare readonly action?: string;
  /** Every value the message carries, and whatever else a reader inspects. */
  declare readonly context?: Record<string, unknown>;

  constructor(code: FailCode, message: string, opts: FailOptions = {}) {
    const owner = mintOwner;
    mintOwner = 'app';
    // The type admits only `condition:subject`; plain JS can pass anything, and
    // a code outside the vocabulary gives `conditionOf` a condition that is not
    // one and the stack rule the wrong answer. DEV only, so the pattern folds
    // away with DEV in a production build.
    if (DEV && !/^(missing|already|conflict|invalid|refused|unauthenticated|limited|timeout|lost|aborted|exceeded|failed|unexpected|unknown):[^:]/.test(code)) {
      console.warn(`[vapor-chamber] BusError code "${code}" is not condition:subject from the condition vocabulary (missing, invalid, refused, limited, timeout, failed, ...); conditionOf() and the async bus's retry cannot read it.`);
    }
    // Only a bug (`failed`) keeps its stack. An expected refusal is control
    // flow, and V8's stack capture dominated its cost (plan settled item 4).
    const limit = (Error as any).stackTraceLimit;
    if (!code.startsWith('failed:')) (Error as any).stackTraceLimit = 0;
    // Restored right after, with no try/finally: Error's constructor cannot
    // throw here, and a `super()` inside `try` makes the compiler lower the
    // private field below into WeakMap helpers, even on an es2022 target.
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    (Error as any).stackTraceLimit = limit;
    this.#code = `${owner}:${code}`;
    this.action = opts.action;
    this.context = opts.context;
    this.name = 'BusError';
  }

  /** `owner:condition:subject`, read-only. */
  get code(): BusErrorCode { return this.#code; }

  /**
   * The failure as an RFC 9457 problem, with the members it needs (plan
   * settled item 3): `type`, `detail`, and `code`, `action` and the context as
   * extensions. `type` names the condition, a URI that resolves to its section
   * of docs/errors.md, because an RFC client identifies a problem by `type`
   * and ignores extensions it does not know (RFC 9457 3.1.1, 3.2); the exact
   * identity stays `code`. A backend's problem keeps the `type` it sent (its
   * own identity, read into `context` by the transports). No `title`: optional
   * in the RFC, and the summaries live in ERROR_CODE_REGISTRY, not in the
   * core. The transports' reader reads this shape back, so a failure crossing
   * a worker, a channel or storage has one shape both ways.
   * tests/problem-type.test.ts.
   */
  toJSON(): Record<string, unknown> {
    const own = this.code.startsWith('remote:') ? this.context?.type : undefined;
    return { ...this.context, type: own ?? PROBLEM_TYPE + this.code.split(':')[1], detail: this.message, code: this.code, action: this.action };
  }
}

/** @internal - a failure factory for `owner`. The bus hands each party its own. */
export const _failures = (owner: string): Fail => (code, message, opts) => {
  mintOwner = owner;
  return new BusError(code, message, opts);
};

/** The party that raised `e`, or `undefined` when `e` is not a BusError. */
export const ownerOf = (e: unknown): string | undefined =>
  e instanceof BusError ? e.code.slice(0, e.code.indexOf(':')) : undefined;

/** A failure's condition, or `undefined` for anything the library did not raise. */
export const conditionOf = (e: unknown): Condition | undefined =>
  e instanceof BusError ? (e.code.split(':')[1] as Condition) : undefined;

/**
 * The condition a status declares (the status table, plan 4.4), saying only
 * what RFC 9110 says of it, plus 419 (Laravel's expired CSRF token). Every
 * reader of a backend's answer maps a status through it, here beside the
 * failure so the http client reads it without the bus.
 * 401 and 419 are `unauthenticated` (a session or token to renew, then the
 * same request); 403 is `refused` (final). 409 Conflict and 412 Precondition
 * Failed are `conflict` (the target's state is not the one the request
 * assumed), not `already`.
 */
export function conditionOfStatus(status: number): Condition {
  if (status === 404 || status === 410) return 'missing';
  if (status === 409 || status === 412) return 'conflict';
  if (status === 401 || status === 419) return 'unauthenticated';
  if (status === 403) return 'refused';
  if (status === 429 || status === 503) return 'limited';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 501 || status === 502 || status === 505) return 'unexpected';
  return status >= 500 ? 'failed' : 'invalid';
}

/**
 * @internal - a party's own `failed` (a plugin that threw): a bug, which a
 * re-send would repeat and which says nothing about the other side. A
 * backend's (`remote`) is not one; neither is a raw throw from a handler.
 */
export const _isBug = (e: unknown): boolean => conditionOf(e) === 'failed' && !(e as BusError).code.startsWith('remote:');

/**
 * The one retry rule's reading of a failure (plan 4.4), for the bus and the
 * http client alike: `transient` (held back, or no reply in time) may be sent
 * again for any request; `uncertain` (the first attempt may have landed: no
 * reply, an off-protocol answer, a backend's own failure) only for one that is
 * safe to send twice; `final` (a verdict, an abort, a bound, a party's bug)
 * never. A declared `retryIn` is read by the caller, beside this. Log s35.131.
 */
export function retryClass(e: unknown, condition: Condition | undefined = conditionOf(e)): 'transient' | 'uncertain' | 'final' {
  if (condition === 'limited' || condition === 'timeout') return 'transient';
  if (condition === 'lost' || condition === 'unexpected' || condition === 'unknown') return 'uncertain';
  return condition === 'failed' && !_isBug(e) ? 'uncertain' : 'final';
}
