// Workload for scripts/ab/ab.mjs (perf-1.26 item c, the MIXED check): four DIFFERENT scoped
// plugins on one sync bus, each with its own pattern list (lengths 1..4, prefixes and
// exact names), so makeActionFilter's returned closure runs with mixed lists and mixed
// verdicts (hits and misses) - the real-app shape the isolated workload lacked.
// Dispatches cycle four actions; one row also carries a listener. Distinct handlers.
import { createCommandBus, cache, circuitBreaker, rateLimit, metrics } from '__DIST__/index.js';

function make(listener) {
  const bus = createCommandBus();
  bus.register('cartAdd', (cmd) => cmd.target + 1);
  bus.register('payNow', (cmd) => cmd.target + 2);
  bus.register('searchRun', (cmd) => cmd.target + 3);
  bus.register('uiToggle', (cmd) => cmd.target + 4);
  bus.use(cache({ actions: ['never*'] }));
  bus.use(circuitBreaker({ actions: ['pay*', 'checkout*'], threshold: 1e9 }));
  bus.use(rateLimit({ actions: ['zz*', 'yy*', 'searchRunX'], max: 1e9, window: 1e9 }));
  bus.use(metrics({ actions: ['cart*', 'pay*', 'search*', 'ui*'], maxEntries: 8 }));
  if (listener) bus.on('cart*', () => {});
  return bus;
}
const plain = make(false);
const heard = make(true);
const ACTIONS = ['cartAdd', 'payNow', 'searchRun', 'uiToggle'];
const run = (bus, n) => { let s = 0; for (let i = 0; i < n; i++) s += bus.dispatch(ACTIONS[i & 3], i).value; return s; };
export const N = { mixed4: 100_000, mixed4_listener: 100_000 };
export const mixed4 = (n) => run(plain, n);
export const mixed4_listener = (n) => run(heard, n);
export const check = () => [run(plain, 8), run(heard, 8)];
