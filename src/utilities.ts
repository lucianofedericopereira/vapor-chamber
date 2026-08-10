/**
 * vapor-chamber — Utility layer
 *
 * createChamber, createWorkflow, createReaction
 *
 * These use only the public BaseBus interface. They are optional and tree-shaken.
 */

import { disposeAll, matchesPattern } from './command-bus';
import type { BaseBus, Command, CommandResult, Handler, RegisterOptions, } from './command-bus';

// ---------------------------------------------------------------------------
// createChamber — declarative namespace grouping
// ---------------------------------------------------------------------------

export type ChamberHandlers = Record<string, Handler>;
export type ChamberOptions = {
  /** Per-action registration options (undo, throttle). */
  options?: Record<string, RegisterOptions>;
};

export interface Chamber {
  /** Namespace prefix (e.g. 'cart'). */
  readonly namespace: string;
  /** Install all handlers on a bus. Returns uninstall function. */
  install(bus: BaseBus): () => void;
  /** Get the prefixed action name (e.g. 'add' → 'cartAdd'). */
  actionName(shortName: string): string;
}

/**
 * createChamber — groups related handlers under a namespace.
 * The declarative counterpart to `useCommandGroup`.
 *
 * @example
 * const cart = createChamber('cart', {
 *   add:    handleCartAdd,
 *   remove: handleCartRemove,
 *   clear:  handleCartClear,
 * });
 * const uninstall = cart.install(bus);
 * // Registers: cartAdd, cartRemove, cartClear
 */
export function createChamber(
  namespace: string,
  handlers: ChamberHandlers,
  opts: ChamberOptions = {},
): Chamber {
  // camelCase namespace join ('cart' + 'add' → 'cartAdd'). Inlined, NOT a shared
  // helper — DO NOT consolidate, settled, do not re-evaluate. The per-dispatch sites
  // (useCommandGroup / transitions) measured ~1% slower with a shared call; this site
  // is setup-only but stays inline for one consistent shape. Keep in sync.
  function actionName(shortName: string): string {
    return namespace + shortName.charAt(0).toUpperCase() + shortName.slice(1);
  }

  function install(bus: BaseBus): () => void {
    const unsubs: Array<() => void> = [];
    for (const [short, handler] of Object.entries(handlers)) {
      const action = actionName(short);
      const regOpts = opts.options?.[short];
      unsubs.push(bus.register(action, handler, regOpts));
    }
    return () => { disposeAll(unsubs); };
  }

  return { namespace, install, actionName };
}

// ---------------------------------------------------------------------------
// createWorkflow — sequential commands with compensation (saga pattern)
// ---------------------------------------------------------------------------

export type WorkflowStep = {
  /** Action name to dispatch. */
  action: string;
  /** If this step fails, dispatch this action to compensate previous steps. */
  compensate?: string;
  /** Map the workflow target/payload into step-specific target. */
  mapTarget?: (target: any, payload?: any) => any;
  /** Map the workflow target/payload into step-specific payload. */
  mapPayload?: (target: any, payload?: any) => any;
};

export type WorkflowResult = {
  ok: boolean;
  /** Results of each step that executed (in order). */
  results: CommandResult[];
  /** If failed, the step index that caused the failure. */
  failedAt?: number;
  /** Error from the failed step. */
  error?: Error;
  /** Results of compensation steps (in reverse order). */
  compensations?: CommandResult[];
};

export interface Workflow {
  /** Execute the workflow. Async because compensation may involve async buses. */
  run(bus: BaseBus, target: any, payload?: any): Promise<WorkflowResult>;
  /** The step definitions. */
  readonly steps: readonly WorkflowStep[];
}

/**
 * createWorkflow — sequential commands with automatic compensation on failure.
 *
 * @example
 * const checkout = createWorkflow([
 *   { action: 'cartValidate' },
 *   { action: 'paymentReserve', compensate: 'paymentRelease' },
 *   { action: 'orderCreate',    compensate: 'orderCancel' },
 *   { action: 'cartClear' },
 * ]);
 * const result = await checkout.run(bus, { cartId, paymentInfo });
 * // If orderCreate fails → paymentRelease runs automatically
 */
export function createWorkflow(steps: WorkflowStep[]): Workflow {
  async function run(bus: BaseBus, target: any, payload?: any): Promise<WorkflowResult> {
    const results: CommandResult[] = [];
    // The MAPPED target/payload are captured alongside the compensating action,
    // not just its name. Compensations used to dispatch with the workflow's
    // original arguments, so a step pairing `mapTarget`/`mapPayload` with
    // `compensate` — deriving an order id, addressing a sub-entity — was
    // compensated against something it never acted on: the saga either missed
    // the entity it had modified or acted on the parent. Silent, and only on
    // the failure path, which is the last place anyone looks and the one place
    // a saga must be right.
    const compensations_: Array<{ action: string; target: any; payload: any }> = [];

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const stepTarget = step.mapTarget ? step.mapTarget(target, payload) : target;
      const stepPayload = step.mapPayload ? step.mapPayload(target, payload) : payload;

      let result: CommandResult;
      try {
        const dispatched = bus.dispatch(step.action, stepTarget, stepPayload);
        // Handle both sync and async buses
        result = dispatched && typeof dispatched.then === 'function'
          ? await dispatched
          : dispatched;
      } catch (e) {
        result = { ok: false, error: e as Error };
      }

      results.push(result);

      if (!result.ok) {
        // Run compensations in reverse order
        const compensations: CommandResult[] = [];
        for (let j = compensations_.length - 1; j >= 0; j--) {
          const entry = compensations_[j];
          try {
            const comp = bus.dispatch(entry.action, entry.target, entry.payload);
            const compResult = comp && typeof comp.then === 'function' ? await comp : comp;
            compensations.push(compResult);
          } catch (e) {
            compensations.push({ ok: false, error: e as Error });
          }
        }
        return { ok: false, results, failedAt: i, error: result.error, compensations };
      }

      if (step.compensate) {
        compensations_.push({ action: step.compensate, target: stepTarget, payload: stepPayload });
      }
    }

    return { ok: true, results };
  }

  return { run, steps: Object.freeze([...steps]) };
}

// ---------------------------------------------------------------------------
// createReaction — declarative cross-domain dispatch rules
// ---------------------------------------------------------------------------

export type ReactionOptions = {
  /** Only react when this predicate returns true. */
  when?: (cmd: Command, result: CommandResult) => boolean;
  /** Transform the source command into the target command's target. */
  map?: (cmd: Command, result: CommandResult) => any;
  /** Transform the source command into the target command's payload. */
  mapPayload?: (cmd: Command, result: CommandResult) => any;
  /**
   * Allow `sourcePattern` to match `targetAction` — i.e. the reaction fires on
   * its own dispatch. Refused by default, because the loop it creates is
   * bounded only on a sync bus:
   *
   * - **Sync bus:** listeners fire nested inside dispatch, so
   *   `MAX_DISPATCH_DEPTH` halts each chain — 16 recursive dispatches and a
   *   logged `VC_CORE_MAX_DEPTH` per matching action. Degraded, bounded.
   * - **Async bus:** listeners fire post-settle, so each cycle is a fresh
   *   top-level dispatch with the depth counter unwound. Nothing bounds it —
   *   a self-sustaining infinite loop running handlers, plugins and (with a
   *   bridge installed) HTTP requests forever.
   *
   * Opt in only alongside a `when` guard that can actually terminate it. The
   * `maxHops` cap still applies.
   */
  allowSelfMatch?: boolean;
  /**
   * How many reaction hops a single originating command may trigger before
   * the chain is refused. Catches INDIRECT cycles (A→B, B→A), which no
   * install-time check can see. Default: 8.
   */
  maxHops?: number;
};

export interface Reaction {
  /** Install the reaction on a bus. Returns unsubscribe function. */
  install(bus: BaseBus): () => void;
}

/**
 * createReaction — declarative cross-chamber dispatch rules.
 * Explicit edges between domain modules.
 *
 * @example
 * createReaction('cartAdd', 'inventoryCheck', {
 *   when: (cmd, result) => result.ok,
 *   map:  (cmd) => ({ itemId: cmd.payload.itemId }),
 * }).install(bus);
 */
export function createReaction(
  sourcePattern: string,
  targetAction: string,
  options: ReactionOptions = {},
): Reaction {
  const { when, map, mapPayload, allowSelfMatch = false, maxHops = 8 } = options;
  const selfMatching = matchesPattern(sourcePattern, targetAction);

  function install(bus: BaseBus): () => void {
    // Statically detectable at install, so detect it at install.
    // `createReaction('cart*', 'cartRecalculate')` is the module's most
    // natural composition, not a contrived one — and on an async bus it spins
    // forever (see ReactionOptions.allowSelfMatch).
    if (selfMatching && !allowSelfMatch) {
      console.error(
        `[vapor-chamber] Reaction "${sourcePattern}" → "${targetAction}" matches its own target: ` +
          'every dispatch would re-trigger the reaction (unbounded on an async bus). ' +
          'Narrow the pattern, or pass { allowSelfMatch: true } with a `when` guard that terminates it. ' +
          'Not installed.',
      );
      return () => {};
    }

    return bus.on(sourcePattern, (cmd: Command, result: CommandResult) => {
      if (when && !when(cmd, result)) return;

      // Indirect cycles (A→B, B→A) are invisible at install time, so the chain
      // carries its own hop count. It rides the same `__`-payload convention
      // as `__causationId`/`__origin` — one dispatch, one marker, no flag that
      // an await can outrun.
      const hops = ((cmd.payload as { __reactionHops?: number } | undefined)?.__reactionHops ?? 0) + 1;
      if (hops > maxHops) {
        console.error(
          `[vapor-chamber] Reaction "${sourcePattern}" → "${targetAction}" exceeded maxHops (${maxHops}) — ` +
            'refusing to continue. This is a reaction cycle; break it with a `when` guard or raise maxHops.',
        );
        return;
      }

      const target = map ? map(cmd, result) : cmd.target;
      const mapped = mapPayload ? mapPayload(cmd, result) : undefined;
      // Also propagate causation, which reactions never did — a reaction chain
      // was untraceable in devtools even when it terminated.
      const marker = { __reactionHops: hops, __causationId: cmd.meta?.id };
      const payload =
        mapped === null || mapped === undefined
          ? marker
          : typeof mapped === 'object' && !Array.isArray(mapped)
            ? { ...mapped, ...marker }
            : mapped;

      try {
        bus.dispatch(targetAction, target, payload);
      } catch (e) {
        console.error(`[vapor-chamber] Reaction ${sourcePattern} → ${targetAction} error:`, e);
      }
    });
  }

  return { install };
}
