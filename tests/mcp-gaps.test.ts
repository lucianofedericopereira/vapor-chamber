/**
 * The MCP handler's tools/call gate and envelope, tool mapping, and the stdio transport.
 * Why: an agent must only reach tools that tools/list advertises (inherited `Object.prototype` names
 * such as `constructor` are not tools), a failing handler must not kill the server, a malformed
 * notification must never be answered, and the stdio transport must survive hostile input (over-long
 * lines, bad `maxInFlight` / `maxLineLength`, a stop() mid-call) without hanging. Also the only file
 * reaching serveMcpStdio's Node guard, backpressure and over-long-line resync, so the 100% floor needs it.
 * Shows: inherited keys are refused with -32602 and never dispatched, a throwing dispatch becomes an
 * error result, a non-object payload is refused, an object payload is forwarded by reference, envelope
 * replies and silences, `required` and `description` omitted from tool mapping when absent, and
 * serveMcpStdio's guard, framing, backpressure, clamping and teardown behaviour.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createActionFilter } from '../src/action-filter';
import { createMcpHandler, busToMcpTools, serveMcpStdio } from '../src/mcp';
import type { BusSchema } from '../src/schema';
import { mcpClient } from '../src/vitest-pure';

const SCHEMA = {
  cartAdd: { description: 'Add an item', target: { id: 'number' }, payload: { qty: 'number' } },
} as unknown as BusSchema;

const all = createActionFilter([]);

function makeHandler(overrides: { dispatch?: any; schema?: BusSchema } = {}) {
  const dispatch = overrides.dispatch ?? vi.fn(async () => ({ ok: true, value: 'done' }));
  const handle = createMcpHandler(
    { dispatch, getSchema: () => overrides.schema ?? SCHEMA },
    { actionFilter: all },
  );
  return { handle, mcp: mcpClient(handle), dispatch };
}

/** Detached in afterEach so a failing assertion cannot leak a stdin listener into the next test. */
const stops: Array<() => void> = [];

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  vi.unstubAllGlobals();
});

describe('tools/call rejects inherited Object.prototype keys', () => {
  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'])(
    'refuses "%s" and never dispatches it',
    async (name) => {
      const { mcp, dispatch } = makeHandler();

      await expect(mcp.call(name, {})).rejects.toMatchObject({ code: -32602 });
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

    await expect(mcp.call('constructor', {})).rejects.toMatchObject({ code: -32602 });
  });
});

describe('callTool', () => {
  it('turns a throwing dispatch into an error result, not a protocol error', async () => {
    const dispatch = vi.fn(() => { throw new Error('handler exploded'); });
    const { mcp } = makeHandler({ dispatch });

    // call() throws on a protocol error, so a returned result is a tool failure.
    expect(await mcp.call('cartAdd', { target: { id: 1 } })).toBeToolError('handler exploded');
  });

  it('refuses a non-object payload instead of dispatching it unattributed', async () => {
    // Mocked dispatch: a bare payload on a real bus would carry no `meta.origin`; the end-to-end attribution check is in tests/mcp.test.ts.
    const dispatch = vi.fn(async (_action: string, _target: unknown, _payload?: unknown) => ({ ok: true as const, value: 1 }));
    const { mcp } = makeHandler({ dispatch });

    for (const bad of ['a bare string', [1, 2], 42, true]) {
      expect(await mcp.call('cartAdd', { target: { id: 1 }, payload: bad })).toBeToolError(/payload must be an object/);
    }
    // Refused at the boundary: the bus is never reached.
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('forwards the payload to the bus untouched', async () => {
    // The origin marker travels out-of-band via `_withOrigin`, so the bus gets the client's payload by reference with no key injected.
    // Mocked dispatch: attribution is checked against a real bus in tests/mcp.test.ts.
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
    await expect(mcp.call('', {})).rejects.toMatchObject({ code: -32602 });
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('JSON-RPC envelope', () => {
  it('never answers a malformed NOTIFICATION', async () => {
    const { handle } = makeHandler();
    // No id makes it a notification, which is never replied to.
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
    stops.push(serveMcpStdio({ dispatch: vi.fn(async () => ({ ok: true as const, value: 'ok' })), getSchema: () => SCHEMA }, { actionFilter: all }));

    process.stdin.emit('data', '\n\n' + JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\n');
    process.stdin.emit('data', 'not json at all\n');
    process.stdin.emit('data', JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    await new Promise(r => setTimeout(r, 0));

    // Replies are written in completion order (the parse error lands before the async ping), so match by id.
    const replies = written.map(w => JSON.parse(w));
    expect(replies).toHaveLength(2);
    expect(replies.find(r => r.id === 1)).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
    expect(replies.find(r => r.id === null).error.code).toBe(-32700);
  });

  it('buffers a message split across chunks', async () => {
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { written.push(s); return true; }) as any);
    stops.push(serveMcpStdio({ dispatch: vi.fn(), getSchema: () => SCHEMA }, { actionFilter: all }));

    const msg = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' });
    process.stdin.emit('data', msg.slice(0, 10));
    process.stdin.emit('data', msg.slice(10) + '\n');
    await new Promise(r => setTimeout(r, 0));

    expect(JSON.parse(written[0]!)).toEqual({ jsonrpc: '2.0', id: 2, result: {} });
  });

  it('stop() detaches - later input produces no output', async () => {
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { written.push(s); return true; }) as any);
    const stop = serveMcpStdio({ dispatch: vi.fn(), getSchema: () => SCHEMA }, { actionFilter: all });
    stop();

    process.stdin.emit('data', JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }) + '\n');
    await new Promise(r => setTimeout(r, 0));
    expect(written).toHaveLength(0);
  });
});

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
      { actionFilter: all, maxLineLength: 64 },
    ));

    process.stdin.emit('data', 'x'.repeat(200));
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0]!).error.code).toBe(-32700);
    expect(JSON.parse(written[0]!).error.message).toMatch(/exceeds 64 characters/);

    // The tail of the abandoned line is discarded; the next line is served.
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
      { actionFilter: all, maxLineLength: 64 },
    ));

    // The total exceeds the cap; each line is under it.
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

    // Handlers park until released, so more than maxInFlight calls are pending.
    const releases: Array<() => void> = [];
    const dispatch = vi.fn(() => new Promise<any>((resolve) => {
      releases.push(() => resolve({ ok: true, value: 1 }));
    }));
    stops.push(serveMcpStdio({ dispatch, getSchema: () => SCHEMA }, { actionFilter: all, maxInFlight: 3 }));

    const line = (id: number) =>
      JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'cartAdd', arguments: { target: { id } } } }) + '\n';
    pause.mockClear();
    for (let i = 0; i < 5; i++) process.stdin.emit('data', line(i));
    await new Promise(r => setTimeout(r, 0));

    expect(pause).toHaveBeenCalled();
    expect(dispatch.mock.calls.length).toBeGreaterThan(1); // concurrent, not serialised to one
    resume.mockClear();

    for (const release of releases.splice(0)) release();
    await new Promise(r => setTimeout(r, 0));
    expect(resume).toHaveBeenCalled();
  });

  it('maxInFlight: 0 does not strand stdin paused forever', async () => {
    capture();
    const pause = vi.spyOn(process.stdin, 'pause');
    const resume = vi.spyOn(process.stdin, 'resume');
    stops.push(serveMcpStdio(
      { dispatch: vi.fn(async () => ({ ok: true as const, value: 1 })), getSchema: () => SCHEMA },
      { actionFilter: all, maxInFlight: 0 },
    ));
    pause.mockClear();
    resume.mockClear();

    process.stdin.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`);
    await new Promise((r) => setTimeout(r, 0));

    // A bound of 0 is clamped; unclamped, the first message would pause stdin and the completion would never resume it.
    expect(resume).toHaveBeenCalled();
  });

  // NaN loses every comparison, so an unchecked `inFlight >= maxInFlight` would never pause and backpressure would not exist.
  it('a NaN maxInFlight still applies backpressure at the default bound', async () => {
    capture();
    const pause = vi.spyOn(process.stdin, 'pause');

    const releases: Array<() => void> = [];
    const dispatch = vi.fn(() => new Promise<any>((resolve) => {
      releases.push(() => resolve({ ok: true, value: 1 }));
    }));
    stops.push(serveMcpStdio(
      { dispatch, getSchema: () => SCHEMA },
      { actionFilter: all, maxInFlight: Number('nope') },
    ));
    pause.mockClear();

    const line = (id: number) => `${JSON.stringify({
      jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'cartAdd', arguments: { target: { id } } },
    })}\n`;
    for (let i = 0; i < 40; i++) process.stdin.emit('data', line(i));
    await new Promise((r) => setTimeout(r, 0));

    // The default bound is 32, so 40 concurrent lines trip the pause.
    expect(pause).toHaveBeenCalled();
    for (const release of releases.splice(0)) release();
  });

  it('a negative maxLineLength is clamped and the transport keeps serving', async () => {
    const written = capture();
    stops.push(serveMcpStdio(
      { dispatch: vi.fn(), getSchema: () => SCHEMA },
      { actionFilter: all, maxLineLength: -5 },
    ));

    // A negative cap would reject even an empty buffer; clamped, a whole line in one chunk is served.
    process.stdin.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' })}\n`);
    await new Promise((r) => setTimeout(r, 0));

    const replies = written.map((w) => JSON.parse(w));
    expect(replies).toEqual([{ jsonrpc: '2.0', id: 7, result: {} }]);

    // A partial line reports the clamped cap, not a negative one.
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
    const stop = serveMcpStdio({ dispatch, getSchema: () => SCHEMA }, { actionFilter: all, maxInFlight: 1 });

    process.stdin.emit('data', JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cartAdd', arguments: { target: { id: 1 } } },
    }) + '\n');
    await new Promise(r => setTimeout(r, 0));
    expect(dispatch).toHaveBeenCalledTimes(1);

    stop(); // torn down while the tool is still running
    release();
    await new Promise(r => setTimeout(r, 0));

    // The late result is discarded and the bookkeeping does not touch a stdin the server no longer owns.
    expect(written).toHaveLength(0);
  });

  it('survives a handler rejection and keeps serving (-32603)', async () => {
    const written = capture();
    let calls = 0;
    // Only tools/list reads the schema here, so the second read is the second tools/list; make it throw.
    const getSchema = () => {
      if (++calls === 2) throw new Error('schema source died');
      return SCHEMA;
    };
    stops.push(serveMcpStdio({ dispatch: vi.fn(async () => ({ ok: true as const, value: 1 })), getSchema }, { actionFilter: all }));

    process.stdin.emit('data', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
    process.stdin.emit('data', JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
    process.stdin.emit('data', JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }) + '\n');
    await new Promise(r => setTimeout(r, 0));

    const replies = written.map(w => JSON.parse(w));
    expect(replies.some(r => r.error?.code === -32603)).toBe(true);
    expect(replies.find(r => r.id === 3)).toEqual({ jsonrpc: '2.0', id: 3, result: {} });
  });
});
