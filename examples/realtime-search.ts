/**
 * Real-time Search Example
 *
 * Demonstrates: debounce plugin with sync bus, async-like behavior
 *
 * Note: The debounce plugin works with the sync bus. For truly async
 * handlers, you'd implement debounce at the application level or
 * create an async debounce plugin.
 */

import { createCommandBus, debounce, logger } from '../src';

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
bus.use(debounce(['search.query'], 300));

// Handler - sync version (for async, use createAsyncCommandBus with custom debounce)
bus.register('search.query', (cmd) => {
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
    bus.dispatch('search.query', 'w'),
    bus.dispatch('search.query', 'wi'),
    bus.dispatch('search.query', 'wir'),
    bus.dispatch('search.query', 'wire'),
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

  // Wait for debounced execution
  console.log('\n--- Waiting 500ms for debounce to complete ---');
  setTimeout(() => {
    console.log('\n--- Dispatch after debounce period ---');
    const finalResult = bus.dispatch('search.query', 'wire');
    console.log('Result:', finalResult);
  }, 500);
}

// Search by category
function searchByCategory() {
  console.log('\n--- Search by category "Electronics" (after debounce clears) ---');
  setTimeout(() => {
    const result = bus.dispatch('search.query', 'Electronics');
    console.log('Result:', result);
  }, 1000);
}

// Run examples
simulateTyping();
searchByCategory();

export { bus };
