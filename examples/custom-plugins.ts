/**
 * Custom Plugins Example
 *
 * Shows how to write an app's own plugin from parts. A plugin is an object,
 * and the bus runs each part where it belongs, so the outcome is the same
 * whatever the install order. `actions` and `actionFilter` scope a plugin to
 * the actions it concerns, so none needs a place in the install order.
 *   - started / settled: observe every outcome (analytics)
 *   - authorize: refuse before the work (auth guard, a read-only mode)
 *   - admit / begin: a limit that refuses, then takes its slot (rate limiter)
 * Two use cases need no plugin at all:
 *   - an optimistic update is `register(action, handler, { optimistic, undo })`
 *   - a value added to a command is minted at the call (`withTimestamp`)
 */

import { createCommandBus, err, type Command, type Fail, type PluginParts } from 'vapor-chamber';

// ============================================
// Plugin 1: Analytics (started + settled)
// ============================================
// `started` hears each command start, `settled` its outcome, a refusal
// included, so the timing covers every dispatch.
function analyticsPlugin(trackFn: (event: string, data: unknown) => void): PluginParts {
  const starts = new WeakMap<Command, number>();
  return {
    id: 'analytics',
    started: (cmd) => { starts.set(cmd, performance.now()); },
    settled: (cmd, result) => {
      const duration = performance.now() - (starts.get(cmd) ?? performance.now());
      trackFn('command_executed', { action: cmd.action, success: result.ok, duration, timestamp: Date.now() });
    },
  };
}

// ============================================
// Plugin 2: Auth guard (authorize)
// ============================================
// The scope names the protected actions, so the rule only decides. A refusal is
// `err(fail(...))`: `fail` mints the code, owned by the plugin's `id`
// (`authGuard:unauthenticated:action`). The built-in `authGuard()` does the same.
function authGuardPlugin(isAuthenticated: () => boolean, protectedActions: string[]): PluginParts {
  const rule = (cmd: Command, fail: Fail) =>
    isAuthenticated() ? undefined : err(fail('unauthenticated:action', `Unauthorized: ${cmd.action} requires authentication`, { action: cmd.action }));
  return { id: 'authGuard', actions: protectedActions, authorize: () => rule };
}

// ============================================
// Plugin 3: A client-wide gate (authorize)
// ============================================
// A read-only mode (maintenance, a lost session) refuses every write the app
// makes. A rule runs for a dispatch and a query alike, so the scope names what
// it gates: every action but the `public` reads.
function readOnlyGate(isReadOnly: () => boolean, isWrite: (action: string) => boolean): PluginParts {
  const rule = (cmd: Command, fail: Fail) =>
    isReadOnly() ? err(fail('refused:action', `Read-only mode: ${cmd.action} is refused`, { action: cmd.action })) : undefined;
  return { id: 'readOnly', actionFilter: isWrite, authorize: () => rule };
}

// ============================================
// Plugin 4: Rate limiter (admit + begin)
// ============================================
// `admit` only checks, so a command another rule refuses spends no slot;
// `begin` takes the slot when the command goes to its handler. The scope keeps
// the other actions out of its window. The built-in `rateLimit()` does the
// same per action.
function rateLimiterPlugin(maxRequests: number, windowMs: number, actions: string[]): PluginParts {
  const requests: number[] = [];
  return {
    id: 'rateLimiter',
    actions,
    admit: (cmd, fail) => {
      const now = Date.now();
      while (requests.length > 0 && requests[0] < now - windowMs) requests.shift();
      if (requests.length < maxRequests) return undefined;
      // `retryIn` declares when to come back: a caller and the outbox wait for it.
      const retryIn = requests[0] + windowMs - now;
      return err(fail('limited:action', `Rate limit exceeded. Max ${maxRequests} requests per ${windowMs}ms`, { action: cmd.action, context: { retryIn } }));
    },
    begin: () => { requests.push(Date.now()); return undefined; },
  };
}

// ============================================
// A value minted at the call
// ============================================
// The command is the sender's: the bus never rewrites it, so the sender adds
// the timestamp.
const withTimestamp = <P extends object>(payload: P): P & { addedAt: number } => ({ ...payload, addedAt: Date.now() });

// ============================================
// Demo
// ============================================

const bus = createCommandBus();

let authenticated = false;
let readOnly = false;
const analyticsEvents: unknown[] = [];

bus.use(analyticsPlugin((event, data) => {
  analyticsEvents.push({ event, data });
  console.log('[Analytics]', event, data);
}));
bus.use(authGuardPlugin(() => authenticated, ['admin*', 'userDelete']));
bus.use(readOnlyGate(() => readOnly, (action) => !action.startsWith('public')));
bus.use(rateLimiterPlugin(3, 1000, ['publicStatus'])); // Max 3 requests per second

// An optimistic update: the handler shows the change, and a throw runs the undo.
const optimisticState = { value: 0 };
bus.register('counterIncrement', () => {
  optimisticState.value++;
  if (Math.random() > 0.5) throw new Error('Random failure');
  return optimisticState.value;
}, { optimistic: true, undo: () => { optimisticState.value--; } });

bus.register('itemAdd', (cmd) => ({ item: cmd.target, metadata: cmd.payload }));
bus.register('adminSettings', (cmd) => ({ settings: cmd.target }));
bus.register('publicInfo', () => ({ info: 'This is public' }));
bus.register('publicStatus', () => ({ status: 'up' }));

/** The sender of `itemAdd`: it mints the timestamp. */
const addItem = (item: object, payload: object) => bus.dispatch('itemAdd', item, withTimestamp(payload));

console.log('--- Public action (no auth required) ---');
console.log(bus.dispatch('publicInfo', null));

console.log('\n--- Admin action (not authenticated) ---');
console.log(bus.dispatch('adminSettings', { theme: 'dark' }));

console.log('\n--- Login (set authenticated) ---');
authenticated = true;

console.log('\n--- Admin action (now authenticated) ---');
console.log(bus.dispatch('adminSettings', { theme: 'dark' }));

console.log('\n--- Item add, timestamped by its sender ---');
console.log(addItem({ name: 'Widget' }, { quantity: 5 }));

console.log('\n--- Optimistic update, rolled back when the handler fails ---');
const incremented = bus.dispatch('counterIncrement', null);
console.log(incremented.ok ? 'kept' : 'rolled back', '->', optimisticState.value);

console.log('\n--- Read-only mode: a write refused, a read answered ---');
readOnly = true;
const write = bus.dispatch('itemAdd', { name: 'Gadget' });
console.log('itemAdd:', write.ok ? 'OK' : write.error?.message);
const read = bus.dispatch('publicInfo', null);
console.log('publicInfo:', read.ok ? 'OK' : read.error?.message);
readOnly = false;

console.log('\n--- Rate limit test (4 rapid requests) ---');
for (let i = 0; i < 4; i++) {
  const result = bus.dispatch('publicStatus', null);
  console.log(`Request ${i + 1}:`, result.ok ? 'OK' : result.error?.message);
}

console.log('\n--- Analytics events collected ---');
console.log(analyticsEvents);

export { bus, addItem };
