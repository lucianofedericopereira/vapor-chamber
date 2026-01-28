/**
 * Async API Example
 *
 * Demonstrates: async command bus, async plugins, error handling
 */

import { createAsyncCommandBus, type AsyncPlugin } from '../src';

// Types
interface User {
  id: number;
  name: string;
  email: string;
}

// Create async bus
const bus = createAsyncCommandBus();

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

// Retry plugin - retries failed commands up to 3 times
const retryPlugin: AsyncPlugin = async (cmd, next) => {
  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const result = await next();

    if (result.ok) {
      return result;
    }

    if (attempt < maxRetries) {
      console.log(`Attempt ${attempt} failed, retrying in ${attempt}s...`);
      await new Promise(r => setTimeout(r, attempt * 1000));
    }
  }

  return { ok: false, error: new Error('Max retries exceeded') };
};

// Only apply retry to specific actions
const retryableActions = ['user.fetch', 'user.update'];
bus.use(async (cmd, next) => {
  if (retryableActions.includes(cmd.action)) {
    return retryPlugin(cmd, next);
  }
  return next();
});

// Simulated API (replace with real fetch in production)
const fakeUsers: User[] = [
  { id: 1, name: 'Alice', email: 'alice@example.com' },
  { id: 2, name: 'Bob', email: 'bob@example.com' },
];

let failCount = 0; // Simulate intermittent failures

// Handlers
bus.register('user.fetch', async (cmd) => {
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
    throw new Error(`User ${id} not found`);
  }

  return user;
});

bus.register('user.list', async () => {
  await new Promise(r => setTimeout(r, 100));
  return [...fakeUsers];
});

bus.register('user.create', async (cmd) => {
  const userData = cmd.target as Omit<User, 'id'>;
  await new Promise(r => setTimeout(r, 100));

  const newUser: User = {
    id: fakeUsers.length + 1,
    ...userData
  };
  fakeUsers.push(newUser);

  return newUser;
});

bus.register('user.update', async (cmd) => {
  const { id } = cmd.target as { id: number };
  const updates = cmd.payload as Partial<User>;

  await new Promise(r => setTimeout(r, 100));

  const user = fakeUsers.find(u => u.id === id);
  if (!user) {
    throw new Error(`User ${id} not found`);
  }

  Object.assign(user, updates);
  return user;
});

// Usage
async function main() {
  console.log('--- Fetching user (will retry on failure) ---');
  const fetchResult = await bus.dispatch('user.fetch', { id: 1 });
  console.log('Result:', fetchResult);

  console.log('\n--- Listing all users ---');
  const listResult = await bus.dispatch('user.list', null);
  console.log('Result:', listResult);

  console.log('\n--- Creating new user ---');
  const createResult = await bus.dispatch('user.create', {
    name: 'Charlie',
    email: 'charlie@example.com'
  });
  console.log('Result:', createResult);

  console.log('\n--- Updating user ---');
  const updateResult = await bus.dispatch('user.update', { id: 1 }, { name: 'Alice Smith' });
  console.log('Result:', updateResult);

  console.log('\n--- Fetching non-existent user ---');
  const notFoundResult = await bus.dispatch('user.fetch', { id: 999 });
  console.log('Result:', notFoundResult);
}

main().catch(console.error);

export { bus };
