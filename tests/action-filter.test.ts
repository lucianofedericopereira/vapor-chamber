/** `createActionFilter`: CloudEvents Subscriptions API 3.2.4 filter expressions over a command's action, and `actionFilter`. Log s35.152. */
import { describe, expect, it } from 'vitest';
import { createActionFilter, type ActionFilterExpression } from '../src/action-filter';
import { BusError, createCommandBus } from '../src/command-bus';
import { createMcpHandler } from '../src/mcp';
import { cache, metrics } from '../src/plugins-extra';
import { createSchemaCommandBus, type BusSchema } from '../src/schema';

const sel = (expressions: ActionFilterExpression[]) => createActionFilter(expressions);
const refusal = (expressions: unknown): string => {
  try { createActionFilter(expressions as ActionFilterExpression[]); } catch (e) { return e instanceof BusError ? e.code : String(e); }
  return 'accepted';
};

describe('the six required dialects, as the spec defines them', () => {
  it('exact, prefix, suffix compare the action, case-sensitive', () => {
    expect(sel([{ exact: { action: 'cartAdd' } }])('cartAdd')).toBe(true);
    expect(sel([{ exact: { action: 'cartAdd' } }])('cartAddX')).toBe(false);
    expect(sel([{ prefix: { action: 'cart' } }])('cartAdd')).toBe(true);
    expect(sel([{ prefix: { action: 'cart' } }])('Cart')).toBe(false);
    expect(sel([{ suffix: { action: 'Get' } }])('userGet')).toBe(true);
    expect(sel([{ suffix: { action: 'Get' } }])('userSet')).toBe(false);
  });

  it('all, any, not combine expressions', () => {
    const cartNotDebug = sel([{ all: [{ prefix: { action: 'cart' } }, { not: { exact: { action: 'cartDebug' } } }] }]);
    expect([cartNotDebug('cartAdd'), cartNotDebug('cartDebug')]).toEqual([true, false]);
    const either = sel([{ any: [{ exact: { action: 'a' } }, { exact: { action: 'b' } }] }]);
    expect([either('a'), either('b'), either('c')]).toEqual([true, true, false]);
  });

  it('a set is ANDed; an empty set selects every action', () => {
    const set = sel([{ prefix: { action: 'cart' } }, { suffix: { action: 'Add' } }]);
    expect([set('cartAdd'), set('cartRemove'), set('userAdd')]).toEqual([true, false, false]);
    expect(sel([])('anything')).toBe(true);
  });
});

describe('what the spec says MUST be rejected is rejected when the filter is created: core:invalid:filter', () => {
  it.each([
    ['an all with no expression', [{ all: [] }]],
    ['an any with no expression', [{ any: [] }]],
    ['an empty string', [{ exact: { action: '' } }]],
    ['an unknown dialect', [{ sql: "type LIKE 'cart%'" }]],
    ['two dialects in one expression', [{ exact: { action: 'a' }, prefix: { action: 'b' } }]],
    ['no dialect', [{}]],
    ['an attribute other than action', [{ exact: { type: 'cartAdd' } }]],
    ['two attributes', [{ exact: { action: 'a', subject: 'b' } }]],
    ['an attribute value that is not a string', [{ exact: { action: 1 } }]],
    ['an attribute map that is not an object', [{ prefix: 'cart' }]],
    ['an expression that is not an object', ['cart*']],
    ['a nested bad expression', [{ not: { any: [] } }]],
    ['a set that is not an array', { exact: { action: 'a' } }],
  ])('%s', (_name, expressions) => {
    expect(refusal(expressions)).toBe('core:invalid:filter');
  });

  it('control: a valid set is accepted', () => {
    expect(refusal([{ prefix: { action: 'cart' } }])).toBe('accepted');
  });
});

describe('a plugin selects by actionFilter, as by actions', () => {
  it('cache({ actionFilter }) caches only what the filter selects', () => {
    const bus = createCommandBus();
    let gets = 0;
    let sets = 0;
    bus.register('userGet', () => ++gets);
    bus.register('userSet', () => ++sets);
    bus.use(cache({ actionFilter: createActionFilter([{ suffix: { action: 'Get' } }]) }));
    bus.dispatch('userGet', 1);
    bus.dispatch('userGet', 1);
    bus.dispatch('userSet', 1);
    bus.dispatch('userSet', 1);
    expect([gets, sets]).toEqual([1, 2]);
  });

  it('actions and actionFilter together: both must match', () => {
    const bus = createCommandBus();
    const m = metrics({ actions: ['cart*'], actionFilter: createActionFilter([{ not: { exact: { action: 'cartDebug' } } }]) });
    bus.use(m);
    for (const a of ['cartAdd', 'cartDebug', 'userGet']) { bus.register(a, () => 1); bus.dispatch(a, 0); }
    expect(m.entries().map((e) => e.action)).toEqual(['cartAdd']);
  });

  it('the bus asks the filter once per action, never per dispatch', () => {
    const bus = createCommandBus();
    const asked: string[] = [];
    bus.use(metrics({ actionFilter: (a) => { asked.push(a); return a === 'x'; } }));
    bus.register('x', () => 1);
    bus.register('y', () => 2);
    for (let i = 0; i < 3; i++) { bus.dispatch('x', 0); bus.dispatch('y', 0); }
    expect(asked).toEqual(['x', 'y']);
  });

  it('a plugin declares the filter it was given', () => {
    const actionFilter = createActionFilter([{ prefix: { action: 'cart' } }]);
    expect(cache({ actionFilter }).actionFilter).toBe(actionFilter);
  });
});

describe('createMcpHandler({ actionFilter })', () => {
  const schema: BusSchema = { cartGet: { description: 'read' }, cartAdd: { description: 'write' }, userGet: { description: 'read' } };
  const names = async (opts: Parameters<typeof createMcpHandler>[1]) => {
    const handle = createMcpHandler(createSchemaCommandBus(schema), opts);
    const reply = (await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })) as { result: { tools: Array<{ name: string }> } };
    return reply.result.tools.map((t) => t.name);
  };
  const reads = createActionFilter([{ suffix: { action: 'Get' } }]);

  it('exposes what the filter selects, and refuses a call outside it', async () => {
    expect(await names({ actionFilter: reads })).toEqual(['cartGet', 'userGet']);
    const handle = createMcpHandler(createSchemaCommandBus(schema), { actionFilter: reads });
    const reply = (await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'cartAdd' } })) as { error?: { code: number } };
    expect(reply.error?.code).toBe(-32602); // not listed: a protocol error (s35.172)
  });
});
