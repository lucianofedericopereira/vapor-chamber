/**
 * Real-time Search Example
 *
 * Demonstrates: debounce plugin with sync bus, async-like behavior
 *
 * Note: The debounce plugin works with the sync bus. For truly async
 * handlers, you'd implement debounce at the application level or
 * create an async debounce plugin.
 */

import { createCommandBus, debounce, logger } from 'vapor-chamber';

// Simulated search results
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

// Create sync bus with debounce
const bus = createCommandBus();

bus.use(logger());

// Debounce search queries - wait 300ms after typing stops
bus.use(debounce(['searchQuery'], 300));

// Handler - sync version (for async, use createAsyncCommandBus with custom debounce)
bus.register('searchQuery', (cmd) => {
  const query = (cmd.target as string).toLowerCase();

  if (!query) {
    return [];
  }

  const results = products.filter(p =>
    p.name.toLowerCase().includes(query) ||
    p.category.toLowerCase().includes(query)
  );

  return results;
});

// Simulated rapid typing
function simulateTyping() {
  console.log('--- Simulating rapid typing "wire" ---');
  console.log('(Only the last query should execute due to debounce)\n');

  // These happen quickly - debounce returns pending for intermediate calls
  const results = [
    bus.dispatch('searchQuery', 'w'),
    bus.dispatch('searchQuery', 'wi'),
    bus.dispatch('searchQuery', 'wir'),
    bus.dispatch('searchQuery', 'wire'),
  ];

  console.log('\nResults returned immediately:');
  results.forEach((r, i) => {
    const query = ['w', 'wi', 'wir', 'wire'][i];
    if (r.value?.pending) {
      console.log(`Query "${query}": pending (debounced)`);
    } else {
      console.log(`Query "${query}":`, r.value);
    }
  });

  // Wait for debounced execution. Note: a debounced action's dispatch ALWAYS
  // returns { pending: true } — including this one — because the plugin defers
  // the real handler run. Results arrive via the deferred execution (observe
  // them with bus.on('searchQuery', ...)), never in the dispatch return value.
  console.log('\n--- Waiting 500ms for debounce to complete ---');
  setTimeout(() => {
    console.log('\n--- Dispatch after debounce period ---');
    const finalResult = bus.dispatch('searchQuery', 'wire');
    console.log('Result:', finalResult); // → { ok: true, value: { pending: true } }
  }, 500);
}

// Search by category
function searchByCategory() {
  console.log('\n--- Search by category "Electronics" (after debounce clears) ---');
  setTimeout(() => {
    const result = bus.dispatch('searchQuery', 'Electronics');
    console.log('Result:', result);
  }, 1000);
}

// Run examples
simulateTyping();
searchByCategory();

export { bus };
