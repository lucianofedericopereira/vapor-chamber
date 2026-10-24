/**
 * Accepted - an answer that is not the end: the work goes on, and `done`
 * settles with its final result.
 *
 * A server's 202 with a `Location` (RFC 9110 15.3.3) answers the dispatch
 * `{ ok: true, value }` with `value` an `Accepted`: the transport follows the
 * status monitor, waiting each `Retry-After`, and `done` settles with what the
 * monitor ends on. Nothing is followed until `done` is read. Cross-origin, the
 * backend lists `Location` and `Retry-After` in `Access-Control-Expose-Headers`.
 *
 * @example
 * const r = await bus.dispatch('reportExport', {});
 * if (r.value instanceof Accepted) {
 *   const end = await r.value.done; // { ok, value } or { ok: false, error }
 * }
 */
import type { CommandResult } from './command-bus';

export class Accepted {
  #start: () => Promise<CommandResult>;
  #done: Promise<CommandResult> | undefined;

  /** `start` runs once, at the first read of `done`. */
  constructor(start: () => Promise<CommandResult>) {
    this.#start = start;
    this.#done = undefined;
  }

  /** The final result. It never rejects: a failure is `{ ok: false, error }`. */
  get done(): Promise<CommandResult> {
    return (this.#done ??= this.#start());
  }
}
