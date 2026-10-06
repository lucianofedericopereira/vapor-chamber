/**
 * Shopping Cart Example
 *
 * Demonstrates: a store with undo, and the validator, history and logger plugins
 */

import { createCommandBus, validator, history, logger } from 'vapor-chamber';
import { defineChamberStore } from 'vapor-chamber/store';

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

const totalOf = (items: CartItem[]) => items.reduce((sum, i) => sum + i.price * i.quantity, 0);
const withItems = (items: CartItem[]): Cart => ({ items, total: totalOf(items) });

// Create bus with plugins
const bus = createCommandBus();

bus.use(logger({ filter: (cmd) => cmd.action.startsWith('cart') }));

bus.use(validator({
  'cartAdd': (cmd) => cmd.target?.price > 0 ? null : 'Invalid product',
  'cartUpdate': (cmd) => cmd.payload?.quantity >= 0 ? null : 'Invalid quantity'
}));

// Pass `bus` so undo() runs each command's inverse (`<action>$undo`).
const historyPlugin = history({ bus, filter: (cmd) => cmd.action.startsWith('cart') });
bus.use(historyPlugin);

// The cart is a store: each action is a command (`cartAdd`, ...) that returns
// the next state, and `undo: true` gives every one of them its inverse - no
// hand-written undo, and none to forget (cartUpdate and cartClear included).
const useCart = defineChamberStore('cart', {
  state: (): Cart => ({ items: [], total: 0 }),
  reducers: {
    add: (s, product: Product, p?: { quantity?: number }) => {
      const quantity = p?.quantity ?? 1;
      const found = s.items.some((i) => i.id === product.id);
      return withItems(found
        ? s.items.map((i) => (i.id === product.id ? { ...i, quantity: i.quantity + quantity } : i))
        : [...s.items, { ...product, quantity }]);
    },
    remove: (s, product: Product) => withItems(s.items.filter((i) => i.id !== product.id)),
    update: (s, product: Product, p: { quantity: number }) => withItems(p.quantity === 0
      ? s.items.filter((i) => i.id !== product.id)
      : s.items.map((i) => (i.id === product.id ? { ...i, quantity: p.quantity } : i))),
    clear: () => withItems([]),
  },
  undo: true,
});
const cart = useCart(bus);

// Usage
const widget = { id: 1, name: 'Widget', price: 9.99 };
const gadget = { id: 2, name: 'Gadget', price: 19.99 };

console.log('--- Adding items ---');
cart.add(widget, { quantity: 2 });
cart.add(gadget);

console.log('\n--- Current cart ---');
console.log(cart.state.value);

console.log('\n--- Updating quantity ---');
cart.update(widget, { quantity: 5 });

console.log('\n--- Clearing ---');
cart.clear();

console.log('\n--- Undo twice: the clear, then the update ---');
historyPlugin.undo();
historyPlugin.undo();
console.log('After undo:', cart.state.value); // widget x2, gadget x1

console.log('\n--- History state ---');
console.log(historyPlugin.getState());
