/**
 * Compile-time-only checks for the typed command contract:
 * GlobalCommands augmentation → typed useCommand()/getCommandBus().
 *
 * Included in `npm run typecheck` via tsconfig `include`; never executed
 * (the filename deliberately avoids vitest's *.test.ts pattern).
 *
 * NOTE: this file augments GlobalCommands for the whole tsc program — which is
 * exactly the real-world consumer scenario. Library internals must stay pinned
 * to getCommandBus<CommandMap>() so they compile under augmentation; if a
 * future internal call site forgets that, THIS file is what breaks the build.
 */
import { useCommand, getCommandBus, useCommandBus } from '../src/chamber';
import type { CommandMap, CommandResult } from '../src/command-bus';

type Product = { id: number; name: string };
type Cart = { count: number; total: number };

declare module '../src/chamber' {
  interface GlobalCommands {
    cartAdd: { target: Product; payload: { qty: number }; result: Cart };
    cartClear: { target: null; result: Cart };
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────
type Eq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;

// ── typed composable ─────────────────────────────────────────────────────────
export function _typedComposable() {
  const { dispatch, register } = useCommand();

  const r = dispatch('cartAdd', { id: 1, name: 'Widget' }, { qty: 2 });
  type _r = Assert<Eq<typeof r, CommandResult<Cart> | Promise<CommandResult<Cart>>>>;

  // @ts-expect-error — action not declared in GlobalCommands
  dispatch('notACommand', {});

  // @ts-expect-error — wrong target shape for cartAdd
  dispatch('cartAdd', { wrong: true }, { qty: 2 });

  // @ts-expect-error — wrong payload shape for cartAdd
  dispatch('cartAdd', { id: 1, name: 'Widget' }, { quantity: 2 });

  register('cartClear', (cmd) => {
    type _t = Assert<Eq<typeof cmd.target, null>>;
    return { count: 0, total: 0 };
  });

  // @ts-expect-error — handler result must be Cart
  register('cartClear', () => 'not a cart');
}

// ── typed shared bus ─────────────────────────────────────────────────────────
export function _typedSharedBus() {
  const bus = getCommandBus();
  const r = bus.dispatch('cartClear', null);
  type _r = Assert<Eq<typeof r, CommandResult<Cart>>>;

  // @ts-expect-error — unknown action on the typed shared bus
  bus.dispatch('notACommand', {});

  // Explicit opt-out returns the loose bus — arbitrary strings allowed again.
  const loose = getCommandBus<CommandMap>();
  loose.dispatch('anythingGoes', { free: true });

  const viaComposable = useCommandBus();
  viaComposable.dispatch('cartAdd', { id: 1, name: 'x' }, { qty: 1 });
}

// ── schema-driven contract (defineSchema → CommandsOf → typed schema bus) ────
import { defineSchema, createSchemaCommandBus, type CommandsOf } from '../src/schema';

const schema = defineSchema({
  orderCreate: {
    description: 'Create an order',
    target: { items: 'array', couponCode: 'string' },
    result: { orderId: 'string', totalCents: 'number' },
  },
});

export function _schemaTypedBus() {
  const bus = createSchemaCommandBus(schema);

  const r = bus.dispatch('orderCreate', { items: [1], couponCode: 'X' });
  type _ok = Assert<Eq<typeof r extends CommandResult<infer V> ? V : never,
    { orderId: string; totalCents: number }>>;

  // @ts-expect-error — action not in the schema
  bus.dispatch('unknownAction', {});

  // @ts-expect-error — couponCode must be a string
  bus.dispatch('orderCreate', { items: [], couponCode: 42 });

  // CommandsOf produces GlobalCommands-compatible entries
  type Derived = CommandsOf<typeof schema>;
  type _t = Assert<Eq<Derived['orderCreate']['target'],
    { items: any[]; couponCode: string }>>;
}
