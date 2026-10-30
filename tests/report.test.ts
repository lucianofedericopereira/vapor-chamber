/**
 * The reporter: one formatter, replaceable sinks, a level floor.
 * Why: a report is formatted once and every sink receives it; a throwing formatter or sink must not turn a reported listener error into a failed dispatch.
 * Shows: the default formatter's lines, the level floor, a sink receiving a listener's throw on both buses, the console as default sink, a replaced formatter, throwing formatter and sink, consoleSink kept beside an app's.
 * See: log s36.118
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BaseBus, createAsyncCommandBus, createCommandBus } from '../src/command-bus';
import { type Report, configureReport, consoleSink, formatReport } from '../src/report';

afterEach(() => { configureReport(null); });

const collect = () => {
  const got: Report[] = [];
  configureReport({ sinks: [(r) => { got.push(r); }] });
  return got;
};

describe('the default formatter', () => {
  it('prints the level tag, the code and the message, then the docs link in development', () => {
    const [text] = formatReport({ code: 'core:refused:bus', level: 'error', message: 'a sealed bus' });
    expect(String(text).split('\n')).toEqual([
      '[vapor-chamber] [ FAIL ] core:refused:bus: a sealed bus',
      '  docs: https://github.com/lucianofedericopereira/vapor-chamber/blob/main/docs/errors.md#refused',
    ]);
  });

  it('a warning carries [ WARN ], as wide as [ FAIL ]', () => {
    const [warn] = formatReport({ code: 'core:invalid:name', level: 'warn', message: 'x' });
    const [fail] = formatReport({ code: 'core:invalid:name', level: 'error', message: 'x' });
    expect([String(warn).split('\n')[0], String(fail).split('\n')[0]]).toEqual([
      '[vapor-chamber] [ WARN ] core:invalid:name: x',
      '[vapor-chamber] [ FAIL ] core:invalid:name: x',
    ]);
  });

  it('an error rides as its own argument, so the console keeps its stack', () => {
    const e = new Error('boom');
    expect(formatReport({ code: 'app:failed:thing', level: 'error', message: 'x', error: e })).toEqual([expect.stringMatching(/^\[vapor-chamber\] \[ FAIL \] app:failed:thing: x\n/), e]);
  });
});

describe('the level floor', () => {
  // One bus yields a warning (naming rule) and an error (listener throw).
  const both = (): string[] => {
    const got: string[] = [];
    configureReport({ sinks: [(r) => { got.push(r.level); }], level: floorOf });
    const bus = createCommandBus({ naming: { pattern: /^[a-z]+$/ } });
    bus.register('A', () => 1);
    bus.on('A', () => { throw new Error('x'); });
    bus.dispatch('A', {});
    return got;
  };
  let floorOf: 'warn' | 'error' | 'silent' | undefined;

  it("'warn', the default, reports both; 'error' drops the warning; 'silent' reports nothing", () => {
    floorOf = undefined;
    expect(both()).toEqual(['warn', 'warn', 'error']); // the naming rule warns at register and at dispatch
    floorOf = 'error';
    expect(both()).toEqual(['error']);
    floorOf = 'silent';
    expect(both()).toEqual([]);
  });

  it('control: configureReport(null) puts the floor back to warn', () => {
    floorOf = 'silent';
    both();
    configureReport(null);
    const got: string[] = [];
    configureReport({ sinks: [(r) => { got.push(r.level); }] });
    const bus = createCommandBus({ naming: { pattern: /^[a-z]+$/ } });
    bus.register('A', () => 1);
    bus.dispatch('A', {});
    expect(got).toEqual(['warn', 'warn']);
  });
});

describe('sinks', () => {
  it("a listener's throw reaches a configured sink with its code, level and error, on both buses", async () => {
    for (const bus of [createCommandBus(), createAsyncCommandBus({ retry: false })] as BaseBus[]) {
      const got = collect();
      const e = new Error('listener broke');
      bus.register('a', () => 1);
      bus.on('a', () => { throw e; });
      const r = await bus.dispatch('a', {});
      expect(r.ok).toBe(true);
      expect(got.map((g) => [g.code, g.level, g.error])).toEqual([['core:failed:listener', 'error', e]]);
      configureReport(null);
    }
  });

  it('the console is the default sink; configureReport(null) restores it', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    configureReport({ sinks: [] });
    const bus = createCommandBus();
    bus.register('a', () => 1);
    bus.on('a', () => { throw new Error('quiet'); });
    bus.dispatch('a', {});
    expect(error).not.toHaveBeenCalled();
    configureReport(null);
    bus.dispatch('a', {});
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0]).split('\n')[0]).toBe('[vapor-chamber] [ FAIL ] core:failed:listener: a listener threw on "a"');
  });

  it('a replaced formatter feeds every sink', () => {
    const seen: unknown[][] = [];
    configureReport({ format: (r) => [`${r.level} ${r.code}`], sinks: [(_r, args) => { seen.push([...args]); }, (_r, args) => { seen.push([...args]); }] });
    const bus = createCommandBus();
    bus.register('a', () => 1);
    bus.on('a', () => { throw new Error('x'); });
    bus.dispatch('a', {});
    expect(seen).toEqual([['error core:failed:listener'], ['error core:failed:listener']]);
  });

  it('a throwing formatter: the default formats the report, the sinks get it, the throw is printed', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const got: unknown[][] = [];
    configureReport({ format: () => { throw new Error('format broke'); }, sinks: [(_r, args) => { got.push([...args]); }] });
    const bus = createCommandBus();
    bus.register('a', () => 1);
    bus.on('a', () => { throw new Error('listener broke'); });
    expect(bus.dispatch('a', {}).ok).toBe(true);
    expect(String(got[0]?.[0]).split('\n')[0]).toBe('[vapor-chamber] [ FAIL ] core:failed:listener: a listener threw on "a"');
    expect(error.mock.calls.map((c) => String(c[0]).split('\n')[0])).toEqual([
      '[vapor-chamber] [ FAIL ] core:failed:listener: a listener threw on "a"',
      '[vapor-chamber] [ FAIL ] core:failed:report: a report formatter or sink threw',
    ]);
  });

  it("a throwing sink prints the report and its throw through the defaults, and the dispatch stays ok", () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    configureReport({ sinks: [() => { throw new Error('sink broke'); }] });
    const bus = createCommandBus();
    bus.register('a', () => 1);
    bus.on('a', () => { throw new Error('listener broke'); });
    expect(bus.dispatch('a', {}).ok).toBe(true);
    expect(error.mock.calls.map((c) => String(c[0]).split('\n')[0])).toEqual([
      '[vapor-chamber] [ FAIL ] core:failed:listener: a listener threw on "a"',
      '[vapor-chamber] [ FAIL ] core:failed:report: a report formatter or sink threw',
    ]);
  });

  it('control: an app keeps the console by listing consoleSink beside its own', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const got: Report[] = [];
    configureReport({ sinks: [consoleSink, (r) => { got.push(r); }] });
    const bus = createCommandBus();
    bus.register('a', () => 1);
    bus.on('a', () => { throw new Error('x'); });
    bus.dispatch('a', {});
    expect([error.mock.calls.length, got.length]).toEqual([1, 1]);
  });
});
