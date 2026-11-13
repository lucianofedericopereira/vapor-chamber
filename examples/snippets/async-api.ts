/**
 * Async API Example
 *
 * Shows async CRUD on the async bus, re-sending a transient failure only where
 * it is safe. The bus re-sends a 429, a 503 and a 408 for any action. A declared
 * wait (Retry-After) sets when, never whether, and a verdict such as a 422 is
 * never re-sent. A plain throw may have landed, so it is re-sent only for an
 * action declared idempotent: a read is, whatever it returns.
 */

import { BusError, createAsyncCommandBus, logger } from 'vapor-chamber';

interface User { id: number; name: string; email: string }

const bus = createAsyncCommandBus({ retry: { baseDelay: 1000, actionPolicies: { userFetch: 'idempotent' } } });

// The logger hears every outcome once settled: a result, a failure, a refusal.
bus.use(logger({ collapsed: false }));

// Simulated API (replace with real fetch in production)
const users: User[] = [
  { id: 1, name: 'Alice', email: 'alice@example.com' },
  { id: 2, name: 'Bob', email: 'bob@example.com' },
];
const latency = () => new Promise((resolve) => setTimeout(resolve, 100));

/** A VERDICT, so a coded failure: `missing` is never re-sent, where a plain throw is. */
const userOf = (id: number) => {
  const user = users.find((u) => u.id === id);
  if (!user) throw new BusError('missing:user', `User ${id} not found`, { context: { id } });
  return user;
};

// The first two attempts of a read fail, as a flaky network does.
let failures = 0;

bus.register('userFetch', async (cmd) => {
  await latency();
  if (failures < 2) {
    failures++;
    throw new Error('Network error');
  }
  failures = 0;
  return userOf(cmd.target.id);
});

bus.register('userList', async () => {
  await latency();
  return [...users];
});

bus.register('userCreate', async (cmd) => {
  await latency();
  const user: User = { id: users.length + 1, ...(cmd.target as Omit<User, 'id'>) };
  users.push(user);
  return user;
});

bus.register('userUpdate', async (cmd) => {
  await latency();
  return Object.assign(userOf(cmd.target.id), cmd.payload as Partial<User>);
});

// Usage
console.log('--- Fetching user (will retry on failure) ---');
console.log('Result:', await bus.dispatch('userFetch', { id: 1 }));

console.log('\n--- Listing all users ---');
console.log('Result:', await bus.dispatch('userList', null));

console.log('\n--- Creating new user ---');
console.log('Result:', await bus.dispatch('userCreate', { name: 'Charlie', email: 'charlie@example.com' }));

console.log('\n--- Updating user ---');
console.log('Result:', await bus.dispatch('userUpdate', { id: 1 }, { name: 'Alice Smith' }));

console.log('\n--- Fetching non-existent user (not retried: a verdict) ---');
const missing = await bus.dispatch('userFetch', { id: 999 });
console.log('Result:', missing.ok ? missing.value : (missing.error as BusError).code); // 'app:missing:user'
