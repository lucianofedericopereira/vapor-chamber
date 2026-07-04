/**
 * Shopping Cart Example
 *
 * Demonstrates: handlers, validator, history, logger plugins
 */

import { createCommandBus, validator, history, logger } from 'vapor-chamber';

// Types
interface Product {
  id: number;
  name: string;
  price: number;
}

interface CartItem extends Product {
  quantity: number;
}

interface Cart {
  items: CartItem[];
  total: number;
}

// State
const cart: Cart = { items: [], total: 0 };

// Create bus with plugins
const bus = createCommandBus();

bus.use(logger({ filter: (cmd) => cmd.action.startsWith('cart') }));

bus.use(validator({
  'cartAdd': (cmd) => cmd.target?.price > 0 ? null : 'Invalid product',
  'cartUpdate': (cmd) => cmd.payload?.quantity >= 0 ? null : 'Invalid quantity'
}));

// Pass `bus` so undo() executes the inverse handlers registered below with
// `{ undo }` — without it, undo() only pops the history stack and the cart
// state would stay unchanged.
const historyPlugin = history({ bus, filter: (cmd) => cmd.action.startsWith('cart') });
bus.use(historyPlugin);

// Handlers — each mutating command registers its inverse via `{ undo }`
function recalcTotal() {
  cart.total = cart.items.reduce((sum, i) => sum + i.price * i.quantity, 0);
}

bus.register('cartAdd', (cmd) => {
  const product = cmd.target as Product;
  const quantity = cmd.payload?.quantity ?? 1;

  const existing = cart.items.find(i => i.id === product.id);
  if (existing) {
    existing.quantity += quantity;
  } else {
    cart.items.push({ ...product, quantity });
  }

  recalcTotal();
  return { ...cart };
}, {
  undo: (cmd) => {
    const product = cmd.target as Product;
    const quantity = cmd.payload?.quantity ?? 1;
    const item = cart.items.find(i => i.id === product.id);
    if (item) {
      item.quantity -= quantity;
      if (item.quantity <= 0) cart.items = cart.items.filter(i => i.id !== product.id);
    }
    recalcTotal();
    return { ...cart };
  },
});

bus.register('cartRemove', (cmd) => {
  const product = cmd.target as Product;
  const removed = cart.items.find(i => i.id === product.id);
  // Stash what we removed on the command so the inverse can restore it
  if (cmd.payload === undefined) cmd.payload = {};
  cmd.payload.removed = removed;
  cart.items = cart.items.filter(i => i.id !== product.id);
  recalcTotal();
  return { ...cart };
}, {
  undo: (cmd) => {
    const removed = cmd.payload?.removed as CartItem | undefined;
    if (removed) cart.items.push(removed);
    recalcTotal();
    return { ...cart };
  },
});

bus.register('cartUpdate', (cmd) => {
  const product = cmd.target as Product;
  const quantity = cmd.payload?.quantity ?? 0;

  const item = cart.items.find(i => i.id === product.id);
  if (item) {
    if (quantity === 0) {
      cart.items = cart.items.filter(i => i.id !== product.id);
    } else {
      item.quantity = quantity;
    }
  }

  cart.total = cart.items.reduce((sum, i) => sum + i.price * i.quantity, 0);
  return { ...cart };
});

bus.register('cartClear', () => {
  cart.items = [];
  cart.total = 0;
  return { ...cart };
});

// Usage
const widget = { id: 1, name: 'Widget', price: 9.99 };
const gadget = { id: 2, name: 'Gadget', price: 19.99 };

console.log('--- Adding items ---');
bus.dispatch('cartAdd', widget, { quantity: 2 });
bus.dispatch('cartAdd', gadget);

console.log('\n--- Current cart ---');
console.log(cart);

console.log('\n--- Updating quantity ---');
bus.dispatch('cartUpdate', widget, { quantity: 5 });

console.log('\n--- Removing item ---');
bus.dispatch('cartRemove', gadget);

console.log('\n--- Undo last action ---');
historyPlugin.undo();
console.log('After undo:', cart);

console.log('\n--- History state ---');
console.log(historyPlugin.getState());

export { bus, cart };
