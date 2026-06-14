import { reactive } from 'vue';
import { createCommandBus, logger, persist, history as mkHistory, sync } from 'vapor-chamber';

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

// Logger — cart.* only
bus.use(logger({ filter: cmd => cmd.action.startsWith('cart') }));

// History — bus-backed undo. `undoAction`/`redoAction` (v1.6.0) register the
// trigger handlers AND exclude them from recording automatically — without
// that, hand-wired `cart.undo` handlers get recorded into history themselves,
// wiping the redo stack on every dispatch (undo works once, redo never enables).
// The filter keeps history scoped to the one undoable command.
export const cartHistory = mkHistory({
  maxSize: 50,
  bus,
  filter: cmd => cmd.action === 'cart.add',
  undoAction: 'cart.undo',
  redoAction: 'cart.redo',
});
bus.use(cartHistory);

// Tab sync
bus.use(sync({ channel: 'vc:cart:vapor', filter: cmd => cmd.action.startsWith('cart') }, bus));

// Persist
let runningTotal = 0;
const cartPersist = persist({ key: 'vc:cart:vapor', getState: () => ({ ...cart, runningTotal }) });
bus.use(cartPersist);
const saved = cartPersist.load() as typeof cart & { runningTotal: number } | null;
if (saved) {
  const { count, total, empty, lastAdded } = saved;
  Object.assign(cart, { count, total, empty, lastAdded });
  runningTotal = saved.runningTotal ?? 0;
}

// Handlers
bus.register(
  'cart.add',
  (cmd) => {
    const p = cmd.target as Product;
    runningTotal += Math.round(p.price * 100);
    cart.count += 1; cart.total = runningTotal / 100;
    cart.empty = false; cart.lastAdded = p.name;
  },
  {
    undo: (cmd) => {
      const p = cmd.target as Product;
      runningTotal = Math.max(0, runningTotal - Math.round(p.price * 100));
      cart.count = Math.max(0, cart.count - 1);
      cart.total = runningTotal / 100;
      cart.empty = cart.count === 0;
      if (cart.count === 0) cart.lastAdded = '';
    },
  },
);

bus.register('cart.clear', () => {
  runningTotal = 0; cart.count = 0; cart.total = 0; cart.empty = true; cart.lastAdded = '';
});

// Keep undo/redo availability reactive after every cart command
bus.on('cart*', () => {
  const { canUndo, canRedo } = cartHistory.getState();
  cart.cantUndo = !canUndo;
  cart.cantRedo = !canRedo;
});
