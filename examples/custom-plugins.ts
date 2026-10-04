/**
 * Custom Plugins Example
 *
 * Demonstrates: writing custom plugins for various use cases
 */

import { createCommandBus, err, onSettled, type Plugin, type Command } from 'vapor-chamber';

// ============================================
// Plugin 1: Analytics
// ============================================
// A `Plugin` runs on either bus, so `next()` may be a promise: read the result
// through `onSettled`, which stays sync on the sync bus.
function analyticsPlugin(trackFn: (event: string, data: any) => void): Plugin {
  return (cmd, next) => {
    const start = performance.now();
    return onSettled(next(), (result) => {
      trackFn('command_executed', {
        action: cmd.action,
        success: result.ok,
        duration: performance.now() - start,
        timestamp: Date.now()
      });
      return result;
    });
  };
}

// ============================================
// Plugin 2: Auth Guard
// ============================================
function authGuardPlugin(
  isAuthenticated: () => boolean,
  protectedPrefixes: string[]
): Plugin {
  // A plugin refuses with `err(fail(...))`: `fail`, the third argument, mints
  // the code (`authGuard:unauthenticated:action`, owned by the plugin's `id`:
  // no session is `unauthenticated`, sign in then retry), and
  // `err` builds the bus's own result shape.
  const plugin: Plugin = (cmd, next, fail) => {
    const isProtected = protectedPrefixes.some(p => cmd.action.startsWith(p));

    if (isProtected && !isAuthenticated()) {
      return err(fail('unauthenticated:action', `Unauthorized: ${cmd.action} requires authentication`, { action: cmd.action }));
    }

    return next();
  };
  return Object.assign(plugin, { id: 'authGuard' });
}

// ============================================
// Plugin 3: Optimistic Updates
// ============================================
type RollbackFn = () => void;

function optimisticPlugin(
  applyOptimistic: (cmd: Command) => RollbackFn | null
): Plugin {
  return (cmd, next) => {
    const rollback = applyOptimistic(cmd);
    return onSettled(next(), (result) => {
      if (!result.ok && rollback) {
        console.log(`Rolling back optimistic update for ${cmd.action}`);
        rollback();
      }
      return result;
    });
  };
}

// ============================================
// Plugin 4: Rate Limiter
// ============================================
function rateLimiterPlugin(
  maxRequests: number,
  windowMs: number
): Plugin {
  const requests: number[] = [];

  const plugin: Plugin = (cmd, next, fail) => {
    const now = Date.now();

    // Remove old requests outside the window
    while (requests.length > 0 && requests[0] < now - windowMs) {
      requests.shift();
    }

    if (requests.length >= maxRequests) {
      // `retryIn` declares when to come back: a caller and the outbox wait for it.
      const retryIn = requests[0] + windowMs - now;
      return err(fail('limited:action', `Rate limit exceeded. Max ${maxRequests} requests per ${windowMs}ms`, { action: cmd.action, context: { retryIn } }));
    }

    requests.push(now);
    return next();
  };
  return Object.assign(plugin, { id: 'rateLimiter' });
}

// ============================================
// Plugin 5: Command Transform
// ============================================
function transformPlugin(
  transforms: Record<string, (cmd: Command) => Command>
): Plugin {
  return (cmd, next) => {
    const transform = transforms[cmd.action];
    if (transform) {
      const transformed = transform(cmd);
      // Modify the cmd object in place (plugins share the same cmd reference)
      Object.assign(cmd, transformed);
    }
    return next();
  };
}

// ============================================
// Demo
// ============================================

const bus = createCommandBus();

// Mock functions
let authenticated = false;
const analyticsEvents: any[] = [];

// Add plugins
bus.use(analyticsPlugin((event, data) => {
  analyticsEvents.push({ event, data });
  console.log('[Analytics]', event, data);
}));

bus.use(authGuardPlugin(
  () => authenticated,
  ['admin', 'userDelete']
));

bus.use(rateLimiterPlugin(3, 1000)); // Max 3 requests per second

bus.use(transformPlugin({
  'itemAdd': (cmd) => ({
    ...cmd,
    payload: {
      ...cmd.payload,
      addedAt: Date.now() // Auto-add timestamp
    }
  })
}));

// Demo optimistic updates
const optimisticState = { value: 0 };
bus.use(optimisticPlugin((cmd) => {
  if (cmd.action === 'counterIncrement') {
    const oldValue = optimisticState.value;
    optimisticState.value++; // Optimistic update
    return () => { optimisticState.value = oldValue; }; // Rollback
  }
  return null;
}));

bus.register('counterIncrement', () => {
  // Simulate failure sometimes
  if (Math.random() > 0.5) throw new Error('Random failure');
  return optimisticState.value;
});

// Handlers
bus.register('itemAdd', (cmd) => {
  return { item: cmd.target, metadata: cmd.payload };
});

bus.register('adminSettings', (cmd) => {
  return { settings: cmd.target };
});

bus.register('publicInfo', () => {
  return { info: 'This is public' };
});

// Demo usage
console.log('--- Public action (no auth required) ---');
console.log(bus.dispatch('publicInfo', null));

console.log('\n--- Admin action (not authenticated) ---');
console.log(bus.dispatch('adminSettings', { theme: 'dark' }));

console.log('\n--- Login (set authenticated) ---');
authenticated = true;

console.log('\n--- Admin action (now authenticated) ---');
console.log(bus.dispatch('adminSettings', { theme: 'dark' }));

console.log('\n--- Item add with auto-transform ---');
console.log(bus.dispatch('itemAdd', { name: 'Widget' }, { quantity: 5 }));

console.log('\n--- Optimistic update, rolled back when the handler fails ---');
const incremented = bus.dispatch('counterIncrement', null);
console.log(incremented.ok ? 'kept' : 'rolled back', '->', optimisticState.value);

console.log('\n--- Rate limit test (4 rapid requests) ---');
for (let i = 0; i < 4; i++) {
  const result = bus.dispatch('publicInfo', null);
  console.log(`Request ${i + 1}:`, result.ok ? 'OK' : result.error?.message);
}

console.log('\n--- Analytics events collected ---');
console.log(analyticsEvents);

export { bus };
