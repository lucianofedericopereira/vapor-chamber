/**
 * Real-time Search Example
 *
 * Shows only the latest query of a burst running, its results shown. The sender
 * paces: `pace(bus.dispatch, { debounce })` runs the last call of a burst, and
 * its caller gets the real results. An earlier call answers `pace:aborted:dispatch`.
 * The typed text is the PAYLOAD: calls are keyed by action and target, so every
 * keystroke shares one key and the burst coalesces.
 */

import { createCommandBus, logger, pace, type BusError } from 'vapor-chamber';

const products = [
  { id: 1, name: 'Wireless Headphones', category: 'Electronics' },
  { id: 2, name: 'Wireless Mouse', category: 'Electronics' },
  { id: 3, name: 'Wireless Keyboard', category: 'Electronics' },
  { id: 4, name: 'USB Cable', category: 'Accessories' },
  { id: 5, name: 'USB Hub', category: 'Accessories' },
  { id: 6, name: 'Laptop Stand', category: 'Furniture' },
  { id: 7, name: 'Monitor Arm', category: 'Furniture' },
  { id: 8, name: 'Desk Lamp', category: 'Furniture' },
];

const bus = createCommandBus();

bus.use(logger());

// The query is the payload.
bus.register('searchQuery', ({ payload }) => {
  const query = (payload as string).toLowerCase();
  return query ? products.filter((p) => p.name.toLowerCase().includes(query) || p.category.toLowerCase().includes(query)) : [];
});

// Wait 300 ms after typing stops. The sender paces; the bus never does.
const search = pace(bus.dispatch, { debounce: 300 });

console.log('--- Simulating rapid typing "wire" ---');
console.log('(Only the last query runs: the earlier ones are superseded)\n');

const typed = ['w', 'wi', 'wir', 'wire'];
const results = await Promise.all(typed.map((query) => search('searchQuery', {}, query)));
results.forEach((r, i) => {
  if (r.ok) console.log(`Query "${typed[i]}":`, r.value);
  else console.log(`Query "${typed[i]}": superseded (${(r.error as BusError).code})`);
});

// A new burst, after the first one has run
console.log('\n--- Search by category "Electronics" ---');
const category = await search('searchQuery', {}, 'Electronics');
console.log('Result:', category.ok ? category.value : category.error);
