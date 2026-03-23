/**
 * Tests for utilities, plugins-extra, and schema additions.
 *
 * We import from command-bus.ts directly and inline-import the other modules
 * since Node's strip-types doesn't resolve extensionless imports in library sources.
 * The actual vitest suite covers the real import paths.
 */
import {
  createCommandBus,
  createAsyncCommandBus,
  BusError,
  matchesPattern,
  commandKey,
  type Command,
  type CommandResult,
  type Plugin,
  type BaseBus,
} from '../src/command-bus.ts';

let pass = 0, fail = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { pass++; }
  else { fail++; console.error('FAIL:', msg); }
}

// ═══════════════════════════════════════════════════════════════════
// Inline createChamber (tests the pattern, not import)
// ═══════════════════════════════════════════════════════════════════

function createChamber(namespace: string, handlers: Record<string, any>) {
  function actionName(shortName: string): string {
    return namespace + shortName.charAt(0).toUpperCase() + shortName.slice(1);
  }
  function install(bus: BaseBus): () => void {
    const unsubs: Array<() => void> = [];
    for (const [short, handler] of Object.entries(handlers)) {
      unsubs.push(bus.register(actionName(short), handler));
    }
    return () => { unsubs.forEach(fn => fn()); };
  }
  return { namespace, install, actionName };
}

{
  const bus = createCommandBus();
  const calls: string[] = [];

  const cart = createChamber('cart', {
    add: (cmd: Command) => { calls.push('add:' + cmd.target); return 'added'; },
    remove: (cmd: Command) => { calls.push('remove:' + cmd.target); return 'removed'; },
    clear: () => { calls.push('clear'); return 'cleared'; },
  });

  assert(cart.namespace === 'cart', 'chamber namespace');
  assert(cart.actionName('add') === 'cartAdd', 'chamber camelCase');

  const unsub = cart.install(bus);
  const r1 = bus.dispatch('cartAdd', 'item1');
  assert(r1.ok && r1.value === 'added', 'chamber dispatch');
  assert(calls.length === 1 && calls[0] === 'add:item1', 'chamber handler ran');

  unsub();
  const r2 = bus.dispatch('cartAdd', 'x');
  assert(!r2.ok, 'chamber uninstall works');
}

// ═══════════════════════════════════════════════════════════════════
// Inline createWorkflow
// ═══════════════════════════════════════════════════════════════════

type WorkflowStep = { action: string; compensate?: string; };

function createWorkflow(steps: WorkflowStep[]) {
  async function run(bus: BaseBus, target: any, payload?: any) {
    const results: CommandResult[] = [];
    const compensateActions: string[] = [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      let result: CommandResult;
      try {
        const dispatched = bus.dispatch(step.action, target, payload);
        result = dispatched && typeof (dispatched as any).then === 'function' ? await dispatched : dispatched;
      } catch (e) { result = { ok: false, error: e as Error }; }
      results.push(result);
      if (!result.ok) {
        const compensations: CommandResult[] = [];
        for (let j = compensateActions.length - 1; j >= 0; j--) {
          try {
            const comp = bus.dispatch(compensateActions[j], target, payload);
            compensations.push(comp && typeof (comp as any).then === 'function' ? await comp : comp);
          } catch (e) { compensations.push({ ok: false, error: e as Error }); }
        }
        return { ok: false, results, failedAt: i, error: result.error, compensations };
      }
      if (step.compensate) compensateActions.push(step.compensate);
    }
    return { ok: true, results };
  }
  return { run, steps };
}

{
  const bus = createCommandBus();
  bus.register('validate', () => 'valid');
  bus.register('charge', () => 'charged');
  bus.register('ship', () => 'shipped');

  const wf = createWorkflow([
    { action: 'validate' },
    { action: 'charge', compensate: 'refund' },
    { action: 'ship' },
  ]);

  const result = await wf.run(bus, { orderId: 1 });
  assert(result.ok === true, 'workflow happy path');
  assert(result.results.length === 3, 'workflow 3 results');
}

{
  const bus = createCommandBus();
  const compensated: string[] = [];
  bus.register('step1', () => 'ok1');
  bus.register('step2', () => { throw new Error('fail'); });
  bus.register('undo1', () => { compensated.push('undo1'); });

  const wf = createWorkflow([
    { action: 'step1', compensate: 'undo1' },
    { action: 'step2' },
  ]);

  const result = await wf.run(bus, {});
  assert(result.ok === false, 'workflow fail');
  assert(result.failedAt === 1, 'workflow failedAt');
  assert(compensated.includes('undo1'), 'workflow compensated');
}

// ═══════════════════════════════════════════════════════════════════
// Inline createReaction
// ═══════════════════════════════════════════════════════════════════

{
  const bus = createCommandBus();
  const reacted: any[] = [];
  bus.register('source', () => 'srcResult');
  bus.register('target', (cmd: Command) => { reacted.push(cmd.target); });

  const unsub = bus.on('source', (cmd, result) => {
    if (result.ok) {
      bus.dispatch('target', { derived: cmd.target });
    }
  });

  bus.dispatch('source', 'data1');
  assert(reacted.length === 1, 'reaction fired');
  assert(reacted[0].derived === 'data1', 'reaction mapped');

  unsub();
  bus.dispatch('source', 'data2');
  assert(reacted.length === 1, 'reaction unsubscribed');
}

// ═══════════════════════════════════════════════════════════════════
// Inline cache plugin
// ═══════════════════════════════════════════════════════════════════

function cachePlugin(opts: { ttl?: number; maxSize?: number } = {}) {
  const { ttl = 30000, maxSize = 100 } = opts;
  const store = new Map<string, { result: CommandResult; expiresAt: number }>();

  const plugin: Plugin = (cmd, next) => {
    const k = commandKey(cmd.action, cmd.target);
    const cached = store.get(k);
    if (cached && cached.expiresAt > Date.now()) {
      store.delete(k);
      store.set(k, cached);
      return cached.result;
    }
    store.delete(k);
    const result = next();
    if (result.ok) {
      store.set(k, { result, expiresAt: Date.now() + ttl });
      while (store.size > maxSize) {
        const firstKey = store.keys().next().value;
        if (firstKey !== undefined) store.delete(firstKey);
      }
    }
    return result;
  };

  return Object.assign(plugin, {
    size: () => store.size,
    clear: () => store.clear(),
  });
}

{
  const bus = createCommandBus();
  let callCount = 0;
  bus.register('getData', () => { callCount++; return 'data'; });

  const c = cachePlugin({ ttl: 5000 });
  bus.use(c);

  bus.dispatch('getData', { id: 1 });
  assert(callCount === 1, 'cache first call');

  bus.dispatch('getData', { id: 1 });
  assert(callCount === 1, 'cache hit');

  bus.dispatch('getData', { id: 2 });
  assert(callCount === 2, 'cache miss different target');

  assert(c.size() === 2, 'cache size');
  c.clear();
  assert(c.size() === 0, 'cache clear');
}

// ═══════════════════════════════════════════════════════════════════
// Inline circuitBreaker plugin
// ═══════════════════════════════════════════════════════════════════

{
  const bus = createCommandBus();
  bus.register('flaky', () => { throw new Error('fail'); });

  let opened = false;
  // Manual circuit breaker inline
  const circuits = new Map<string, { state: string; failCount: number; openedAt: number }>();
  const threshold = 3;
  const resetTimeout = 100;

  const cbPlugin: Plugin = (cmd, next) => {
    let c = circuits.get(cmd.action);
    if (!c) { c = { state: 'closed', failCount: 0, openedAt: 0 }; circuits.set(cmd.action, c); }
    if (c.state === 'open') {
      if (Date.now() - c.openedAt >= resetTimeout) c.state = 'half-open';
      else return { ok: false, value: undefined, error: new BusError('VC_PLUGIN_CIRCUIT_OPEN', 'open', { emitter: 'plugin', action: cmd.action }) };
    }
    const result = next();
    if (result.ok) { if (c.state === 'half-open') { c.state = 'closed'; } c.failCount = 0; }
    else { c.failCount++; if (c.failCount >= threshold) { c.state = 'open'; c.openedAt = Date.now(); opened = true; } }
    return result;
  };

  bus.use(cbPlugin);

  bus.dispatch('flaky', 1);
  bus.dispatch('flaky', 1);
  bus.dispatch('flaky', 1);
  assert(opened, 'circuit opened after threshold');

  const blocked = bus.dispatch('flaky', 1);
  assert(!blocked.ok, 'circuit rejects when open');
  assert(blocked.error instanceof BusError, 'circuit BusError');
  assert((blocked.error as BusError).code === 'VC_PLUGIN_CIRCUIT_OPEN', 'circuit error code');
}

// ═══════════════════════════════════════════════════════════════════
// Inline rateLimit plugin
// ═══════════════════════════════════════════════════════════════════

{
  const bus = createCommandBus();
  bus.register('api', () => 'ok');

  const windows = new Map<string, number[]>();
  const max = 3;
  const windowMs = 1000;

  const rlPlugin: Plugin = (cmd, next) => {
    const now = Date.now();
    let timestamps = windows.get(cmd.action);
    if (!timestamps) { timestamps = []; windows.set(cmd.action, timestamps); }
    const cutoff = now - windowMs;
    while (timestamps.length > 0 && timestamps[0] <= cutoff) timestamps.shift();
    if (timestamps.length >= max) {
      return { ok: false, value: undefined, error: new BusError('VC_PLUGIN_RATE_LIMITED', 'limited', { emitter: 'plugin', action: cmd.action }) };
    }
    timestamps.push(now);
    return next();
  };

  bus.use(rlPlugin);

  const r1 = bus.dispatch('api', 1);
  const r2 = bus.dispatch('api', 2);
  const r3 = bus.dispatch('api', 3);
  assert(r1.ok && r2.ok && r3.ok, 'rateLimit allows max');

  const r4 = bus.dispatch('api', 4);
  assert(!r4.ok, 'rateLimit blocks over max');
  assert(r4.error instanceof BusError, 'rateLimit BusError');
  assert((r4.error as BusError).code === 'VC_PLUGIN_RATE_LIMITED', 'rateLimit code');
}

// ═══════════════════════════════════════════════════════════════════
// Inline metrics plugin
// ═══════════════════════════════════════════════════════════════════

{
  const bus = createCommandBus();
  bus.register('fast', () => 'ok');
  bus.register('slow', () => { throw new Error('err'); });

  const data: Array<{ action: string; ok: boolean; durationMs: number }> = [];
  const mPlugin: Plugin = (cmd, next) => {
    const start = performance.now();
    const result = next();
    data.push({ action: cmd.action, ok: result.ok, durationMs: performance.now() - start });
    return result;
  };

  bus.use(mPlugin);
  bus.dispatch('fast', 1);
  bus.dispatch('fast', 2);
  bus.dispatch('slow', 3);

  assert(data.length === 3, 'metrics 3 entries');
  assert(data[0].action === 'fast' && data[0].ok, 'metrics fast ok');
  assert(data[2].action === 'slow' && !data[2].ok, 'metrics slow fail');
}

// ═══════════════════════════════════════════════════════════════════
// BusError integration
// ═══════════════════════════════════════════════════════════════════

{
  // No handler → BusError
  const bus = createCommandBus();
  const r = bus.dispatch('nope', {});
  assert(r.error instanceof BusError, 'no handler → BusError');
  const be = r.error as BusError;
  assert(be.code === 'VC_CORE_NO_HANDLER', 'error code');
  assert(be.emitter === 'core', 'emitter');
  assert(be.action === 'nope', 'action in error');

  // Throttle → BusError
  bus.register('throttled', () => 'ok', { throttle: 5000 });
  bus.dispatch('throttled', 1);
  const r2 = bus.dispatch('throttled', 1);
  assert(r2.error instanceof BusError, 'throttle → BusError');
  assert((r2.error as BusError).code === 'VC_CORE_THROTTLED', 'throttle code');

  // instanceof Error
  assert(be instanceof Error, 'BusError extends Error');
  assert(be.name === 'BusError', 'BusError.name');
}

// ═══════════════════════════════════════════════════════════════════
// matchesPattern (already tested in core, just verify here)
// ═══════════════════════════════════════════════════════════════════

{
  assert(matchesPattern('*', 'anything') === true, 'wildcard *');
  assert(matchesPattern('cart*', 'cartAdd') === true, 'prefix match');
  assert(matchesPattern('cart*', 'userAdd') === false, 'prefix no match');
  assert(matchesPattern('cartAdd', 'cartAdd') === true, 'exact match');
  assert(matchesPattern('cartAdd', 'cartRemove') === false, 'exact no match');
}

// ═══════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════

console.log(`\nPassed: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);
