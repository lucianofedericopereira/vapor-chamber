/**
 * An async bus's missing handler under `onMissing: 'throw'` reaches the caller
 * as a REJECTED promise, never a synchronous throw, past the work's steps.
 *
 * The async `execute` closure is a plain function returning
 * `tryCatchAsyncHandler`'s promise (one async frame and promise fewer per
 * dispatch than an `async` closure); the missing path goes through the
 * `async` `asyncMissing` helper so this contract survives. A step's ticket
 * lands with the failure before the rejection reaches the caller.
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
