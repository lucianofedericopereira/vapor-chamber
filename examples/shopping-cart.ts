/**
 * Shopping Cart Example
 *
 * Demonstrates: handlers, validator, history, logger plugins
 */

import { createCommandBus, validator, history, logger } from '../src';

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

bus.use(logger({ filter: (cmd) => cmd.action.startsWith('cart.') }));

bus.use(validator({
  'cart.add': (cmd) => cmd.target?.price > 0 ? null : 'Invalid product',
  'cart.update': (cmd) => cmd.payload?.quantity >= 0 ? null : 'Invalid quantity'
}));

const historyPlugin = history({ filter: (cmd) => cmd.action.startsWith('cart.') });
bus.use(historyPlugin);

// Handlers
bus.register('cart.add', (cmd) => {
  const product = cmd.target as Product;
  const quantity = cmd.payload?.quantity ?? 1;

  const existing = cart.items.find(i => i.id === product.id);
  if (existing) {
    existing.quantity += quantity;
  } else {
    cart.items.push({ ...product, quantity });
  }

  cart.total = cart.items.reduce((sum, i) => sum + i.price * i.quantity, 0);
  return { ...cart };
});

bus.register('cart.remove', (cmd) => {
  const product = cmd.target as Product;
  cart.items = cart.items.filter(i => i.id !== product.id);
  cart.total = cart.items.reduce((sum, i) => sum + i.price * i.quantity, 0);
  return { ...cart };
});

bus.register('cart.update', (cmd) => {
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

bus.register('cart.clear', () => {
  cart.items = [];
  cart.total = 0;
  return { ...cart };
});

// Usage
const widget = { id: 1, name: 'Widget', price: 9.99 };
const gadget = { id: 2, name: 'Gadget', price: 19.99 };

console.log('--- Adding items ---');
bus.dispatch('cart.add', widget, { quantity: 2 });
bus.dispatch('cart.add', gadget);

console.log('\n--- Current cart ---');
console.log(cart);

console.log('\n--- Updating quantity ---');
bus.dispatch('cart.update', widget, { quantity: 5 });

console.log('\n--- Removing item ---');
bus.dispatch('cart.remove', gadget);

console.log('\n--- Undo last action ---');
historyPlugin.undo();
console.log('After undo:', cart);

console.log('\n--- History state ---');
console.log(historyPlugin.getState());

export { bus, cart };
