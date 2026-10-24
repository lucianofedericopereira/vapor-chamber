/** A bus-level listener (`on('*')`, `onAfter`) hears every outcome once, whatever plugins are installed. The long note is at the end. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AsyncCommandBus, type CommandResult, type Transport, createAsyncCommandBus } from '../src/command-bus';
import { validator } from '../src/plugins-core';
import { httpTransport } from '../src/transports';

const code = (r: CommandResult) => (r.ok ? 'ok' : (r.error as { code?: string }).code ?? r.error.name);

/** A bus whose two listeners record what they hear, as `action -> code`. */
function heard(setup: (bus: AsyncCommandBus) => void, transport?: Transport) {
  const bus = createAsyncCommandBus({ retry: false, transport });
  const onStar: string[] = [];
  const after: string[] = [];
  setup(bus);
  bus.on('*', (cmd, r) => { onStar.push(`${cmd.action} -> ${code(r)}`); });
  bus.onAfter((cmd, r) => { after.push(`${cmd.action} -> ${code(r)}`); });
  return { bus, onStar, after };
}

afterEach(() => { vi.unstubAllGlobals(); });

const OUTCOMES: Array<{ name: string; setup: (bus: AsyncCommandBus) => void; action: string; signal?: AbortSignal; transport?: Transport }> = [
  { name: 'a success', action: 'save', setup: (bus) => bus.register('save', async () => 1) },
  { name: "a handler's throw", action: 'save', setup: (bus) => bus.register('save', async () => { throw new Error('down'); }) },
  { name: "a plugin's refusal", action: 'save', setup: (bus) => { bus.register('save', async () => 1); bus.use(validator({ save: () => 'bad' })); } },
  { name: 'a missing handler', action: 'nobody', setup: () => {} },
  { name: 'an abort before the work', action: 'save', signal: AbortSignal.abort(), setup: (bus) => bus.register('save', async () => 1) },
  { name: 'a sent success', action: 'save', transport: httpTransport({ endpoint: '/vc' }), setup: () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ state: 1 }), { status: 200, headers: { 'content-type': 'application/json' } }));
  } },
  { name: 'a sent failure', action: 'save', transport: httpTransport({ endpoint: '/vc' }), setup: () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ status: 422, code: 'bad', detail: 'no' }), { status: 422, headers: { 'content-type': 'application/problem+json' } }));
  } },
];

describe('a bus-level listener hears every outcome once', () => {
  for (const o of OUTCOMES) {
    it(o.name, async () => {
      const h = heard(o.setup, o.transport);
      const r = await h.bus.dispatch(o.action, {}, undefined, o.signal ? { signal: o.signal } : undefined);
      const line = `${o.action} -> ${code(r)}`;
      expect(h.onStar).toEqual([line]);
      expect(h.after).toEqual([line]);
    });
  }
});

/*
 * Step 1 of .probes/plan-1.32.md. In the new core a listener is how anything
 * reacts to an outcome (logger, metrics, history's recorder, timing), so the
 * contract it relies on is pinned before the core changes: each outcome kind,
 * from the work, from a plugin, from a missing handler, an
 * abort, and over the wire, reaches `on('*')` and `onAfter` exactly once with
 * the result the caller got. Green today: the bus already fans every settle
 * out (syncRunSettling). Step 8e (log 36.109) took `onBefore` out of the public
 * API, and its row with it: a gate is a rule, the plugin's refusal row.
 */
