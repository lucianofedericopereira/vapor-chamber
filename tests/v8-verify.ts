/**
 * Quick V8 optimization verification — runs with node --experimental-strip-types
 */
import { createCommandBus, createAsyncCommandBus } from '../src/command-bus.ts';

let pass = 0, fail = 0;
function assert(cond: boolean, msg: string) { if (cond) { pass++; } else { fail++; console.error('FAIL:', msg); } }

// Test 1: basic dispatch works
const bus = createCommandBus();
bus.register('test', (cmd) => cmd.target * 2);
const r = bus.dispatch('test', 21);
assert(r.ok === true, 'dispatch ok');
assert(r.value === 42, 'dispatch value');

// Test 2: monomorphic results — both fields present
assert('error' in r, 'ok result has error field');
assert(r.error === undefined, 'ok result error is undefined');

// Test 3: error result shape
const r2 = bus.dispatch('noHandler', 1);
assert(r2.ok === false, 'error result ok=false');
assert('value' in r2, 'error result has value field');
assert(r2.value === undefined, 'error result value is undefined');
assert(r2.error instanceof Error, 'error result has Error');

// Test 4: query works
const q = bus.query('test', 10);
assert(q.ok === true, 'query ok');
assert(q.value === 20, 'query value');

// Test 5: emit works
let emitted = false;
bus.on('myEvent', () => { emitted = true; });
bus.emit('myEvent', 'data');
assert(emitted === true, 'emit fires listener');

// Test 6: meta stamped
let meta: any;
bus.register('metaTest', (cmd) => { meta = cmd.meta; });
bus.dispatch('metaTest', {});
assert(meta && typeof meta.id === 'string', 'meta.id is string');
assert(meta && typeof meta.ts === 'number', 'meta.ts is number');

// Test 7: beforeHooks with index loop
let beforeCalled = false;
bus.onBefore(() => { beforeCalled = true; });
bus.dispatch('test', 1);
assert(beforeCalled === true, 'beforeHook fired');

// Test 8: beforeHook cancel
const bus3 = createCommandBus();
bus3.register('x', () => 'val');
bus3.onBefore(() => { throw new Error('cancel'); });
const r3 = bus3.dispatch('x', 1);
assert(r3.ok === false, 'beforeHook cancel → ok=false');
assert(r3.error?.message === 'cancel', 'beforeHook cancel error message');
assert('value' in r3, 'cancel result has value field (monomorphic)');

// Test 9: plugins
const bus2 = createCommandBus();
let pluginSaw = false;
bus2.use((cmd, next) => { pluginSaw = true; return next(); });
bus2.register('x', () => 'ok');
bus2.dispatch('x', 1);
assert(pluginSaw === true, 'plugin ran');

// Test 10: async bus
const asyncBus = createAsyncCommandBus();
asyncBus.register('asyncTest', async (cmd) => cmd.target + 1);
const ar = await asyncBus.dispatch('asyncTest', 5);
assert(ar.ok === true, 'async dispatch ok');
assert(ar.value === 6, 'async dispatch value');
assert('error' in ar, 'async ok result has error field');

// Test 11: async error shape
const ar2 = await asyncBus.dispatch('noHandler', 1);
assert(ar2.ok === false, 'async error ok=false');
assert('value' in ar2, 'async error has value field');

// Test 12: batch dispatch
const bus4 = createCommandBus();
bus4.register('a', () => 1);
bus4.register('b', () => 2);
const br = bus4.dispatchBatch([{ action: 'a', target: 0 }, { action: 'b', target: 0 }]);
assert(br.ok === true, 'batch ok');
assert(br.successCount === 2, 'batch successCount');

// Performance sanity
const perfBus = createCommandBus();
perfBus.register('perf', (cmd) => cmd.target);
const start = performance.now();
for (let i = 0; i < 10_000; i++) {
  perfBus.dispatch('perf', i);
}
const elapsed = performance.now() - start;
console.log(`  10k dispatches: ${elapsed.toFixed(1)}ms`);
assert(elapsed < 500, '10k dispatches under 500ms');

console.log(`\nPassed: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);
