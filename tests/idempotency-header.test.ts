/**
 * The Idempotency-Key header is a Structured Field String, as the draft the
 * library cites requires (draft-ietf-httpapi-idempotency-key-header-07, section
 * 2; RFC 9651): quoted, `"` and `\` escaped, printable ASCII only.
 *
 * It was sent raw. An app's key can hold any text (here the action plus the
 * target as JSON, `save:{"id":1}`), so the value was neither quoted
 * nor escaped, and any character outside Latin-1 in the target (an emoji, CJK
 * text in a search term) made it a value `Headers` refuses outright: the
 * request never left. The fetch mock the old test used accepts anything, so it
 * could not see either. The platform's own Headers is the judge here.
 * (v1.25.0)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAsyncCommandBus } from '../src/command-bus';
import { idempotent } from '../src/plugins-extra';
import { httpTransport, wsTransport } from '../src/transports';
import { MockWebSocket } from './backend-stubs';

/** RFC 9651 sf-string: DQUOTE *( unescaped / "\" ( DQUOTE / "\" ) ) DQUOTE, unescaped = %x20-21 / %x23-5B / %x5D-7E */
const SF_STRING = /^"(?:[\x20\x21\x23-\x5b\x5d-\x7e]|\\["\\])*"$/;

async function sentKey(target: unknown): Promise<string> {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, state: 1 }) });
  vi.stubGlobal('fetch', fetchMock);
  const bus = createAsyncCommandBus({ transport: httpTransport({ endpoint: '/api' }) });
  bus.use(idempotent({ key: (cmd) => `${cmd.action}:${JSON.stringify(cmd.target)}` }));
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

  it('is the percent-encoded key, byte for byte, whether or not the encode runs, single and batched', async () => {
    const keys = [
      'lzk3f2-1x9q-a', '0123456789abcdefghijklmnopqrstuvwxyz-', crypto.randomUUID(), 'A_b.c~d-e',
      'k"1', 'k\\1', 'k%41', 'k 1', "k!*'()", 'save:{"id":1}', 'café', '\u{1F600}', 'k\u0001\t\n1', '',
    ];
    const sent: string[] = [];
    const texts: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
      texts.push(init.body as string);
      const body = JSON.parse(init.body as string);
      if (body.commands) for (const c of body.commands) sent.push(c.headers?.['Idempotency-Key']);
      else sent.push((init.headers as Record<string, string>)['Idempotency-Key']);
      const text = JSON.stringify(body.commands ? { results: body.commands.map((c: { id: string }) => ({ id: c.id, state: 1 })) } : { state: 1 });
      return new Response(text, { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    for (const batch of [false, true]) {
      const bus = createAsyncCommandBus({ retry: false, transport: httpTransport({ endpoint: '/api', ...(batch ? { batch: {} } : {}) }) });
      bus.use(idempotent({ ttl: 0, key: (cmd) => cmd.target.k }));
      for (const k of keys) await bus.dispatch('save', { k });
    }
    const want = keys.map((k) => (k === '' ? undefined : `"${encodeURIComponent(k)}"`));
    expect(sent).toEqual([...want, ...want]);
    // Each body is the text JSON.stringify writes for it: the appended member included.
    expect(texts.filter((t) => JSON.stringify(JSON.parse(t)) !== t)).toEqual([]);
    expect(texts).toHaveLength(keys.length * 2);

    // A WebSocket frame: the same member, the same bytes.
    let socket!: MockWebSocket;
    vi.stubGlobal('WebSocket', class extends MockWebSocket { constructor(u: string) { super(u); socket = this; } });
    const ws = wsTransport({ url: 'ws://x' });
    const bus = createAsyncCommandBus({ retry: false, transport: ws });
    bus.use(idempotent({ ttl: 0, key: (cmd) => cmd.target.k }));
    ws.connect();
    await Promise.resolve();
    for (const k of keys) void bus.dispatch('save', { k });
    await Promise.resolve();
    expect(socket.sent.map((f) => JSON.parse(f).headers?.['Idempotency-Key'])).toEqual(want);
    expect(socket.sent.filter((f) => JSON.stringify(JSON.parse(f)) !== f)).toEqual([]);
    ws.disconnect();
  });

  it('two different targets never collapse to the same header', async () => {
    const a = await sentKey({ q: '\u{1F600}' });
    const b = await sentKey({ q: '\u{1F601}' });
    expect(a).not.toBe(b);
  });
});
