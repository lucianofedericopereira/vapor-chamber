// Workload for scripts/ab/ab.mjs (log s35.134): an action the HTTP bridge does
// not match, against the same bus without a bridge.
import { createAsyncCommandBus } from '__DIST__/index.js';
import * as T from '__DIST__/transports.js';

// Either arm: 1.32 declares the transport at the bus, by pattern; 1.31 installs the bridge.
const sending = (options, endpoint, actions) => {
  if (T.httpTransport) {
    const t = T.httpTransport({ endpoint });
    return createAsyncCommandBus({ ...options, transport: Object.fromEntries(actions.map((p) => [p, t])) });
  }
  const bus = createAsyncCommandBus(options);
  bus.use(T.createHttpBridge({ endpoint, actions }));
  return bus;
};

const bare = createAsyncCommandBus({ retry: false });
bare.register('local', (cmd) => cmd.target + 1);
const bridged = sending({ retry: false }, '/vc', ['api*', 'remote*']);
bridged.register('local', (cmd) => cmd.target + 1);

const seq = async (bus, n) => { let s = 0; for (let i = 0; i < n; i++) s += (await bus.dispatch('local', i & 3)).value; return s; };
export const ASYNC = true;
export const N = { no_bridge: 100_000, bridge_miss: 100_000 };
export const no_bridge = (n) => seq(bare, n);
export const bridge_miss = (n) => seq(bridged, n);
