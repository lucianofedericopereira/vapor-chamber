/** createMcpHandler's one selection is `actionFilter`, an allowlist (plan 1.27 item 9, MCP allowlist). Rationale at the end. */
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

/*
 * `actions` meant three things in the public API (audit N1): a plugin's
 * filter, where `[]` is every action; this handler's allowlist, where `[]` was
 * none; and the retry map (renamed `actionPolicies`, s35.179). Owner decision
 * D2 (2026-10-05): the handler loses `actions`, and `actionFilter`
 * (CloudEvents Subscriptions API 3.2.4, s35.152) is its one selection. An
 * empty CloudEvents set selects every action, so `createActionFilter([])` is
 * the deliberate "expose all" that `['*']` was. Exposing nothing has no
 * filter form (an empty `any` is rejected by the spec): an app that exposes
 * nothing does not mount the handler. The word "whitelist" goes too (audit
 * N7, W3C TAG design principles: "use allowlist and blocklist").
 */
