/**
 * Shopping Cart Example
 *
 * Shows a cart whose every change is validated, logged and undoable. A refused
 * add is shown, and the cart stays as it was. The cart is a store: each reducer
 * is a command (`cartAdd`, ...) and `undo: true` gives each one its inverse,
 * none to write and none to forget. The rules are a `validator`, the log a
 * scoped `logger`, the undo a `history`.
 */

import { createCommandBus, history, logger, validator, type BusError } from 'vapor-chamber';
import { defineChamberStore } from 'vapor-chamber/store';

interface Product { id: number; name: string; price: number }
interface CartItem extends Product { quantity: number }
interface Cart { items: CartItem[]; total: number }

const cartOf = (items: CartItem[]): Cart => ({ items, total: items.reduce((sum, i) => sum + i.price * i.quantity, 0) });

/** The items with one product's quantity set; a quantity of 0 drops it. */
const setQuantity = (items: CartItem[], id: number, quantity: number) =>
  quantity === 0 ? items.filter((i) => i.id !== id) : items.map((i) => (i.id === id ? { ...i, quantity } : i));

const bus = createCommandBus();

bus.use(logger({ actions: ['cart*'] }));
bus.use(validator({
  cartAdd: (cmd) => (cmd.target?.price > 0 ? null : 'Invalid product'),
  cartUpdate: (cmd) => (cmd.payload?.quantity >= 0 ? null : 'Invalid quantity'),
}));

const useCart = defineChamberStore('cart', {
  state: (): Cart => ({ items: [], total: 0 }),
  reducers: {
    add: (s, product: Product, p?: { quantity?: number }) => {
      const quantity = p?.quantity ?? 1;
      const held = s.items.find((i) => i.id === product.id);
      return cartOf(held ? setQuantity(s.items, product.id, held.quantity + quantity) : [...s.items, { ...product, quantity }]);
    },
    remove: (s, product: Product) => cartOf(setQuantity(s.items, product.id, 0)),
    update: (s, product: Product, p: { quantity: number }) => cartOf(setQuantity(s.items, product.id, p.quantity)),
    clear: () => cartOf([]),
  },
  undo: true,
});
const cart = useCart(bus);

// `bus` lets undo() run each command's inverse (`<action>$undo`).
const cartHistory = history({ bus, actions: ['cart*'] });

// Usage
const widget = { id: 1, name: 'Widget', price: 9.99 };
const gadget = { id: 2, name: 'Gadget', price: 19.99 };

console.log('--- Adding items ---');
cart.add(widget, { quantity: 2 });
cart.add(gadget);

console.log('\n--- Refused: a product with no price ---');
const refused = bus.dispatch('cartAdd', { id: 3, name: 'Free sample', price: 0 });
console.log(refused.ok ? 'added' : (refused.error as BusError).code, '->', cart.state.value.items.length, 'items');

console.log('\n--- Current cart ---');
console.log(cart.state.value);

console.log('\n--- Updating quantity ---');
cart.update(widget, { quantity: 5 });

console.log('\n--- Clearing ---');
cart.clear();

console.log('\n--- Undo twice: the clear, then the update ---');
cartHistory.undo();
cartHistory.undo();
console.log('After undo:', cart.state.value); // widget x2, gadget x1

console.log('\n--- History state ---');
console.log(cartHistory.getState());
