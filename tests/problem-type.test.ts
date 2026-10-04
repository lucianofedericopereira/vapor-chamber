// A failure on the wire is an RFC 9457 problem whose `type` names its condition, resolvable in docs/errors.md.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { _failures, createAsyncCommandBus, createCommandBus, type BusError } from '../src/command-bus';
import { ERROR_CODE_REGISTRY } from '../src/schema';
import { createHttpBridge } from '../src/transports';

const BASE = 'https://github.com/lucianofedericopereira/vapor-chamber/blob/main/docs/errors.md#';
const SRC = join(import.meta.dirname, '..', 'src');
const DOC = readFileSync(join(import.meta.dirname, '..', 'docs', 'errors.md'), 'utf8');
const VOCABULARY = [...(/export type Condition =([^;]*);/.exec(readFileSync(join(SRC, 'failure.ts'), 'utf8'))?.[1] ?? '').matchAll(/'([a-z]+)'/g)].map((m) => m[1]);

function bridged(status: number, data: unknown) {
  const httpClient = { post: vi.fn().mockResolvedValue({ ok: false, status, headers: {}, data }) } as never;
  const bus = createAsyncCommandBus({ retry: false } as never);
  bus.use(createHttpBridge({ endpoint: '/api/vc', httpClient }));
  return bus.dispatch('cartAdd', {});
}

describe('the problem type', () => {
  it('a library failure: type names its condition; code, detail and action stay', () => {
    const r = createCommandBus().dispatch('nothere', 1);
    const json = JSON.parse(JSON.stringify(r.error));
    expect(json).toMatchObject({ type: `${BASE}missing`, code: 'core:missing:handler', action: 'nothere' });
    expect(typeof json.detail).toBe('string');
  });

  it('an app\'s own code gets its condition\'s type too', () => {
    const e = _failures('qtyGuard')('invalid:payload', 'qty must be positive');
    expect(e.toJSON().type).toBe(`${BASE}invalid`);
  });

  it('a backend\'s problem keeps its own type', async () => {
    const r = await bridged(422, { type: 'https://shop.example/probs/out-of-stock', code: 'out_of_stock', detail: 'Out of stock' });
    expect((r.error as BusError).code).toBe('remote:invalid:out_of_stock');
    expect((r.error as BusError).toJSON().type).toBe('https://shop.example/probs/out-of-stock');
  });

  it('a backend\'s problem with no type gets its status\'s condition', async () => {
    const r = await bridged(409, { code: 'in_progress', detail: 'Still running' });
    expect((r.error as BusError).toJSON().type).toBe(`${BASE}conflict`);
  });

  it('survives a JSON round trip unchanged', () => {
    const e = _failures('core')('limited:handler', 'wait', { context: { retryIn: 5 } });
    const once = JSON.parse(JSON.stringify(e));
    expect(once).toEqual({ retryIn: 5, type: `${BASE}limited`, detail: 'wait', code: 'core:limited:handler' });
  });
});

describe('docs/errors.md, the page every type resolves to', () => {
  it('has an anchor for every condition', () => {
    expect(VOCABULARY).toHaveLength(14);
    for (const c of VOCABULARY) expect(DOC, c).toContain(`<a id="${c}"></a>`);
  });

  it('lists every registry code under its condition', () => {
    for (const { code } of ERROR_CODE_REGISTRY) {
      const condition = code.split(':')[1];
      const section = DOC.slice(DOC.indexOf(`<a id="${condition}"></a>`));
      const next = section.indexOf('<a id=', 1);
      expect((next < 0 ? section : section.slice(0, next)), code).toContain(`\`${code}\``);
    }
  });
});

/*
 * RFC 9457 3.1.1: "Consumers MUST use the 'type' URI ... as the problem type's
 * primary identifier"; 3.2: a client "MUST ignore" extensions it does not
 * know. With `type` left as about:blank (4.2.1: no semantics beyond the HTTP
 * status) an RFC client threw away our only identity, the `code` extension.
 * `type` now names the CONDITION (owner, 2026-10-02, log s35.80): resolvable
 * for every failure, the library's, an app's and a backend's alike, and the
 * part an RFC client acts on (retry, sign in, show a validation message). The
 * exact code stays the `code` extension. A backend's own `type` is its
 * identity and is kept. `title` is left out: RFC 9457 makes it optional, and
 * the summaries live in ERROR_CODE_REGISTRY (schema.ts), which the core does
 * not carry.
 */
