/**
 * Supplemental coverage for src/mcp.ts, plus a regression test for the
 * inherited-key hole in the tools/call gate.
 *
 *  - tools/call name gate: `schema[name] === undefined` walked the prototype
 *    chain, so `constructor` / `toString` / `__proto__` / `hasOwnProperty`
 *    passed as "known tools" and reached bus.dispatch — names tools/list never
 *    advertises. Now Object.hasOwn.
 *  - callTool's dispatch-throws arm (283).
 *  - a malformed envelope with NO id — a notification, which must never be
 *    answered even when invalid (300).
 *  - a non-object payload passing through untouched (275).
 *  - tool mapping without required fields (67) and without a description (83).
 *  - serveMcpStdio: the no-Node guard (354-355), blank-line skip (369),
 *    parse errors, notification silence, and stop().
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createMcpHandler, busToMcpTools, serveMcpStdio, agentOrigin } from '../src/mcp';
import type { BusSchema } from '../src/schema';

const SCHEMA = {
  cartAdd: { description: 'Add an item', target: { id: 'number' }, payload: { qty: 'number' } },
} as unknown as BusSchema;

function makeHandler(overrides: { dispatch?: any; schema?: BusSchema; actions?: string[] } = {}) {
  const dispatch = overrides.dispatch ?? vi.fn(async () => ({ ok: true, value: 'done' }));
  const handle = createMcpHandler(
    { dispatch, getSchema: () => overrides.schema ?? SCHEMA },
    { actions: overrides.actions ?? ['*'] },
  );
  return { handle, dispatch };
}

const call = (name: string, args?: unknown) => ({
  jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args },
});

/** Detached in afterEach so a failing assertion cannot leak a stdin listener
 *  into the next test (it would answer that test's input through its spy). */
const stops: Array<() => void> = [];

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// tools/call name gate — inherited keys (regression)
// ---------------------------------------------------------------------------

describe('tools/call rejects inherited Object.prototype keys', () => {
  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'])(
    'refuses "%s" and never dispatches it',
    async (name) => {
      const { handle, dispatch } = makeHandler();

      const reply: any = await handle(call(name, {}));
      expect(reply.result.isError).toBe(true);
      expect(reply.result.content[0].text).toContain('unknown or not permitted');
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it('keeps dispatching real own-key tools', async () => {
    const { handle, dispatch } = makeHandler();
    const reply: any = await handle(call('cartAdd', { target: { id: 1 }, payload: { qty: 2 } }));
    expect(reply.result.isError).toBeUndefined();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('is consistent with tools/list — an unlisted name is uncallable', async () => {
    const { handle } = makeHandler();
    const listed: any = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const names = listed.result.tools.map((t: any) => t.name);
    expect(names).toEqual(['cartAdd']);

    const reply: any = await handle(call('constructor', {}));
    expect(reply.result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// callTool arms
// ---------------------------------------------------------------------------

describe('callTool', () => {
  it('turns a throwing dispatch into an error result, not a protocol error (283)', async () => {
    const dispatch = vi.fn(() => { throw new Error('handler exploded'); });
    const { handle } = makeHandler({ dispatch });

    const reply: any = await handle(call('cartAdd', { target: { id: 1 } }));
    expect(reply.jsonrpc).toBe('2.0');
    expect(reply.error).toBeUndefined(); // tool failures are results
    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0].text).toContain('handler exploded');
  });

  it('passes a non-object payload through untouched (275)', async () => {
    const dispatch = vi.fn(async () => ({ ok: true, value: 1 }));
    const { handle } = makeHandler({ dispatch });

    await handle(call('cartAdd', { target: { id: 1 }, payload: 'a bare string' }));
    expect(dispatch.mock.calls[0]![2]).toBe('a bare string'); // no __origin spread

    await handle(call('cartAdd', { target: { id: 1 }, payload: [1, 2] }));
    expect(dispatch.mock.calls[1]![2]).toEqual([1, 2]);
  });

  it('stamps __origin on object and absent payloads', async () => {
    const dispatch = vi.fn(async () => ({ ok: true, value: 1 }));
    const { handle } = makeHandler({ dispatch });

    await handle(call('cartAdd', { target: { id: 1 }, payload: { qty: 2 } }));
    expect(dispatch.mock.calls[0]![2]).toEqual({ qty: 2, __origin: 'agent' });

    await handle(call('cartAdd', { target: { id: 1 } }));
    expect(dispatch.mock.calls[1]![2]).toEqual({ __origin: 'agent' });
  });

  it('rejects a missing tool name', async () => {
    const { handle, dispatch } = makeHandler();
    const reply: any = await handle(call('' as string, {}));
    expect(reply.result.isError).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// envelope handling (300)
// ---------------------------------------------------------------------------

describe('JSON-RPC envelope', () => {
  it('never answers a malformed NOTIFICATION (300)', async () => {
    const { handle } = makeHandler();
    // Bad jsonrpc version, no id → a notification: MUST NOT be replied to.
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
// tool mapping arms (67, 83)
// ---------------------------------------------------------------------------

describe('busToMcpTools', () => {
  it("omits `required` when every field is 'any' (67)", () => {
    const [tool] = busToMcpTools({ ping: { target: { anything: 'any' } } } as unknown as BusSchema);
    expect(tool!.inputSchema.properties.target.required).toBeUndefined();
    expect(tool!.inputSchema.properties.target.properties.anything).toEqual({});
  });

  it('omits `description` when the action declares none (83)', () => {
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
// serveMcpStdio (353-388)
// ---------------------------------------------------------------------------

describe('serveMcpStdio', () => {
  it('throws outside Node (354-355)', () => {
    vi.stubGlobal('process', undefined);
    expect(() => serveMcpStdio({ dispatch: vi.fn(), getSchema: () => SCHEMA })).toThrow(
      /requires a Node\.js environment/,
    );
  });

  it('answers requests, skips blank lines, and reports parse errors (369)', async () => {
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { written.push(s); return true; }) as any);
    stops.push(serveMcpStdio({ dispatch: vi.fn(async () => ({ ok: true, value: 'ok' })), getSchema: () => SCHEMA }, { actions: ['*'] }));

    // Blank lines between real messages must be skipped, not parse-errored.
    process.stdin.emit('data', '\n\n' + JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\n');
    process.stdin.emit('data', 'not json at all\n');
    // A notification produces no output.
    process.stdin.emit('data', JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    await new Promise(r => setTimeout(r, 0));

    // Matched by id, not position: replies are written in COMPLETION order.
    // The parse error is produced synchronously while the ping goes through the
    // async handler, so the error lands first — legal JSON-RPC (responses may
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

  it('stop() detaches — later input produces no output', async () => {
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
// serveMcpStdio — input-driven limits
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
      { dispatch: vi.fn(async () => ({ ok: true, value: 'ok' })), getSchema: () => SCHEMA },
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

    // Handlers that park until released — enough to exceed maxInFlight.
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

  it('drops a reply whose dispatch settles after stop() (405)', async () => {
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
    // not), so the SECOND read is the second tools/list — make that one throw
    // and the handler's promise rejects.
    const getSchema = () => {
      if (++calls === 2) throw new Error('schema source died');
      return SCHEMA;
    };
    stops.push(serveMcpStdio({ dispatch: vi.fn(async () => ({ ok: true, value: 1 })), getSchema }, { actions: ['*'] }));

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
