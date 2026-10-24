/**
 * The page's state: two stores, no framework.
 *
 * `cart` is the order. Every change is a command (`cartAdd`, `cart$reset`),
 * and the page's `data-vc-*` attributes read its fields. `ui` holds the one
 * piece of state that belongs to the page alone, whether the details note is
 * open. The reducers format what the page prints, because a display binding
 * only prints the string it is handed.
 */

import { defineChamberStore } from 'vapor-chamber/store/core';

export type Item = { name: string; price: number };
export type Line = { name: string; qty: number; amount: string };
export type CartState = {
  items: Line[];
  cents: number;
  count: number;
  total: string;
  lastAdded: string;
  empty: boolean;
};

const money = (cents: number): string => `$${(cents / 100).toFixed(2)}`;
const line = (name: string, qty: number, cents: number): Line => ({ name, qty, amount: money(cents) });

export const useCart = defineChamberStore('cart', {
  state: (): CartState => ({ items: [], cents: 0, count: 0, total: money(0), lastAdded: '', empty: true }),
  reducers: {
    // A repeat Add bumps its line, never stacks a second one.
    add: (s, item: Item): CartState => {
      const unit = Math.round(item.price * 100);
      const cents = s.cents + unit;
      const known = s.items.some((l) => l.name === item.name);
      return {
        items: known
          ? s.items.map((l) => (l.name === item.name ? line(l.name, l.qty + 1, unit * (l.qty + 1)) : l))
          : [...s.items, line(item.name, 1, unit)],
        cents,
        count: s.count + 1,
        total: money(cents),
        lastAdded: item.name,
        empty: false,
      };
    },
  },
});

export const useUi = defineChamberStore('ui', {
  state: () => ({ open: false }),
  reducers: {
    toggleDetails: (s) => ({ open: !s.open }),
  },
});
