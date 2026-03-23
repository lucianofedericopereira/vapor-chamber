/**
 * BusError structured error system verification
 */
import { createCommandBus, BusError } from '../src/command-bus.ts';

let pass = 0, fail = 0;
function assert(cond: boolean, msg: string) { if (cond) { pass++; } else { fail++; console.error('FAIL:', msg); } }

// Test 1: No handler produces BusError with code
const bus = createCommandBus();
const r = bus.dispatch('missing', {});
assert(r.ok === false, 'missing handler → ok=false');
assert(r.error instanceof BusError, 'error is BusError');
const be = r.error as BusError;
assert(be.code === 'VC_CORE_NO_HANDLER', 'code is VC_CORE_NO_HANDLER');
assert(be.severity === 'error', 'severity is error');
assert(be.emitter === 'core', 'emitter is core');
assert(be.action === 'missing', 'action is "missing"');

// Test 2: Throttle produces BusError with code
const bus2 = createCommandBus();
bus2.register('t', () => 'ok', { throttle: 1000 });
bus2.dispatch('t', 1); // first call succeeds
const r2 = bus2.dispatch('t', 1); // second call should be throttled
assert(r2.ok === false, 'throttled → ok=false');
// The handler throws BusError which gets caught by tryCatchHandler
assert(r2.error instanceof BusError, 'throttle error is BusError');
const te = r2.error as BusError;
assert(te.code === 'VC_CORE_THROTTLED', 'code is VC_CORE_THROTTLED');
assert(te.context?.retryIn !== undefined, 'context has retryIn');

// Test 3: Request timeout produces BusError
const bus3 = createCommandBus();
bus3.respond('slow', async () => new Promise(() => {})); // never resolves
const r3 = await bus3.request('slow', {}, undefined, { timeout: 50 });
assert(r3.ok === false, 'timeout → ok=false');
assert(r3.error instanceof BusError, 'timeout error is BusError');
const toe = r3.error as BusError;
assert(toe.code === 'VC_CORE_REQUEST_TIMEOUT', 'code is VC_CORE_REQUEST_TIMEOUT');
assert(toe.context?.timeout === 50, 'context has timeout=50');

// Test 4: BusError instanceof Error
assert(be instanceof Error, 'BusError instanceof Error');
assert(be.name === 'BusError', 'name is BusError');

// Test 5: switch on code works (LLM pattern)
let handled = false;
switch (be.code) {
  case 'VC_CORE_NO_HANDLER': handled = true; break;
  default: break;
}
assert(handled, 'switch on code works');

// Test 6: Normal errors still work as Error
bus.register('throws', () => { throw new Error('custom'); });
const r4 = bus.dispatch('throws', {});
assert(r4.ok === false, 'thrown → ok=false');
assert(r4.error instanceof Error, 'custom error is Error');
assert(r4.error?.message === 'custom', 'custom error message preserved');

console.log(`\nPassed: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);
