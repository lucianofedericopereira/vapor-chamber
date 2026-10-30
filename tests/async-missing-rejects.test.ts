/**
 * An async bus's missing handler under `onMissing: 'throw'`: a rejected promise, never a synchronous throw.
 * Why: the async `execute` is a plain arrow for speed, so the missing path must stay async on its own (`asyncMissing`).
 * Shows: dispatch and query reject with core:missing:handler, a step's ticket lands with the failure first, a present handler still resolves.
 * See: tests/async-execute-ab.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { type CommandResult, createAsyncCommandBus } from '../src/command-bus';

/** A step whose ticket records what it landed with. */
function watching(landed: CommandResult[]) {
  return { begin: () => ({ landed: (r: CommandResult) => { landed.push(r); } }) };
}

describe("async bus, onMissing: 'throw' - a rejection, past the steps", () => {
  it('dispatch rejects with the missing handler, and the ticket lands with it', async () => {
    const bus = createAsyncCommandBus({ onMissing: 'throw' });
    const landed: CommandResult[] = [];
    bus.use(watching(landed));
    let sync = false;
    let p!: Promise<CommandResult>;
    try { p = bus.dispatch('no.handler', {}); } catch { sync = true; }
    expect(sync).toBe(false);
    await expect(p).rejects.toMatchObject({ code: 'core:missing:handler' });
    expect(landed).toHaveLength(1);
    expect(landed[0]).toFailWith('core:missing:handler');
  });

  it('query: same contract', async () => {
    const bus = createAsyncCommandBus({ onMissing: 'throw' });
    bus.use(watching([]));
    await expect(bus.query('no.handler', {})).rejects.toMatchObject({ code: 'core:missing:handler' });
  });

  it('a present handler still resolves through the same closure', async () => {
    const bus = createAsyncCommandBus({ onMissing: 'throw' });
    bus.use(watching([]));
    bus.register('t', async (c) => c.target);
    expect((await bus.dispatch('t', 7)).value).toBe(7);
    expect((await bus.query('t', 8)).value).toBe(8);
  });
});
