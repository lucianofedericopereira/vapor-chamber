/**
 * Async API Example
 *
 * Demonstrates: async command bus, async plugins, error handling
 */

import { BusError, createAsyncCommandBus, type AsyncPlugin } from 'vapor-chamber';

// Types
interface User {
  id: number;
  name: string;
  email: string;
}

// Create async bus
// The bus re-sends what re-sending can change (a timeout, a 429 or 503, a
// declared Retry-After) and never a verdict such as a 422. A plain throw may
// have landed, so it is re-sent only for an action declared idempotent: a
// read is, whatever it returns.
const bus = createAsyncCommandBus({ retry: { baseDelay: 1000, actions: { userFetch: 'idempotent' } } });

// Async logger plugin
const asyncLogger: AsyncPlugin = async (cmd, next) => {
  console.group(`⚡ ${cmd.action}`);
  console.log('target:', cmd.target);
  if (cmd.payload !== undefined) console.log('payload:', cmd.payload);

  const result = await next();

  if (result.ok) {
    console.log('result:', result.value);
  } else {
    console.error('error:', result.error);
  }
  console.groupEnd();

  return result;
};

bus.use(asyncLogger);

// Simulated API (replace with real fetch in production)
const fakeUsers: User[] = [
  { id: 1, name: 'Alice', email: 'alice@example.com' },
  { id: 2, name: 'Bob', email: 'bob@example.com' },
];

let failCount = 0; // Simulate intermittent failures

// Handlers
bus.register('userFetch', async (cmd) => {
  const { id } = cmd.target as { id: number };

  // Simulate API delay
  await new Promise(r => setTimeout(r, 100));

  // Simulate occasional failures (first 2 attempts fail)
  if (failCount < 2) {
    failCount++;
    throw new Error('Network error');
  }
  failCount = 0;

  const user = fakeUsers.find(u => u.id === id);
  if (!user) {
    // A VERDICT, so a coded failure: `missing` is never re-sent, where a
    // plain throw (the "Network error" above) is, for this idempotent read.
    throw new BusError('missing:user', `User ${id} not found`, { context: { id } });
  }

  return user;
});

bus.register('userList', async () => {
  await new Promise(r => setTimeout(r, 100));
  return [...fakeUsers];
});

bus.register('userCreate', async (cmd) => {
  const userData = cmd.target as Omit<User, 'id'>;
  await new Promise(r => setTimeout(r, 100));

  const newUser: User = {
    id: fakeUsers.length + 1,
    ...userData
  };
  fakeUsers.push(newUser);

  return newUser;
});

bus.register('userUpdate', async (cmd) => {
  const { id } = cmd.target as { id: number };
  const updates = cmd.payload as Partial<User>;

  await new Promise(r => setTimeout(r, 100));

  const user = fakeUsers.find(u => u.id === id);
  if (!user) {
    throw new BusError('missing:user', `User ${id} not found`, { context: { id } });
  }

  Object.assign(user, updates);
  return user;
});

// Usage
async function main() {
  console.log('--- Fetching user (will retry on failure) ---');
  const fetchResult = await bus.dispatch('userFetch', { id: 1 });
  console.log('Result:', fetchResult);

  console.log('\n--- Listing all users ---');
  const listResult = await bus.dispatch('userList', null);
  console.log('Result:', listResult);

  console.log('\n--- Creating new user ---');
  const createResult = await bus.dispatch('userCreate', {
    name: 'Charlie',
    email: 'charlie@example.com'
  });
  console.log('Result:', createResult);

  console.log('\n--- Updating user ---');
  const updateResult = await bus.dispatch('userUpdate', { id: 1 }, { name: 'Alice Smith' });
  console.log('Result:', updateResult);

  console.log('\n--- Fetching non-existent user (not retried: a verdict) ---');
  const notFoundResult = await bus.dispatch('userFetch', { id: 999 });
  console.log('Result:', notFoundResult.ok ? notFoundResult.value : (notFoundResult.error as BusError | undefined)?.code); // 'app:missing:user'
}

main().catch(console.error);

export { bus };
