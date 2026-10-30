/**
 * createMcpHandler's one selection is `actionFilter`, an allowlist.
 * Why: an agent must only see and call the actions the app chose to expose, and an empty filter set
 * selects every action (as in CloudEvents), so exposing all must be a deliberate `createActionFilter([])`.
 * An omitted filter exposes everything with a one-time warning that says "allowlist"; an `actions`
 * option selects nothing. Exposing nothing has no filter form: an app that exposes nothing does not
 * mount the handler.
 * Shows: tools/list for omitted, exact, prefix and empty filters (with and without the warning), and a
 * tools/call outside the filter is -32602 and never dispatched.
 * See: log s35.180, log s35.152
 */
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createActionFilter } from '../src/action-filter';
import { createMcpHandler } from '../src/mcp';
import { createSchemaCommandBus, type BusSchema } from '../src/schema';

const schema: BusSchema = { cartGet: { description: 'read' }, cartAdd: { description: 'write' }, userGet: { description: 'read' } };
let warn: MockInstance;
beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });

const names = async (options?: object): Promise<string[]> => {
  const handle = createMcpHandler(createSchemaCommandBus(schema), options as never);
  const reply = (await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })) as { result: { tools: Array<{ name: string }> } };
  return reply.result.tools.map((t) => t.name);
};

describe('actionFilter is the one selection', () => {
  it('an omitted actionFilter warns once, naming actionFilter and the allowlist', async () => {
    expect(await names()).toEqual(['cartGet', 'cartAdd', 'userGet']);
    expect(warn).toHaveBeenCalledTimes(1);
    const text = String(warn.mock.calls[0]![0]);
    expect(text).toContain('createMcpHandler({ actionFilter })');
    expect(text).toContain('allowlist');
    expect(text).not.toContain('whitelist');
  });

  it('`actions` is no longer an option: it selects nothing', async () => {
    expect(await names({ actions: [] })).toEqual(['cartGet', 'cartAdd', 'userGet']);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('controls', () => {
  it('exact names and a prefix select what they name, silently', async () => {
    const exact = createActionFilter([{ any: [{ exact: { action: 'cartGet' } }, { exact: { action: 'userGet' } }] }]);
    expect(await names({ actionFilter: exact })).toEqual(['cartGet', 'userGet']);
    expect(await names({ actionFilter: createActionFilter([{ prefix: { action: 'cart' } }]) })).toEqual(['cartGet', 'cartAdd']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('createActionFilter([]) exposes every action, deliberately and silently', async () => {
    expect(await names({ actionFilter: createActionFilter([]) })).toEqual(['cartGet', 'cartAdd', 'userGet']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a call outside the filter is -32602, never dispatched', async () => {
    const bus = createSchemaCommandBus(schema);
    const ran = vi.fn();
    bus.register('cartAdd', ran);
    const handle = createMcpHandler(bus, { actionFilter: createActionFilter([{ suffix: { action: 'Get' } }]) });
    const reply = (await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'cartAdd', arguments: {} } })) as { error?: { code: number } };
    expect(reply.error?.code).toBe(-32602);
    expect(ran).not.toHaveBeenCalled();
  });
});
