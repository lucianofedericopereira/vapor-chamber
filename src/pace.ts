/**
 * vapor-chamber - pacing at the sender.
 *
 * `pace(send, { debounce })` or `pace(send, { throttle })` wraps a dispatch so
 * a burst of calls reaches the bus at the sender's rhythm. The bus never paces:
 * the input or the button knows its own rhythm (plan 1.32, the sender row).
 */

import { type Delay, delayOption } from './bounds';
import { _errResult, _failures, _isLibraryAction, commandKey, type CommandResult } from './command-bus';
import type { ResultOn } from './shared-bus';

const fail = _failures('pace');

/** How a sender paces its calls: one of the two, a wait in milliseconds. */
export type PaceOptions =
  | { debounce: number; throttle?: undefined }
  | { throttle: number; debounce?: undefined };

/** A dispatch, as the bus and the composables hand it out: `options.signal` cancels it. */
export type Send = (action: any, target?: any, payload?: any, options?: { signal?: AbortSignal }) => CommandResult | Promise<CommandResult>;

/** A paced dispatch: always a promise, plus `dispose()` for its timers. */
export type Paced = ((action: any, target?: any, payload?: any) => Promise<CommandResult>) & {
  /** Cancel the timers and abort the runs in flight. A waiting debounced call settles with `pace:aborted:dispatch`. */
  dispose(): void;
};

/** One send as a result: a throw, or a rejection, is a failed result. */
function run(send: Send, action: string, target: unknown, payload: unknown, signal?: AbortSignal): CommandResult | Promise<CommandResult> {
  let result: CommandResult | Promise<CommandResult>;
  try {
    result = signal === undefined ? send(action, target, payload) : send(action, target, payload, { signal });
  } catch (e) {
    return _errResult(e as Error);
  }
  return result && typeof (result as Promise<CommandResult>).then === 'function'
    ? (result as Promise<CommandResult>).then(undefined, rejected)
    : result;
}

const rejected = (e: Error): CommandResult => _errResult(e);

const superseded = (action: string): CommandResult =>
  _errResult(fail('aborted:dispatch', `"${action}" was superseded by a newer call before it ran.`, { action }));

/**
 * Latest wins: a run of a key aborts the run of that key still in flight
 * (its `signal`), so a stale answer settles aborted and never lands after a
 * newer one. One AbortController per run, on the paced path only.
 */
function latest(send: Send, inFlight: Map<string, AbortController>, key: string, action: string, target: unknown, payload: unknown): CommandResult | Promise<CommandResult> {
  inFlight.get(key)?.abort();
  const controller = new AbortController();
  inFlight.set(key, controller);
  const result = run(send, action, target, payload, controller.signal);
  if (!result || typeof (result as Promise<CommandResult>).then !== 'function') {
    inFlight.delete(key);
    return result;
  }
  return (result as Promise<CommandResult>).then((r) => {
    if (inFlight.get(key) === controller) inFlight.delete(key);
    return r;
  });
}

/** Abort every run in flight: the paced sender is disposed. */
function abortAll(inFlight: Map<string, AbortController>): void {
  for (const [, c] of inFlight) c.abort();
  inFlight.clear();
}

/**
 * pace - a dispatch paced at the sender, keyed by action and target
 * (`commandKey`, objects by value).
 *
 * - `debounce: ms` runs the latest call per key once `ms` pass with no newer
 *   one, and answers it with the real result. An earlier call of the burst
 *   answers `pace:aborted:dispatch` and never reaches the bus. Pass what
 *   changes on each call (the typed text) as the PAYLOAD: in the target, each
 *   value is its own key and nothing coalesces.
 * - `throttle: ms` runs the first call per key at once and answers a repeat
 *   inside `ms` with `pace:limited:dispatch` (`context.retryIn`, `wait`).
 *
 * Latest wins in both: a run of a key aborts that key's run still in flight
 * (`dispatch(..., { signal })`), so a stale answer settles aborted and never
 * lands after a newer one. `dispose()` aborts what is in flight.
 *
 * A `$` action (a reset, an undo) runs at once, unpaced. A paced call always
 * returns a promise, on either bus. NaN is no wait, one past the timer's
 * maximum the maximum. tests/pace.test.ts.
 *
 * @example
 * const search = pace(bus.dispatch, { debounce: 300 });
 * input.addEventListener('input', async () => {
 *   const r = await search('searchQuery', {}, input.value);
 *   if (r.ok) render(r.value);
 * });
 */
export function pace(send: Send, options: PaceOptions): Paced {
  return options.debounce !== undefined
    ? debounced(send, delayOption(options.debounce, 0))
    : throttled(send, delayOption(options.throttle, 0));
}

function debounced(send: Send, wait: Delay): Paced {
  // One entry per key: its timer and the waiting caller, replaced together.
  const waiting = new Map<string, { timer: ReturnType<typeof setTimeout>; settle: (r: CommandResult | Promise<CommandResult>) => void; action: string }>();
  const inFlight = new Map<string, AbortController>();
  const paced = ((action: string, target?: unknown, payload?: unknown): Promise<CommandResult> => {
    if (_isLibraryAction(action)) return Promise.resolve(run(send, action, target, payload));
    const key = commandKey(action, target);
    const prior = waiting.get(key);
    if (prior !== undefined) {
      clearTimeout(prior.timer);
      prior.settle(superseded(prior.action));
    }
    return new Promise<CommandResult>((settle) => {
      waiting.set(key, {
        settle,
        action,
        timer: setTimeout(() => {
          waiting.delete(key);
          settle(latest(send, inFlight, key, action, target, payload));
        }, wait),
      });
    });
  }) as Paced;
  paced.dispose = () => {
    for (const [, e] of waiting) {
      clearTimeout(e.timer);
      e.settle(superseded(e.action));
    }
    waiting.clear();
    abortAll(inFlight);
  };
  return paced;
}

function throttled(send: Send, wait: Delay): Paced {
  // When each key last ran; a timer forgets it once its window closes.
  const lastRun = new Map<string, number>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const inFlight = new Map<string, AbortController>();
  const paced = ((action: string, target?: unknown, payload?: unknown): Promise<CommandResult> => {
    if (_isLibraryAction(action)) return Promise.resolve(run(send, action, target, payload));
    const key = commandKey(action, target);
    const now = Date.now();
    const last = lastRun.get(key);
    if (last !== undefined && now - last < wait) {
      const retryIn = wait - (now - last);
      return Promise.resolve(_errResult(fail('limited:dispatch', `"${action}" throttled. Retry in ${retryIn}ms.`, { action, context: { retryIn, wait } })));
    }
    lastRun.set(key, now);
    const timer = setTimeout(() => { lastRun.delete(key); timers.delete(timer); }, wait);
    timers.add(timer);
    return Promise.resolve(latest(send, inFlight, key, action, target, payload));
  }) as Paced;
  paced.dispose = () => {
    for (const t of timers) clearTimeout(t);
    timers.clear();
    lastRun.clear();
    abortAll(inFlight);
  };
  return paced;
}

/** The pace options a composable takes beside its bus: one of the two, or neither. */
export type PaceOption<D extends number | undefined = undefined, T extends number | undefined = undefined> =
  | { debounce?: D; throttle?: undefined }
  | { throttle?: T; debounce?: undefined };

/** What a composable's dispatch returns: a promise once paced, else the bus's own kind. */
export type PacedOn<B, R, D, T> = [D] extends [number] ? Promise<R> : [T] extends [number] ? Promise<R> : ResultOn<B, R>;

/**
 * @internal The composables' one reader of their pace options: the options
 * `pace` takes, or `undefined` when neither is set (no wrapper, no read per call).
 */
export function _paceOf(options: { debounce?: number; throttle?: number } | undefined): PaceOptions | undefined {
  if (options === undefined) return undefined;
  const { debounce, throttle } = options;
  if (debounce !== undefined) return { debounce };
  return throttle !== undefined ? { throttle } : undefined;
}
