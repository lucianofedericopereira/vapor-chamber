/**
 * vapor-chamber - I/O plugins (async/storage/network)
 *
 * createChannel. Retry is the async bus's own (createAsyncCommandBus's
 * `retry` option). A store saves its own state (its `persist` option, src/store-persist.ts).
 */

import { DEV } from './dev';
import { _report } from './report';

// ---------------------------------------------------------------------------
// createChannel (BroadcastChannel over an event channel)
// ---------------------------------------------------------------------------

/**
 * The event channel `createChannel` reads. Structural on purpose: this module imports
 * nothing from `./fast-lane`, so a consumer who never syncs pays no bytes for
 * it, and anything with the same two methods can be bridged.
 */
export type ChannelLane = {
  on(event: string, listener: (data: any) => void): () => void;
  emit(event: string, data: any): void;
};

export type ChannelOptions = {
  /**
   * BroadcastChannel name. All tabs using the same name receive each other's facts.
   * @example 'vapor-chamber:app'
   */
  channel: string;
  /** The event channel to bridge - `createFastLane()`, or anything of that shape. */
  lane: ChannelLane;
  /**
   * Which events cross to the other tabs. Named rather than inferred: the fast
   * lane has no wildcard subscription by design, and naming them is the point
   * - the wire contract is declared, not guessed at from an action prefix.
   */
  events: string[];
  /**
   * Called when a fact arrives from another tab, before it is re-emitted
   * locally. Return false to drop it.
   */
  onReceive?: (event: string, data: unknown) => boolean | void;
};

type ChannelMessage = { __vc: true; event: string; data: any };

/**
 * createChannel - mirror emitted FACTS to every other same-origin context
 * over a BroadcastChannel.
 *
 * WHAT CROSSES THE WIRE IS A FACT, NOT A COMMAND, and that is the whole design.
 * Re-dispatching each command in the receiving tab replicates INTENT: each tab
 * re-runs the handler and re-derives the outcome. Three things fall out of
 * that, measured:
 *
 *   - A handler that is not deterministic does not mirror. Two tabs running
 *     the same `cartAdd` minted `A-line-1-936891` and `B-line-1-675288` and
 *     stayed different forever.
 *   - A tab seeded differently stays different: A ended at 1, B at 6.
 *   - A handler that dispatches a nested command applied that derivation
 *     TWICE per tab, because each tab derived its own and then received the
 *     peer's. Suppressing the receive side alone did not fix it (6 runs became
 *     5, not 4): the ORIGINATING tab was still broadcasting its derivations.
 *     Fixing that by inference needs the core to distinguish a root dispatch
 *     from a derived one, which it does not, and adding a counter to do so
 *     would tax every dispatch on the bus.
 *
 * Emitting the fact removes the question instead of answering it. The app says
 * what crosses by emitting it; a derivation is not a fact unless the app says
 * so, so there is nothing to infer and no counter to pay for. The receiving tab
 * APPLIES the values the sender computed rather than recomputing them, which is
 * the ordinary CQRS split - a command is intent, an event is something that
 * already happened - and it is what makes a non-deterministic handler a
 * non-issue.
 *
 * IT ALSO LEAVES THE DISPATCH CHAIN. As a plugin this cost more than half the
 * bus's dispatch throughput, on every dispatch of every action, whether or not
 * it synced. Measured for v1.22.0 over 11 shuffled rounds of 200,000 dispatches with
 * `gc()` per round, against a byte-identical self-control arm: bare bus 1.000,
 * as a plugin 0.459 (control 0.454), as an `onAfter` listener 0.538, and on the
 * fast lane 0.867. The correctness fix and the performance fix are the same
 * change.
 *
 * WHAT IT STILL DOES NOT DO. Facts mirror, seeds do not: a tab that starts from
 * different state stays different unless the facts are absolute ("the count is
 * 2") rather than relative ("add one"). And a payload crosses through the
 * structured clone algorithm, so it cannot carry functions - see the DEV
 * warning below.
 *
 * @example
 * const lane = createFastLane()
 * lane.on('cartAdded', (fact) => applyToCart(fact))   // local AND remote land here
 *
 * bus.register('cartAdd', (cmd) => {
 *   const fact = computeAdd(cmd.target)
 *   applyToCart(fact)
 *   lane.emit('cartAdded', fact)                      // this is what crosses tabs
 * })
 *
 * const tabSync = createChannel({ channel: 'vapor-chamber:app', lane, events: ['cartAdded'] })
 * tabSync.dispose() // on unmount
 */
export function createChannel(options: ChannelOptions): {
  /** Stops mirroring and closes the BroadcastChannel; `isOpen()` is then false. */
  dispose(): void;
  isOpen(): boolean;
} {
  const { channel, lane, events, onReceive } = options;

  let bc: BroadcastChannel | null = null;

  // Echo suppression is a plain boolean, and it is airtight: a lane `emit` is
  // a tight indexed loop over the subscriber list with no promise, no plugin
  // chain and no envelope, so it completes inside the `try`. (A flag around a
  // bus dispatch would not be: on the async bus the chain runs a microtask
  // after the `finally` has lowered it.)
  let applying = false;

  function open(): void {
    if (typeof BroadcastChannel === 'undefined') return;
    bc = new BroadcastChannel(channel);

    bc.onmessage = (event: MessageEvent<ChannelMessage>) => {
      const msg = event.data;
      if (!msg?.__vc) return;
      if (onReceive && onReceive(msg.event, msg.data) === false) return;
      applying = true;
      try { lane.emit(msg.event, msg.data); }
      finally { applying = false; }
    };
  }

  open();

  const offs: Array<() => void> = [];
  for (const name of events) {
    offs.push(lane.on(name, (data: unknown) => {
      if (applying) return;
      try {
        bc?.postMessage({ __vc: true, event: name, data } satisfies ChannelMessage);
      } catch (e) {
        // A payload that cannot be structured-cloned (a function, a DOM node)
        // throws DataCloneError here. A class instance does clone, as a plain
        // object without its methods (tests/browser/platform-facts.browser.test.ts).
        // The local tab has already applied its own fact by now, so this is a
        // remote-only failure and must not take the local emit down with it -
        // a listener that throws would stop the rest of the lane's fan-out.
        // DEV-gated, unlike persist's storage warnings: a non-cloneable payload
        // is an authoring mistake fixed at build time, not a condition a
        // deployed app runs into.
        if (DEV) {
          _report('warn', 'channel:invalid:clone', `"${name}" did not cross: its payload is not structured-cloneable (no functions or DOM nodes)`, e, { event: name });
        }
      }
    }));
  }

  return {
    dispose(): void {
      for (const off of offs) off();
      offs.length = 0;
      bc?.close();
      bc = null;
    },
    isOpen(): boolean { return bc !== null; },
  };
}
