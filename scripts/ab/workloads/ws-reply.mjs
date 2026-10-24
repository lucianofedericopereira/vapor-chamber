// Workload for scripts/ab/ab.mjs (.probes/step-ritual.md item 14, step 3f): a command over a
// WebSocket and its reply frame, the path a push frame now shares (one `id` check first).
// The socket is a stand-in answering each frame on the next microtask. Arm A (1.31)
// installs the bridge as a plugin, arm B declares the transport at the bus.
import { createAsyncCommandBus } from '__DIST__/index.js';
import * as T from '__DIST__/transports.js';

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 1;
  onopen = null;
  onmessage = null;
  onclose = null;
  onerror = null;
  constructor() { queueMicrotask(() => this.onopen?.()); }
  send(data) {
    const { id } = JSON.parse(data);
    queueMicrotask(() => this.onmessage({ data: `{"id":"${id}","status":200,"state":1}` }));
  }
  close() { this.readyState = 3; }
}
globalThis.WebSocket = FakeSocket;

let bus;
if (typeof T.wsTransport === 'function') {
  const ws = T.wsTransport({ url: 'ws://fake', reconnect: false });
  bus = createAsyncCommandBus({ retry: false, transport: ws });
  ws.connect();
} else {
  const ws = T.createWsBridge({ url: 'ws://fake', reconnect: false });
  bus = createAsyncCommandBus({ retry: false });
  bus.use(ws);
  ws.connect();
}

const seq = async (n) => { let s = 0; for (let i = 0; i < n; i++) s += (await bus.dispatch('chatSend', { i })).value; return s; };

export const ASYNC = true;
export const N = { ws_reply: 20_000 };
export const ws_reply = (n) => seq(n);

/** Self-check: each dispatch is answered by its frame. */
export const check = async () => {
  const s = await seq(4);
  if (s !== 4) throw new Error(`answered ${s}, want 4`);
  return [s];
};
