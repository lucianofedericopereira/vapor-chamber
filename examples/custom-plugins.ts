/**
 * Custom Plugins Example
 *
 * Demonstrates: writing custom plugins for various use cases
 */

import { createCommandBus, type Plugin, type Command } from '../src';

// ============================================
// Plugin 1: Analytics
// ============================================
function analyticsPlugin(trackFn: (event: string, data: any) => void): Plugin {
  return (cmd, next) => {
    const start = performance.now();
    const result = next();

    trackFn('command_executed', {
      action: cmd.action,
      success: result.ok,
      duration: performance.now() - start,
      timestamp: Date.now()
    });

    return result;
  };
}

// ============================================
// Plugin 2: Auth Guard
// ============================================
function authGuardPlugin(
  isAuthenticated: () => boolean,
  protectedPrefixes: string[]
): Plugin {
  return (cmd, next) => {
    const isProtected = protectedPrefixes.some(p => cmd.action.startsWith(p));

    if (isProtected && !isAuthenticated()) {
      return {
        ok: false,
        error: new Error(`Unauthorized: ${cmd.action} requires authentication`)
      };
    }

    return next();
  };
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
    const result = next();

    if (!result.ok && rollback) {
      console.log(`Rolling back optimistic update for ${cmd.action}`);
      rollback();
    }

    return result;
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

  return (cmd, next) => {
    const now = Date.now();

    // Remove old requests outside the window
    while (requests.length > 0 && requests[0] < now - windowMs) {
      requests.shift();
    }

    if (requests.length >= maxRequests) {
      return {
        ok: false,
        error: new Error(`Rate limit exceeded. Max ${maxRequests} requests per ${windowMs}ms`)
      };
    }

    requests.push(now);
    return next();
  };
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
  ['admin.', 'user.delete']
));

bus.use(rateLimiterPlugin(3, 1000)); // Max 3 requests per second

bus.use(transformPlugin({
  'item.add': (cmd) => ({
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
  if (cmd.action === 'counter.increment') {
    const oldValue = optimisticState.value;
    optimisticState.value++; // Optimistic update
    return () => { optimisticState.value = oldValue; }; // Rollback
  }
  return null;
}));

bus.register('counter.increment', () => {
  // Simulate failure sometimes
  if (Math.random() > 0.5) throw new Error('Random failure');
  return optimisticState.value;
});

// Handlers
bus.register('item.add', (cmd) => {
  return { item: cmd.target, metadata: cmd.payload };
});

bus.register('admin.settings', (cmd) => {
  return { settings: cmd.target };
});

bus.register('public.info', () => {
  return { info: 'This is public' };
});

// Demo usage
console.log('--- Public action (no auth required) ---');
console.log(bus.dispatch('public.info', null));

console.log('\n--- Admin action (not authenticated) ---');
console.log(bus.dispatch('admin.settings', { theme: 'dark' }));

console.log('\n--- Login (set authenticated) ---');
authenticated = true;

console.log('\n--- Admin action (now authenticated) ---');
console.log(bus.dispatch('admin.settings', { theme: 'dark' }));

console.log('\n--- Item add with auto-transform ---');
console.log(bus.dispatch('item.add', { name: 'Widget' }, { quantity: 5 }));

console.log('\n--- Rate limit test (4 rapid requests) ---');
for (let i = 0; i < 4; i++) {
  const result = bus.dispatch('public.info', null);
  console.log(`Request ${i + 1}:`, result.ok ? 'OK' : result.error?.message);
}

console.log('\n--- Analytics events collected ---');
console.log(analyticsEvents);

export { bus };
