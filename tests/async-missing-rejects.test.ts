/**
 * An async bus's missing handler under `onMissing: 'throw'` must reach the
 * plugin chain as a REJECTED promise, never a synchronous throw.
 *
 * The async `execute` closure is a plain function returning
 * `tryCatchAsyncHandler`'s promise (one async frame and promise fewer per
 * dispatch than an `async` closure); the missing path goes through the
 * `async` `asyncMissing` helper so this contract survives. A plugin written
 * against the async bus - `next().catch(...)` - would otherwise never attach
 * its handler, and the throw would escape past it.
 */
import { describe, expect, it } from 'vitest';
import { type AsyncPlugin, type CommandResult, createAsyncCommandBus } from '../src/command-bus';

const recover: AsyncPlugin = (_cmd, next) =>
  (next() as Promise<CommandResult>).catch((e: Error) => ({ ok: false, value: undefined, error: e }) as CommandResult);

describe("async bus, onMissing: 'throw' - the plugin chain sees a rejection", () => {
  it('dispatch: a plugin chaining .catch on next() recovers the missing handler', async () => {
    const bus = createAsyncCommandBus({ onMissing: 'throw' });
    bus.use(recover);
    const r = await bus.dispatch('no.handler', {});
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain('No handler');
  });

  it('query: same contract', async () => {
    const bus = createAsyncCommandBus({ onMissing: 'throw' });
    bus.use(recover);
    const r = await bus.query('no.handler', {});
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain('No handler');
  });

  it('a present handler still resolves through the same closure', async () => {
    const bus = createAsyncCommandBus({ onMissing: 'throw' });
    bus.use(recover);
    bus.register('t', async (c) => c.target);
    expect((await bus.dispatch('t', 7)).value).toBe(7);
    expect((await bus.query('t', 8)).value).toBe(8);
  });
});
