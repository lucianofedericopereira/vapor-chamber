/**
 * The Idempotency-Key header is a Structured Field String, as the draft the
 * library cites requires (draft-ietf-httpapi-idempotency-key-header-07, section
 * 2; RFC 9651): quoted, `"` and `\` escaped, printable ASCII only.
 *
 * It was sent raw. The key is the idempotent plugin's commandKey (the action
 * plus the target as JSON, `save:{"id":1}`), so the value was neither quoted
 * nor escaped, and any character outside Latin-1 in the target (an emoji, CJK
 * text in a search term) made it a value `Headers` refuses outright: the
 * request never left. The fetch mock the old test used accepts anything, so it
 * could not see either. The platform's own Headers is the judge here.
 * docs/plan-failures-and-contract.md, 2.1.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAsyncCommandBus } from '../src/command-bus';
import { idempotent } from '../src/plugins-extra';
import { createHttpBridge } from '../src/transports';

/** RFC 9651 sf-string: DQUOTE *( unescaped / "\" ( DQUOTE / "\" ) ) DQUOTE, unescaped = %x20-21 / %x23-5B / %x5D-7E */
const SF_STRING = /^"(?:[\x20\x21\x23-\x5b\x5d-\x7e]|\\["\\])*"$/;

async function sentKey(target: unknown): Promise<string> {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, state: 1 }) });
  vi.stubGlobal('fetch', fetchMock);
  const bus = createAsyncCommandBus();
  bus.use(idempotent({}), { priority: 300 });
  bus.use(createHttpBridge({ endpoint: '/api' }));
  await bus.dispatch('save', target);
  const [, init] = fetchMock.mock.calls[0];
  return init.headers['Idempotency-Key'];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Idempotency-Key on the wire', () => {
  it('is a quoted Structured Field String the server can decode to the exact key', async () => {
    const value = await sentKey({ id: 1 });
    expect(value).toMatch(SF_STRING);
    // Percent-encoded, then quoted: an sf-string with nothing left to escape.
    expect(value).toBe(`"${encodeURIComponent('save:{"id":1}')}"`);
  });

  it('stays a valid header when the target holds characters outside Latin-1', async () => {
    const value = await sentKey({ q: 'caf\u00e9 \u{1F600} \u6771\u4eac' });
    expect(value).toMatch(SF_STRING);
    expect(() => new Headers({ 'Idempotency-Key': value })).not.toThrow();
  });

  it('two different targets never collapse to the same header', async () => {
    const a = await sentKey({ q: '\u{1F600}' });
    const b = await sentKey({ q: '\u{1F601}' });
    expect(a).not.toBe(b);
  });
});
