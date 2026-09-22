import { reactive } from 'vue';
import { createCommandBus, logger, persist, history as mkHistory, sync } from 'vapor-chamber';
import { createFastLane } from 'vapor-chamber/fast-lane';

export interface Product {
  id: number;
  name: string;
  price: number;
}

export const products: Product[] = [
  { id: 1, name: 'Coffee',   price: 4 },
  { id: 2, name: 'Tea',      price: 3 },
  { id: 3, name: 'Espresso', price: 5 },
];

export const cart = reactive({
  count: 0, total: 0, empty: true, lastAdded: '',
  cantUndo: true, cantRedo: true,
});

export const bus = createCommandBus();

// The event channel the tabs share. A handler computes the cart's new state
// and emits it as a FACT; the one listener below is the only thing that writes
// to `cart`, locally and for a fact arriving from another tab alike. That is
// what makes the tabs mirror: the receiving tab applies the numbers the
// sending tab computed instead of re-running the handler and deriving its own.
export const lane = createFastLane();

/** The whole cart, absolute rather than relative ("the count is 2", not "add one"). */
type CartFact = {
  runningTotal: number;
  count: number; total: number; empty: boolean; lastAdded: string;
};

let runningTotal = 0;

lane.on<CartFact>('cartChanged', (f) => {
  runningTotal = f.runningTotal;
  cart.count = f.count;
  cart.total = f.total;
  cart.empty = f.empty;
  cart.lastAdded = f.lastAdded;
});

/** The fact for a cart holding `cents`, with `count` items, `lastAdded` on top. */
function fact(cents: number, count: number, lastAdded: string): CartFact {
  return { runningTotal: cents, count, total: cents / 100, empty: count === 0, lastAdded };
}

// Logger - cart.* only
bus.use(logger({ filter: cmd => cmd.action.startsWith('cart') }));

// History - bus-backed undo. `undoAction`/`redoAction` (v1.6.0) register the
// trigger handlers AND exclude them from recording automatically - without
// that, hand-wired `cart.undo` handlers get recorded into history themselves,
// wiping the redo stack on every dispatch (undo works once, redo never enables).
// The filter keeps history scoped to the one undoable command.
export const cartHistory = mkHistory({
  maxSize: 50,
  bus,
  filter: cmd => cmd.action === 'cartAdd',
  undoAction: 'cartUndo',
  redoAction: 'cartRedo',
});
bus.use(cartHistory);

// Tab sync - the bridge is NOT a bus plugin: it listens on the lane and puts
// `cartChanged` on a BroadcastChannel, so it costs the dispatch path nothing
// and a derived command never leaks to the other tabs.
export const tabSync = sync({ channel: 'vc:cart:vapor', lane, events: ['cartChanged'] });

// Persist
const cartPersist = persist({ key: 'vc:cart:vapor', getState: () => ({ ...cart, runningTotal }) });
bus.use(cartPersist);
const saved = cartPersist.load() as typeof cart & { runningTotal: number } | null;
if (saved) {
  const { count, total, empty, lastAdded } = saved;
  Object.assign(cart, { count, total, empty, lastAdded });
  runningTotal = saved.runningTotal ?? 0;
}

// Handlers
// Every handler COMPUTES and emits; none of them writes to `cart` directly.
// The lane listener above is the single writer, so the same code path runs for
// a local click and for a fact that arrived from another tab.
bus.register(
  'cartAdd',
  (cmd) => {
    const p = cmd.target as Product;
    lane.emit('cartChanged', fact(runningTotal + Math.round(p.price * 100), cart.count + 1, p.name));
  },
  {
    undo: (cmd) => {
      const p = cmd.target as Product;
      const cents = Math.max(0, runningTotal - Math.round(p.price * 100));
      const count = Math.max(0, cart.count - 1);
      lane.emit('cartChanged', fact(cents, count, count === 0 ? '' : cart.lastAdded));
    },
  },
);

bus.register('cartClear', () => {
  lane.emit('cartChanged', fact(0, 0, ''));
});

// Keep undo/redo availability reactive after every cart command
bus.on('cart*', () => {
  const { canUndo, canRedo } = cartHistory.getState();
  cart.cantUndo = !canUndo;
  cart.cantRedo = !canRedo;
});
