/**
 * vapor-chamber — Utility layer
 *
 * createChamber, createWorkflow, createReaction
 *
 * These use only the public BaseBus interface. They are optional and tree-shaken.
 */

import type { BaseBus, Command, CommandResult, Handler, RegisterOptions, Listener } from './command-bus';
import { matchesPattern } from './command-bus';

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
    return () => { unsubs.forEach(fn => fn()); };
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
    const compensateActions: string[] = [];

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
        for (let j = compensateActions.length - 1; j >= 0; j--) {
          try {
            const comp = bus.dispatch(compensateActions[j], target, payload);
            const compResult = comp && typeof comp.then === 'function' ? await comp : comp;
            compensations.push(compResult);
          } catch (e) {
            compensations.push({ ok: false, error: e as Error });
          }
        }
        return { ok: false, results, failedAt: i, error: result.error, compensations };
      }

      if (step.compensate) {
        compensateActions.push(step.compensate);
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
  const { when, map, mapPayload } = options;

  function install(bus: BaseBus): () => void {
    return bus.on(sourcePattern, (cmd: Command, result: CommandResult) => {
      if (when && !when(cmd, result)) return;
      const target = map ? map(cmd, result) : cmd.target;
      const payload = mapPayload ? mapPayload(cmd, result) : undefined;
      try {
        bus.dispatch(targetAction, target, payload);
      } catch (e) {
        console.error(`[vapor-chamber] Reaction ${sourcePattern} → ${targetAction} error:`, e);
      }
    });
  }

  return { install };
}
