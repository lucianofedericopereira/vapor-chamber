/**
 * Supplemental coverage for src/mcp.ts, plus a regression test for the
 * inherited-key hole in the tools/call gate.
 *
 *  - tools/call name gate: `schema[name] === undefined` walked the prototype
 *    chain, so `constructor` / `toString` / `__proto__` / `hasOwnProperty`
 *    passed as "known tools" and reached bus.dispatch - names tools/list never
 *    advertises. Now Object.hasOwn.
 *  - callTool's dispatch-throws arm.
 *  - a malformed envelope with NO id - a notification, which must never be
 *    answered even when invalid.
 *  - a non-object payload passing through untouched.
 *  - tool mapping without required fields and without a description.
 *  - serveMcpStdio: the no-Node guard, blank-line skip,
 *    parse errors, notification silence, and stop().
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createMcpHandler, busToMcpTools, serveMcpStdio, agentOrigin } from '../src/mcp';
import type { BusSchema } from '../src/schema';
import { mcpClient } from '../src/vitest-pure';

const SCHEMA = {
  cartAdd: { description: 'Add an item', target: { id: 'number' }, payload: { qty: 'number' } },
} as unknown as BusSchema;

function makeHandler(overrides: { dispatch?: any; schema?: BusSchema; actions?: string[] } = {}) {
  const dispatch = overrides.dispatch ?? vi.fn(async () => ({ ok: true, value: 'done' }));
  const handle = createMcpHandler(
    { dispatch, getSchema: () => overrides.schema ?? SCHEMA },
    { actions: overrides.actions ?? ['*'] },
  );
  return { handle, mcp: mcpClient(handle), dispatch };
}

/** Detached in afterEach so a failing assertion cannot leak a stdin listener
 *  into the next test (it would answer that test's input through its spy). */
const stops: Array<() => void> = [];

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// tools/call name gate - inherited keys (regression)
// ---------------------------------------------------------------------------

describe('tools/call rejects inherited Object.prototype keys', () => {
  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'])(
    'refuses "%s" and never dispatches it',
    async (name) => {
      const { mcp, dispatch } = makeHandler();

      expect(await mcp.call(name, {})).toBeToolError('unknown or not permitted');
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it('keeps dispatching real own-key tools', async () => {
    const { mcp, dispatch } = makeHandler();
    expect(await mcp.call('cartAdd', { target: { id: 1 }, payload: { qty: 2 } })).toBeToolResult();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('is consistent with tools/list - an unlisted name is uncallable', async () => {
    const { mcp } = makeHandler();
    expect(await mcp.toolNames()).toEqual(['cartAdd']);

    expect(await mcp.call('constructor', {})).toBeToolError();
  });
});

// ---------------------------------------------------------------------------
// callTool arms
// ---------------------------------------------------------------------------

describe('callTool', () => {
  it('turns a throwing dispatch into an error result, not a protocol error', async () => {
    const dispatch = vi.fn(() => { throw new Error('handler exploded'); });
    const { mcp } = makeHandler({ dispatch });

    // call() throws on a protocol error, so a returned result is not one.
    // tool failures are results
    expect(await mcp.call('cartAdd', { target: { id: 1 } })).toBeToolError('handler exploded');
  });

  it('refuses a non-object payload instead of dispatching it unattributed', async () => {
    // BEHAVIOR CHANGE. This used to assert the payload was forwarded
    // untouched, on the reasoning that schema validation would reject it
    // downstream. With a MOCKED dispatch that looked fine - but the mock is
    // exactly what hid the problem: schema.ts only checks payload shape when
    // the action declares payload fields, so against a REAL bus an action
    // without a payload schema dispatched the bare value successfully, with
    // `meta.origin === undefined`. The marker cannot ride on a primitive or
    // array, so those agent commands were indistinguishable from local ones.
    // See the end-to-end assertion in tests/mcp.test.ts.
    const dispatch = vi.fn(async (_action: string, _target: unknown, _payload?: unknown) => ({ ok: true as const, value: 1 }));
    const { mcp } = makeHandler({ dispatch });

    for (const bad of ['a bare string', [1, 2], 42, true]) {
      expect(await mcp.call('cartAdd', { target: { id: 1 }, payload: bad })).toBeToolError(/payload must be an object/);
    }
    // Refused at the boundary - the bus is never reached at all.
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('forwards the payload to the bus untouched', async () => {
    // Was: asserted the payload arrived spread with `__origin: 'agent'`. The
    // marker now travels out-of-band via `_withOrigin`, so the bus receives
    // exactly what the client sent - by reference, with no allocation and no
    // key injected into user data.
    //
    // NOTE: `dispatch` is MOCKED here, so `meta.origin` does not exist to
    // assert - a mock cannot show attribution, which is precisely how the
    // original attribution hole hid. The end-to-end guarantee is pinned
    // against a REAL bus in tests/mcp.test.ts ("never lets an MCP dispatch
    // reach a handler unattributed").
    const dispatch = vi.fn(async (_action: string, _target: unknown, _payload?: unknown) => ({ ok: true as const, value: 1 }));
    const { mcp } = makeHandler({ dispatch });

    const sent = { qty: 2 };
    await mcp.call('cartAdd', { target: { id: 1 }, payload: sent });
    expect(dispatch.mock.calls[0]![2]).toBe(sent); // same object, not a copy
    expect(dispatch.mock.calls[0]![2]).toEqual({ qty: 2 }); // no marker key

    await mcp.call('cartAdd', { target: { id: 1 } });
    expect(dispatch.mock.calls[1]![2]).toBeUndefined(); // absent stays absent
  });

  it('rejects a missing tool name', async () => {
    const { mcp, dispatch } = makeHandler();
    expect(await mcp.call('', {})).toBeToolError();
    expect(dispatch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// envelope handling
// ---------------------------------------------------------------------------

describe('JSON-RPC envelope', () => {
  it('never answers a malformed NOTIFICATION', async () => {
    const { handle } = makeHandler();
    // Bad jsonrpc version, no id -> a notification: MUST NOT be replied to.
    expect(await handle({ jsonrpc: '1.0', method: 'tools/list' })).toBeNull();
    expect(await handle({ jsonrpc: '2.0' })).toBeNull(); // no method, no id
  });

  it('answers a malformed REQUEST (one with an id)', async () => {
    const { handle } = makeHandler();
    const reply: any = await handle({ jsonrpc: '1.0', id: 7, method: 'tools/list' });
    expect(reply.error.code).toBe(-32600);
    expect(reply.id).toBe(7);
  });

  it('rejects a non-object message', async () => {
    const { handle } = makeHandler();
    const reply: any = await handle([1, 2, 3]);
    expect(reply.error.code).toBe(-32600);
  });
});

// ---------------------------------------------------------------------------
// tool mapping arms
// ---------------------------------------------------------------------------

describe('busToMcpTools', () => {
  it("omits `required` when every field is 'any'", () => {
    const [tool] = busToMcpTools({ ping: { target: { anything: 'any' } } } as unknown as BusSchema);
    expect(tool!.inputSchema.properties.target.required).toBeUndefined();
    expect(tool!.inputSchema.properties.target.properties.anything).toEqual({});
  });

  it('omits `description` when the action declares none', () => {
    const [tool] = busToMcpTools({ ping: { target: { id: 'number' } } } as unknown as BusSchema);
    expect(tool!.description).toBeUndefined();
    expect(tool!.inputSchema.required).toEqual(['target']);
  });
});

describe('agentOrigin', () => {
  it('is a pass-through no-op', () => {
    const next = vi.fn(() => ({ ok: true, value: 1 }));
    expect(agentOrigin()({ action: 'x' } as any, next as any)).toEqual({ ok: true, value: 1 });
    expect(next).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// serveMcpStdio
// ---------------------------------------------------------------------------

describe('serveMcpStdio', () => {
  it('throws outside Node', () => {
    vi.stubGlobal('process', undefined);
    expect(() => serveMcpStdio({ dispatch: vi.fn(), getSchema: () => SCHEMA })).toThrow(
      /requires a Node\.js environment/,
    );
  });

  it('answers requests, skips blank lines, and reports parse errors', async () => {
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { written.push(s); return true; }) as any);
    stops.push(serveMcpStdio({ dispatch: vi.fn(async () => ({ ok: true as const, value: 'ok' })), getSchema: () => SCHEMA }, { actions: ['*'] }));

    // Blank lines between real messages must be skipped, not parse-errored.
    process.stdin.emit('data', '\n\n' + JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\n');
    process.stdin.emit('data', 'not json at all\n');
    // A notification produces no output.
    process.stdin.emit('data', JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    await new Promise(r => setTimeout(r, 0));

    // Matched by id, not position: replies are written in COMPLETION order.
    // The parse error is produced synchronously while the ping goes through the
    // async handler, so the error lands first - legal JSON-RPC (responses may
    // be out of order; `id` correlates), and worth pinning as actual behaviour.
    const replies = written.map(w => JSON.parse(w));
    expect(replies).toHaveLength(2);
    expect(replies.find(r => r.id === 1)).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
    expect(replies.find(r => r.id === null).error.code).toBe(-32700);
  });

  it('buffers a message split across chunks', async () => {
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { written.push(s); return true; }) as any);
    stops.push(serveMcpStdio({ dispatch: vi.fn(), getSchema: () => SCHEMA }, { actions: ['*'] }));

    const msg = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' });
    process.stdin.emit('data', msg.slice(0, 10));
    process.stdin.emit('data', msg.slice(10) + '\n');
    await new Promise(r => setTimeout(r, 0));

    expect(JSON.parse(written[0]!)).toEqual({ jsonrpc: '2.0', id: 2, result: {} });
  });

  it('stop() detaches - later input produces no output', async () => {
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { written.push(s); return true; }) as any);
    const stop = serveMcpStdio({ dispatch: vi.fn(), getSchema: () => SCHEMA }, { actions: ['*'] });
    stop();

    process.stdin.emit('data', JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }) + '\n');
    await new Promise(r => setTimeout(r, 0));
    expect(written).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// serveMcpStdio - input-driven limits
// ---------------------------------------------------------------------------

describe('serveMcpStdio limits', () => {
  function capture(): string[] {
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { written.push(s); return true; }) as any);
    return written;
  }

  it('abandons an over-long line and resynchronises at the next newline', async () => {
    const written = capture();
    stops.push(serveMcpStdio(
      { dispatch: vi.fn(async () => ({ ok: true as const, value: 'ok' })), getSchema: () => SCHEMA },
      { actions: ['*'], maxLineLength: 64 },
    ));

    // A client streaming a huge "line" with no newline in sight.
    process.stdin.emit('data', 'x'.repeat(200));
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0]!).error.code).toBe(-32700);
    expect(JSON.parse(written[0]!).error.message).toMatch(/exceeds 64 characters/);

    // The tail of that line is discarded, and the NEXT line still works.
    process.stdin.emit('data', 'more junk from the same line\n');
    process.stdin.emit('data', JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping' }) + '\n');
    await new Promise(r => setTimeout(r, 0));

    const replies = written.map(w => JSON.parse(w));
    expect(replies).toHaveLength(2); // the overflow error + the ping reply
    expect(replies[1]).toEqual({ jsonrpc: '2.0', id: 9, result: {} });
  });

  it('does not fire the cap for many normal lines in one chunk', async () => {
    const written = capture();
    stops.push(serveMcpStdio(
      { dispatch: vi.fn(), getSchema: () => SCHEMA },
      { actions: ['*'], maxLineLength: 64 },
    ));

    // Total far exceeds the cap, but every individual line is short.
    const many = Array.from({ length: 20 }, (_, i) =>
      JSON.stringify({ jsonrpc: '2.0', id: i, method: 'ping' })).join('\n') + '\n';
    process.stdin.emit('data', many);
    await new Promise(r => setTimeout(r, 0));

    const replies = written.map(w => JSON.parse(w));
    expect(replies).toHaveLength(20);
    expect(replies.every(r => r.error === undefined)).toBe(true);
  });

  it('pauses stdin while saturated and resumes once work drains', async () => {
    capture();
    const pause = vi.spyOn(process.stdin, 'pause');
    const resume = vi.spyOn(process.stdin, 'resume');

    // Handlers that park until released - enough to exceed maxInFlight.
    const releases: Array<() => void> = [];
    const dispatch = vi.fn(() => new Promise<any>((resolve) => {
      releases.push(() => resolve({ ok: true, value: 1 }));
    }));
    stops.push(serveMcpStdio({ dispatch, getSchema: () => SCHEMA }, { actions: ['*'], maxInFlight: 3 }));

    const line = (id: number) =>
      JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'cartAdd', arguments: { target: { id } } } }) + '\n';
    pause.mockClear();
    for (let i = 0; i < 5; i++) process.stdin.emit('data', line(i));
    await new Promise(r => setTimeout(r, 0));

    // Saturated: the source was paused rather than opening 5 dispatches...
    expect(pause).toHaveBeenCalled();
    expect(dispatch.mock.calls.length).toBeGreaterThan(1); // ...and NOT serialised to one
    resume.mockClear();

    for (const release of releases.splice(0)) release();
    await new Promise(r => setTimeout(r, 0));
    expect(resume).toHaveBeenCalled();
  });

  // Both options are reachable from the public API and both had a value that
  // stopped the server dead - the same class as `cache({ maxSize: -1 })`, which
  // hung on its first eviction.
  it('maxInFlight: 0 does not strand stdin paused forever', async () => {
    capture();
    const pause = vi.spyOn(process.stdin, 'pause');
    const resume = vi.spyOn(process.stdin, 'resume');
    stops.push(serveMcpStdio(
      { dispatch: vi.fn(async () => ({ ok: true as const, value: 1 })), getSchema: () => SCHEMA },
      { actions: ['*'], maxInFlight: 0 },
    ));
    pause.mockClear();
    resume.mockClear();

    process.stdin.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`);
    await new Promise((r) => setTimeout(r, 0));

    // Unclamped: inFlight rose to 1, `1 >= 0` paused, and on completion
    // `0 < 0` was false so it never resumed - one message served, then a hang
    // with nothing in flight. Measured: pause 1, resume 0.
    expect(resume).toHaveBeenCalled();
  });

  // A tiny cap legitimately abandons partial lines - that is the documented
  // behaviour, not a bug. What the clamp buys is that a NEGATIVE cap cannot
  // exist: `buffer.length > -5` is true even for an empty buffer, and the
  // error it reported quoted a negative length back at the client.
  // NaN loses every comparison, so `inFlight >= maxInFlight` would never pause
  // and the backpressure this option provides would silently not exist.
  it('a NaN maxInFlight still applies backpressure at the default bound', async () => {
    capture();
    const pause = vi.spyOn(process.stdin, 'pause');

    const releases: Array<() => void> = [];
    const dispatch = vi.fn(() => new Promise<any>((resolve) => {
      releases.push(() => resolve({ ok: true, value: 1 }));
    }));
    stops.push(serveMcpStdio(
      { dispatch, getSchema: () => SCHEMA },
      { actions: ['*'], maxInFlight: Number('nope') },
    ));
    pause.mockClear();

    const line = (id: number) => `${JSON.stringify({
      jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'cartAdd', arguments: { target: { id } } },
    })}\n`;
    for (let i = 0; i < 40; i++) process.stdin.emit('data', line(i));
    await new Promise((r) => setTimeout(r, 0));

    // Default is 32, so 40 concurrent lines must have tripped the pause.
    expect(pause).toHaveBeenCalled();
    for (const release of releases.splice(0)) release();
  });

  it('a negative maxLineLength is clamped and the transport keeps serving', async () => {
    const written = capture();
    stops.push(serveMcpStdio(
      { dispatch: vi.fn(), getSchema: () => SCHEMA },
      { actions: ['*'], maxLineLength: -5 },
    ));

    // A whole line in one chunk is never partial, so it is served normally.
    process.stdin.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' })}\n`);
    await new Promise((r) => setTimeout(r, 0));

    const replies = written.map((w) => JSON.parse(w));
    expect(replies).toEqual([{ jsonrpc: '2.0', id: 7, result: {} }]);

    // And a partial line reports a sane cap rather than a negative one.
    process.stdin.emit('data', 'partial with no newline');
    await new Promise((r) => setTimeout(r, 0));
    const last = JSON.parse(written[written.length - 1]!);
    expect(last.error.code).toBe(-32700);
    expect(last.error.message).toMatch(/exceeds 1 characters/);
  });

  it('drops a reply whose dispatch settles after stop()', async () => {
    const written = capture();
    let release!: () => void;
    const dispatch = vi.fn(() => new Promise<any>((resolve) => {
      release = () => resolve({ ok: true, value: 'late' });
    }));
    const stop = serveMcpStdio({ dispatch, getSchema: () => SCHEMA }, { actions: ['*'], maxInFlight: 1 });

    process.stdin.emit('data', JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cartAdd', arguments: { target: { id: 1 } } },
    }) + '\n');
    await new Promise(r => setTimeout(r, 0));
    expect(dispatch).toHaveBeenCalledTimes(1);

    stop(); // torn down while the tool is still running
    release();
    await new Promise(r => setTimeout(r, 0));

    // The late result is discarded, and the teardown's backpressure bookkeeping
    // must not touch a stdin this server no longer owns.
    expect(written).toHaveLength(0);
  });

  it('survives a handler rejection and keeps serving (-32603)', async () => {
    const written = capture();
    let calls = 0;
    // tools/list is the only method here that reads the schema (ping does
    // not), so the SECOND read is the second tools/list - make that one throw
    // and the handler's promise rejects.
    const getSchema = () => {
      if (++calls === 2) throw new Error('schema source died');
      return SCHEMA;
    };
    stops.push(serveMcpStdio({ dispatch: vi.fn(async () => ({ ok: true as const, value: 1 })), getSchema }, { actions: ['*'] }));

    process.stdin.emit('data', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
    process.stdin.emit('data', JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
    process.stdin.emit('data', JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }) + '\n');
    await new Promise(r => setTimeout(r, 0));

    const replies = written.map(w => JSON.parse(w));
    expect(replies.some(r => r.error?.code === -32603)).toBe(true);
    // The transport did not die: the later ping was still answered.
    expect(replies.find(r => r.id === 3)).toEqual({ jsonrpc: '2.0', id: 3, result: {} });
  });
});
