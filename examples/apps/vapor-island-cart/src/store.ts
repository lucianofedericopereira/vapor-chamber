import { effectScope } from 'vue';
import { createCommandBus, logger, useCommandHistory } from 'vapor-chamber/vue';
import { defineChamberStore, saveTo, shareTabs } from 'vapor-chamber/store';

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

export const bus = createCommandBus();

bus.use(logger({ actions: ['cart*'] }));

// The cart is one store, and the three facts about it are options on it:
// `undo` derives each action's inverse (the state it replaced), `persist`
// saves the state and reads it back on the next load, and `share` makes it
// the same in every tab. Another tab's state is written with no dispatch, so
// undo and redo act on this tab's own commands.
export const useCart = defineChamberStore('cart', {
  state: () => ({ count: 0, cents: 0, lastAdded: '' }),
  reducers: {
    add: (s, p: Product) => ({ count: s.count + 1, cents: s.cents + Math.round(p.price * 100), lastAdded: p.name }),
  },
  undo: true,
  persist: saveTo({ key: 'vc:cart:vapor' }),
  share: shareTabs(),
});

export const cart = useCart(bus);

// Recording starts here, at module load, so an add is recorded whichever
// island hydrates first. The composable wants a scope to end with, and this
// one lives as long as the page. The `actions` scope keeps history to the one
// undoable command: a clear (`cart.$reset()`) is not undone.
export const history = effectScope(true).run(() => useCommandHistory({ bus, actions: ['cartAdd'], maxSize: 50 }))!;
