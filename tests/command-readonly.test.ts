/** A command's action, target, payload and meta are readonly in its type, and a dispatched command keeps one hidden class. The long note is at the end. */
import { describe, expect, it } from 'vitest';
import { type Command, createAsyncCommandBus, createCommandBus, _errResult as err } from '../src/command-bus';
import { sameMap } from './v8';

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

// Plan 4.1 asked for the command to stay as dispatched in development. The
// first answer froze it at its work (36.116): a second hidden class mid-life,
// against docs/V8-RULES.md rules 1 and 2, and the bench read development
// dispatch 2.3x slower. A per-dispatch compare in its place (36.127) still
// cost development 17-48% on the paths with parts, and the ritual's third
// question rules out a check per dispatch anyway. The fact is declared at
// build time instead: the type makes the four fields readonly, so a write is
// a compile error and costs nothing at runtime. The `@ts-expect-error` lines
// fail typecheck if the type ever lets a write through. Each sits in a branch
// that never runs, since this file pins the type, not a runtime check. The
// hidden-class case pins rule 1 at runtime: nothing changes a command's map.
