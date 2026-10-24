/** Each action's record follows every change of what it holds: the next command sees it. The long note is at the end. */
import { describe, expect, it } from 'vitest';
import { type BaseBus, type CommandResult, type PluginParts, createAsyncCommandBus, createCommandBus, _errResult as err } from '../src/command-bus';

// A part that only hears takes each command off the bare path, so it builds a record.
const withRecords = (bus: BaseBus): BaseBus => { bus.use({ settled() {} }); return bus; };
const BUSES: Array<[string, () => BaseBus]> = [
  ['sync', () => withRecords(createCommandBus())],
  ['async', () => withRecords(createAsyncCommandBus({ retry: false }))],
];
const code = (r: CommandResult) => (r.ok ? 'ok' : (r.error as { code?: string }).code ?? r.error.message);
const refuse = (): PluginParts => ({
  id: 'refuse',
  authorize: () => (_cmd, fail) => err(fail('refused:action', 'refused')),
});
const limit = (actions: string[]): PluginParts => ({
  id: 'limit',
  actions,
  admit: (_cmd, fail) => err(fail('refused:action', 'limited')),
});

describe.each(BUSES)('the action record on the %s bus', (_name, make) => {
  it('a handler registered after a miss answers the next command', async () => {
    const bus = make();
    expect((await bus.dispatch('a', {})).ok).toBe(false);
    bus.register('a', () => 1);
    expect(await bus.dispatch('a', {})).toMatchObject({ ok: true, value: 1 });
  });

  it("a handler's cleanup takes it out of the next command", async () => {
    const bus = make();
    const off = bus.register('a', () => 1);
    expect((await bus.dispatch('a', {})).ok).toBe(true);
    off();
    expect((await bus.dispatch('a', {})).ok).toBe(false);
  });

  it('a plugin installed after a command rules the next one, and its removal frees it', async () => {
    const bus = make();
    bus.register('a', () => 1);
    expect(code(await bus.dispatch('a', {}))).toBe('ok');
    const off = bus.use(refuse());
    expect(code(await bus.dispatch('a', {}))).toMatch(/refused:action/);
    off();
    expect(code(await bus.dispatch('a', {}))).toBe('ok');
  });

  it('a covered and an uncovered action keep their own records on one bus', async () => {
    const bus = make();
    bus.register('a', () => 1);
    bus.register('b', () => 2);
    bus.use(limit(['a']));
    expect(code(await bus.dispatch('a', {}))).toMatch(/refused:action/);
    expect(code(await bus.dispatch('b', {}))).toBe('ok');
    expect(code(await bus.dispatch('a', {}))).toMatch(/refused:action/);
  });

  it('clear() empties the records with the handlers', async () => {
    const bus = make();
    bus.register('a', () => 1);
    expect((await bus.dispatch('a', {})).ok).toBe(true);
    bus.clear();
    expect((await bus.dispatch('a', {})).ok).toBe(false);
  });

  it('a listener subscribed after a command hears the next one, and its off() stops it', async () => {
    const bus = make();
    bus.register('a.x', () => 1);
    await bus.dispatch('a.x', {});
    const heard: string[] = [];
    const offExact = bus.on('a.x', () => heard.push('exact'));
    const offWild = bus.on('a.*', () => heard.push('wild'));
    await bus.dispatch('a.x', {});
    offExact();
    offWild();
    await bus.dispatch('a.x', {});
    expect(heard).toEqual(['exact', 'wild']);
  });

  it('past 512 actions the records start over and every action still answers', async () => {
    const bus = make();
    for (let i = 0; i < 600; i++) bus.register(`a${i}`, () => i);
    for (let i = 0; i < 600; i++) await bus.dispatch(`a${i}`, {});
    expect(await bus.dispatch('a0', {})).toMatchObject({ ok: true, value: 0 });
    expect(await bus.dispatch('a599', {})).toMatchObject({ ok: true, value: 599 });
  });
});

// A command reads its action's facts once, from a record built on the first
// command since the last change (plan 4.1, step 8f). Each case builds the
// record first, then changes what it holds, then checks the next command
// sees the change: a stale record would answer with the old handler or the
// old rules. Listeners stay out of the record, so a subscription after a
// command must still be heard; the case pins that. The cap case passes the
// 512 records the map holds before it starts over.
