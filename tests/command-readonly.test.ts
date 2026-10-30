/**
 * A command's action, target, payload and meta are readonly in its type, and a dispatched command keeps one hidden class.
 * Why: every part, listener and history entry reads the same command; declaring it readonly costs nothing at runtime, where freezing or checking it did.
 * Shows: a write to any of the four is a type error; meta's own fields stay writable; a command keeps the hidden class it was built with.
 * See: plan 4.1, log 36.116, log 36.127, docs/V8-RULES.md rules 1 and 2.
 */
import { describe, expect, it } from 'vitest';
import { type Command, createAsyncCommandBus, createCommandBus, _errResult as err } from '../src/command-bus';
import { sameMap } from './v8';

// Each `@ts-expect-error` sits in a branch that never runs: this file pins the type, not a runtime check.
describe('a command stays as dispatched', () => {
  it('its action, target, payload and meta are readonly to a handler, a part and a listener', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    const seen: string[] = [];
    bus.use({
      begin: (cmd) => {
        // @ts-expect-error readonly: every part, listener and history entry reads this command
        if (false as boolean) cmd.target = 1;
        return undefined;
      },
    });
    bus.on('a', (cmd) => {
      // @ts-expect-error readonly
      if (false as boolean) cmd.payload = 1;
      seen.push('listener');
    });
    bus.register('a', async (cmd: Command) => {
      // @ts-expect-error readonly
      if (false as boolean) cmd.action = 'b';
      // @ts-expect-error readonly
      if (false as boolean) cmd.meta = undefined;
      return 1;
    });
    expect(await bus.dispatch('a', { id: 1 })).toMatchObject({ ok: true, value: 1 });
    expect(seen).toEqual(['listener']);
  });

  it("control: the meta's own fields stay writable (a part's own stamp)", () => {
    const bus = createCommandBus();
    let note: unknown;
    bus.use({ started: (cmd) => { if (cmd.meta) (cmd.meta as unknown as Record<string, unknown>).note = 1; } });
    bus.register('a', (cmd: Command) => { note = (cmd.meta as unknown as Record<string, unknown>).note; return 1; });
    bus.dispatch('a', {});
    expect(note).toBe(1);
  });

  it('a dispatched command keeps the hidden class of one its run never reached (V8-RULES rule 1)', () => {
    const bus = createCommandBus();
    let fresh: Command | undefined;
    let done: Command | undefined;
    // `b` is refused before any work runs, so its command is as the bus built it.
    bus.use({ id: 'gate', authorize: (action) => (action === 'b' ? (cmd, fail) => { fresh = cmd; return err(fail('refused:action', 'no')); } : undefined) });
    bus.register('a', (cmd: Command) => { done = cmd; return 1; });
    bus.register('b', () => 1);
    bus.dispatch('a', { n: 1 });
    bus.dispatch('b', { n: 2 });
    expect(sameMap(done!, fresh!)).toBe(true);
  });
});
