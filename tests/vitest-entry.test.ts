/**
 * `vapor-chamber/vitest` and `vapor-chamber/vitest/pure`, in-repo.
 *
 * Acceptance assertions from vitest5-plugin-study.md (Rev 3 section 6, Rev 2
 * B.7) that a run inside this repository can falsify. The packed-consumer half
 * (A1, A4, A5, A10, A12 at runtime, A13) is tests/vitest-consumer.test.ts; the
 * plugin object (A11) is tests/vitest-plugin.test.ts.
 *
 * Diagnostics are asserted on `code` and on the fix they name, never on the
 * rest of the message text (CONTRIBUTING.md, module discipline).
 *
 * No `expect.extend` here: vitest.config.ts loads src/vitest.ts as a setup
 * file, so the matchers and the tapped shared bus arrive the way a consumer
 * gets them. VC_TEST_VITEST_MAJOR is the plugin's (tests/vitest-plugin.test.ts).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { chai, describe, expect, it } from 'vitest';
import { getCommandBus } from '../src/chamber';
import { BusError, createAsyncCommandBus, createCommandBus, inspectBus } from '../src/command-bus';
import { createTestBus } from '../src/testing';
import { _beginTest, _explainFailure, _setInstalledBus, tap, VcTestError } from '../src/vitest-pure';

type Shop = {
  cartAdd: { target: { id: number }; payload: { qty: number }; result: number };
  cartClear: { target: null; result: void };
};

/** The thrown error of `fn`, or a failure if it did not throw. */
function thrown(fn: () => unknown): any {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected a throw');
}

/** Runs a matcher and returns its failure message, or a failure if it passed. */
function failure(fn: () => unknown): string {
  return withoutColors(String(thrown(fn).message));
}

// Vitest colors a diff in a color terminal (FORCE_COLOR, a TTY); the text read is the same.
const withoutColors = (text: string) => text.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');

describe('A2 real bus', () => {
  it('tap(bus) returns the bus it was given, not a wrapper or a double', () => {
    const bus = createCommandBus<Shop>();
    expect(tap(bus)).toBe(bus);
    // The hook is the one observable difference, and it is on the real bus.
    expect(inspectBus(bus).afterHookCount).toBe(1);
  });
  it('the shared bus the entry installs is a real createCommandBus() bus', () => {
    const bus = getCommandBus();
    // A real bus carries the inspect symbol; a TestBus answers inspectBus from
    // its fallback, which always reports 0 after-hooks.
    expect(Object.getOwnPropertySymbols(bus).map((s) => s.description)).toContain('vapor-chamber:inspect');
    expect(inspectBus(bus).afterHookCount).toBe(1);
  });

  it('neither entry source constructs a TestBus', () => {
    for (const file of ['src/vitest.ts', 'src/vitest-pure.ts']) {
      expect(readFileSync(resolve(process.cwd(), file), 'utf8')).not.toMatch(/createTestBus|from '\.\/testing'/);
    }
  });
});

describe('A3 freshness', () => {
  let first: object | undefined;

  it('first test: dispatches on the shared bus are recorded', () => {
    const bus = getCommandBus();
    bus.register('cartAdd', () => 1);
    bus.dispatch('cartAdd', { id: 1 }, { qty: 1 });
    expect(bus).toHaveBeenDispatchedWith('cartAdd', { qty: 1 });
    first = bus;
  });

  it('second test: the shared bus recorded nothing at its start, and is a different bus', () => {
    const bus = getCommandBus();
    expect(first).toBeDefined();
    expect(bus).not.toBe(first);
    expect(bus.hasHandler('cartAdd')).toBe(false);
    expect(failure(() => expect(bus).toHaveBeenDispatched('cartAdd'))).toContain('Number of dispatches: 0');
  });
});

describe('A6 lazy import', () => {
  /** Static and dynamic import specifiers of a source file, from the compiler's own AST. */
  function importsOf(file: string) {
    const source = ts.createSourceFile(file, readFileSync(resolve(process.cwd(), file), 'utf8'), ts.ScriptTarget.ES2022, true);
    const statics: string[] = [];
    const dynamics: { specifier: string; runsIn: string }[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
        statics.push((node.moduleSpecifier as ts.StringLiteral).text);
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        // The call the nearest enclosing function is passed to: 'beforeEach',
        // "extend('bus')" for a fixture, or 'module load' outside any function.
        let fn: ts.Node | undefined = node.parent;
        while (fn && !ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn) && !ts.isFunctionDeclaration(fn)) fn = fn.parent;
        let runsIn = fn === undefined ? 'module load' : 'a function not passed to a hook or a fixture';
        const call = fn?.parent;
        if (call && ts.isCallExpression(call)) {
          const callee = call.expression;
          if (ts.isIdentifier(callee) && callee.text === 'beforeEach') runsIn = 'beforeEach';
          if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'extend' && call.arguments[0] && ts.isStringLiteral(call.arguments[0])) {
            runsIn = `extend('${call.arguments[0].text}')`;
          }
        }
        dynamics.push({ specifier: (node.arguments[0] as ts.StringLiteral).text, runsIn });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return { statics, dynamics };
  }

  it('the static import graph of both entries reaches no src/ module but the two entries', () => {
    expect(importsOf('src/vitest.ts').statics).toEqual(['vitest', './vitest-pure']);
    expect(importsOf('src/vitest-pure.ts').statics).toEqual([]);
  });

  it('the library is imported inside beforeEach and inside the fixtures, never at module load', () => {
    expect(importsOf('src/vitest.ts').dynamics).toEqual([
      { specifier: 'vapor-chamber', runsIn: 'beforeEach' },
      { specifier: 'vapor-chamber', runsIn: "extend('bus')" },
      { specifier: 'vapor-chamber', runsIn: "extend('asyncBus')" },
    ]);
    expect(importsOf('src/vitest-pure.ts').dynamics).toEqual([]);
  });
});

describe('A8 misuse is coded and names the fix', () => {
  it('VC_TEST_UNTAPPED: a matcher on an untapped bus throws, with the tap(bus) fix', () => {
    const bus = createCommandBus();
    const e = thrown(() => expect(bus).toHaveBeenDispatched('cartAdd'));
    expect(e).toBeInstanceOf(VcTestError);
    expect(e.code).toBe('VC_TEST_UNTAPPED');
    expect(e.fix).toContain('tap(createCommandBus())');
    expect(e.docs).toMatch(/docs\/api\/vitest-pure\.md#vctestdiagnostic$/);
    // The message carries all three, so a reporter shows the fix.
    expect(e.message).toContain(e.fix);
    expect(e.message).toContain(e.docs);
    expect(thrown(() => expect(bus).toHaveFailedWith('cartAdd', 'VC_CORE_NO_HANDLER')).code).toBe('VC_TEST_UNTAPPED');
  });

  it('VC_TEST_UNTAPPED: .not on an untapped bus throws too, instead of passing vacuously', () => {
    const bus = createCommandBus();
    expect(thrown(() => expect(bus).not.toHaveBeenDispatched('cartAdd')).code).toBe('VC_TEST_UNTAPPED');
  });

  it('VC_TEST_UNTAPPED: a value that is not a bus at all', () => {
    expect(thrown(() => expect(undefined).toHaveBeenDispatched('cartAdd')).code).toBe('VC_TEST_UNTAPPED');
  });

  it('VC_TEST_UNTAPPED, not DUPLICATE: an untapped bus of the same instance as the installed one', () => {
    _setInstalledBus(tap(createCommandBus()));
    try {
      expect(thrown(() => expect(createCommandBus()).toHaveBeenDispatched('a')).code).toBe('VC_TEST_UNTAPPED');
      // A TestBus of the same instance shares its unseal symbol: still one instance.
      expect(thrown(() => expect(createTestBus()).toHaveBeenDispatched('a')).code).toBe('VC_TEST_UNTAPPED');
      // No symbols at all to compare is not evidence of a second copy.
      expect(thrown(() => expect({}).toHaveBeenDispatched('a')).code).toBe('VC_TEST_UNTAPPED');
    } finally {
      _setInstalledBus(undefined);
    }
  });

  it('VC_TEST_DUPLICATE_INSTANCE: a bus from a second module instance is named as such', async () => {
    // A query makes a second module id, so command-bus.ts evaluates again: a
    // second instance with its own symbols, exactly what a duplicated install
    // loads. Not vi.resetModules(): that would also give the NEXT test's shared
    // bus a fresh instance beside this file's static imports - which the entry
    // then correctly reports as a duplicate.
    const other = await import('../src/command-bus?second-instance');
    const foreign = other.createCommandBus();
    _setInstalledBus(tap(createCommandBus()));
    try {
      const e = thrown(() => expect(foreign).toHaveBeenDispatched('cartAdd'));
      expect(e.code).toBe('VC_TEST_DUPLICATE_INSTANCE');
      expect(e.fix).toContain('npm ls vapor-chamber');
      // Control: the same foreign bus with nothing installed cannot be compared.
      _setInstalledBus(undefined);
      expect(thrown(() => expect(foreign).toHaveBeenDispatched('cartAdd')).code).toBe('VC_TEST_UNTAPPED');
    } finally {
      _setInstalledBus(undefined);
    }
  });

  it('VC_TEST_TAP_REMOVED: clear() drops the tap, and a failing assertion names it instead of "nothing was dispatched"', () => {
    const bus = tap(createCommandBus());
    bus.clear();
    bus.register('a', () => 1);
    bus.dispatch('a', null);
    const e = thrown(() => expect(bus).toHaveBeenDispatched('a'));
    expect(e).toBeInstanceOf(VcTestError);
    expect(e.code).toBe('VC_TEST_TAP_REMOVED');
    expect(e.fix).toContain('tap(bus)');
    expect(thrown(() => expect(bus).toHaveFailedWith('b', 'VC_CORE_NO_HANDLER')).code).toBe('VC_TEST_TAP_REMOVED');
  });

  it('VC_TEST_TAP_REMOVED: .not after dispose() throws too, instead of passing vacuously', async () => {
    const bus = tap(createAsyncCommandBus());
    bus.dispose();
    expect(thrown(() => expect(bus).not.toHaveBeenDispatched('a')).code).toBe('VC_TEST_TAP_REMOVED');
    expect(thrown(() => expect(bus).not.toHaveFailedWith('a', 'VC_CORE_NO_HANDLER')).code).toBe('VC_TEST_TAP_REMOVED');
  });

  it('VC_TEST_TAP_REMOVED only where a missed record could change the outcome: records from before clear() still decide', () => {
    const bus = tap(createCommandBus());
    bus.dispatch('gone', null);
    bus.clear();
    expect(bus).toHaveBeenDispatched('gone');
    expect(bus).toHaveFailedWith('gone', 'VC_CORE_NO_HANDLER');
    expect(failure(() => expect(bus).not.toHaveBeenDispatched('gone'))).toContain('expected "gone" to not be dispatched at all, but actually been dispatched 1 times');
  });

  it('tap(bus) again after clear() re-attaches to the same record; tapping a live bus stays idempotent', () => {
    const bus = tap(createCommandBus());
    bus.register('a', () => 1);
    bus.dispatch('a', null, 1);
    bus.clear();
    expect(tap(tap(bus))).toBe(bus);
    expect(inspectBus(bus).afterHookCount).toBe(1);
    bus.register('a', () => 2);
    bus.dispatch('a', null, 2);
    expect(bus).toHaveBeenDispatchedWith('a', 1);
    expect(bus).toHaveBeenDispatchedWith('a', 2);
    expect(bus).not.toHaveBeenDispatchedWith('a', 3);
  });

  it('VC_TEST_TAP_REMOVED, limit: a hook added after clear() hides the removal, and the matcher reports what it saw', () => {
    const bus = tap(createCommandBus());
    bus.clear();
    bus.onAfter(() => {});
    bus.dispatch('a', null);
    expect(failure(() => expect(bus).toHaveBeenDispatched('a'))).toContain('Number of dispatches: 0');
  });
});

describe('tap(bus) over onAfter', () => {
  it('records action, target, payload, ok, value, code and message in order', () => {
    const bus = tap(createCommandBus());
    bus.register('ok', (cmd) => cmd.payload.n * 2);
    bus.register('domain', () => {
      throw Object.assign(new Error('out of stock'), { code: 'OUT_OF_STOCK' });
    });
    bus.register('plain', () => {
      throw new Error('no code here');
    });
    bus.dispatch('ok', { id: 1 }, { n: 2 });
    bus.dispatch('missing', null);
    bus.dispatch('domain', null);
    bus.dispatch('plain', null);

    expect(bus).toHaveBeenDispatchedWith('ok', { n: 2 });
    expect(bus).toHaveFailedWith('missing', 'VC_CORE_NO_HANDLER');
    expect(bus).toHaveFailedWith('domain', 'OUT_OF_STOCK');
    // A failure lists every dispatch the way toHaveBeenCalledWith lists calls.
    const message = failure(() => expect(bus).toHaveBeenDispatched('nope'));
    expect(message).toContain('Received:\n\n  1st dispatch:\n\n');
    for (const nth of ['2nd', '3rd', '4th']) expect(message).toContain(`  ${nth} dispatch:\n\n`);
    expect(message).toContain('  4th dispatch:\n\n    Object {\n      "action": "plain",');
    expect(message).toContain('Number of dispatches: 4');
    const failed = failure(() => expect(bus).toHaveFailedWith('domain', 'VC_CORE_NO_HANDLER'));
    expect(failed).toContain('-   "code": "VC_CORE_NO_HANDLER",\n+   "code": "OUT_OF_STOCK",');
  });

  it('is idempotent: tapping twice records once', () => {
    const bus = createCommandBus();
    bus.register('a', () => 1);
    expect(tap(tap(bus))).toBe(bus);
    expect(inspectBus(bus).afterHookCount).toBe(1);
    bus.dispatch('a', null);
    expect(failure(() => expect(bus).not.toHaveBeenDispatched('a'))).toContain('Number of dispatches: 1');
  });

  it('works on the async bus, recording the settled result', async () => {
    const bus = tap(createAsyncCommandBus<Shop>());
    bus.register('cartAdd', async (cmd) => cmd.payload.qty + 1);
    const result = await bus.dispatch('cartAdd', { id: 1 }, { qty: 2 });
    expect(result).toSucceedWith(3);
    expect(bus).toHaveBeenDispatchedWith('cartAdd', { qty: 2 });
  });

  it('a structural bus with only onAfter is tapped, and without the inspect symbol a removal is never reported', () => {
    const hooks: ((cmd: any, result: any) => void)[] = [];
    const bus = {
      onAfter: (h: (cmd: any, result: any) => void) => {
        hooks.push(h);
        return () => {};
      },
    };
    expect(tap(tap(bus))).toBe(bus);
    expect(hooks).toHaveLength(1);
    expect(failure(() => expect(bus).toHaveBeenDispatched('a'))).toContain('Number of dispatches: 0');
  });

  it('a sealed bus refuses the tap with VC_CORE_SEALED, and stays untapped', () => {
    const bus = createCommandBus();
    bus.seal();
    const e = thrown(() => tap(bus));
    expect(e).toBeInstanceOf(BusError);
    expect(e.code).toBe('VC_CORE_SEALED');
    expect(thrown(() => expect(bus).toHaveBeenDispatched('a')).code).toBe('VC_TEST_UNTAPPED');
  });
});

describe('matchers', () => {
  it('toHaveBeenDispatched and toHaveBeenDispatchedWith: action alone, action with payload, and .not', () => {
    const bus = tap(createCommandBus<Shop>());
    bus.register('cartAdd', (cmd) => cmd.payload.qty);
    expect(failure(() => expect(bus).toHaveBeenDispatched('cartAdd'))).toContain('Number of dispatches: 0');

    bus.dispatch('cartAdd', { id: 1 }, { qty: 2 });
    expect(bus).toHaveBeenDispatched('cartAdd');
    expect(bus).toHaveBeenDispatchedWith('cartAdd', { qty: 2 });
    expect(bus).not.toHaveBeenDispatchedWith('cartAdd', { qty: 3 });
    expect(bus).not.toHaveBeenDispatched('cartClear');

    const differs = failure(() => expect(bus).toHaveBeenDispatchedWith('cartAdd', { qty: 3 }));
    // Worded as Vitest words toHaveBeenCalledWith: 'expected "spy" to be called with arguments: [...]'.
    expect(differs).toContain('expected "cartAdd" to be dispatched with payload: {"qty": 3}');
    // The payload diff, as toHaveBeenCalledWith diffs arguments.
    expect(differs).toContain('    "payload": {\n-     "qty": 3,\n+     "qty": 2,');
    expect(failure(() => expect(bus).not.toHaveBeenDispatchedWith('cartAdd', { qty: 2 }))).toContain(
      'expected "cartAdd" to not be dispatched with payload: {"qty": 2}',
    );
    expect(failure(() => expect(bus).toHaveBeenDispatched('cartClear'))).toContain('expected "cartClear" to be dispatched at least once');
    expect(failure(() => expect(bus).not.toHaveBeenDispatched('cartAdd'))).toContain(
      'expected "cartAdd" to not be dispatched at all, but actually been dispatched 1 times',
    );
  });

  it('toHaveBeenDispatchedTimes and toHaveBeenDispatchedOnce count one action', () => {
    const bus = tap(createCommandBus<Shop>());
    bus.register('cartAdd', (cmd) => cmd.payload.qty);
    bus.dispatch('cartAdd', { id: 1 }, { qty: 1 });
    bus.dispatch('cartClear', null);
    expect(bus).toHaveBeenDispatchedTimes('cartAdd', 1);
    expect(bus).toHaveBeenDispatchedOnce('cartAdd');
    expect(bus).toHaveBeenDispatchedTimes('cartClear', 1);
    bus.dispatch('cartAdd', { id: 1 }, { qty: 2 });
    expect(bus).toHaveBeenDispatchedTimes('cartAdd', 2);
    expect(bus).not.toHaveBeenDispatchedOnce('cartAdd');
    expect(failure(() => expect(bus).toHaveBeenDispatchedTimes('cartAdd', 3))).toContain('expected "cartAdd" to be dispatched 3 times, but got 2 times');
    expect(failure(() => expect(bus).not.toHaveBeenDispatchedTimes('cartAdd', 2))).toContain('expected "cartAdd" to not be dispatched 2 times');
    expect(failure(() => expect(bus).toHaveBeenDispatchedOnce('cartAdd'))).toContain('expected "cartAdd" to be dispatched once, but got 2 times');
    expect(failure(() => expect(bus).toHaveBeenDispatchedOnce('cartAdd'))).toContain('Number of dispatches: 3');
    expect(failure(() => expect(bus).not.toHaveBeenDispatchedOnce('cartClear'))).toContain('expected "cartClear" to not be dispatched once');
  });

  it('toHaveBeenNthDispatchedWith and toHaveBeenLastDispatchedWith read the dispatches of that action, 1-based', () => {
    const bus = tap(createCommandBus<Shop>());
    bus.register('cartAdd', (cmd) => cmd.payload.qty);
    bus.dispatch('cartAdd', { id: 1 }, { qty: 1 });
    bus.dispatch('cartClear', null);
    bus.dispatch('cartAdd', { id: 1 }, { qty: 2 });
    expect(bus).toHaveBeenNthDispatchedWith(1, 'cartAdd', { qty: 1 });
    expect(bus).toHaveBeenNthDispatchedWith(2, 'cartAdd', { qty: 2 });
    expect(bus).not.toHaveBeenNthDispatchedWith(2, 'cartAdd', { qty: 1 });
    expect(bus).not.toHaveBeenNthDispatchedWith(3, 'cartAdd', { qty: 2 });
    expect(bus).toHaveBeenLastDispatchedWith('cartAdd', { qty: 2 });
    expect(bus).not.toHaveBeenLastDispatchedWith('cartAdd', { qty: 1 });
    expect(bus).not.toHaveBeenLastDispatchedWith('cartClear', { qty: 1 });
    expect(failure(() => expect(bus).toHaveBeenNthDispatchedWith(1, 'cartAdd', { qty: 5 }))).toContain('expected 1st "cartAdd" dispatch to have payload: {"qty": 5}');
    expect(failure(() => expect(bus).not.toHaveBeenNthDispatchedWith(1, 'cartAdd', { qty: 1 }))).toContain('expected 1st "cartAdd" dispatch to not have payload: {"qty": 1}');
    expect(failure(() => expect(bus).toHaveBeenLastDispatchedWith('cartAdd', { qty: 5 }))).toContain('expected last "cartAdd" dispatch to have payload: {"qty": 5}');
    expect(failure(() => expect(bus).not.toHaveBeenLastDispatchedWith('cartAdd', { qty: 2 }))).toContain('expected last "cartAdd" dispatch to not have payload: {"qty": 2}');
  });

  it('counting and positional matchers throw VC_TEST_TAP_REMOVED either way: a missed dispatch changes a count in both directions', () => {
    const bus = tap(createCommandBus());
    bus.register('a', () => 1);
    bus.dispatch('a', null, 1);
    bus.clear();
    for (const run of [
      () => expect(bus).toHaveBeenDispatchedTimes('a', 1),
      () => expect(bus).toHaveBeenDispatchedOnce('a'),
      () => expect(bus).toHaveBeenNthDispatchedWith(1, 'a', 1),
      () => expect(bus).toHaveBeenLastDispatchedWith('a', 1),
    ]) {
      expect(thrown(run).code).toBe('VC_TEST_TAP_REMOVED');
    }
  });

  it('with nothing dispatched a failure says so, as toHaveBeenCalled does: no Received block', () => {
    const bus = tap(createCommandBus());
    const message = failure(() => expect(bus).toHaveBeenDispatched('a'));
    expect(message).not.toContain('Received:');
    expect(message).toMatch(/Number of dispatches: 0$/);
  });

  it('payloads and values compare as toEqual does: Map and Set contents count', () => {
    const bus = tap(createCommandBus());
    bus.register('a', (cmd) => cmd.payload);
    const result = bus.dispatch('a', null, new Map([[1, 'one']]));
    expect(bus).toHaveBeenDispatchedWith('a', new Map([[1, 'one']]));
    expect(bus).not.toHaveBeenDispatchedWith('a', new Map([[1, 'two']]));
    expect(result).toSucceedWith(new Map([[1, 'one']]));
    expect(result).not.toSucceedWith(new Map([[1, 'two']]));
    expect(bus.dispatch('a', null, new Set([1]))).not.toSucceedWith(new Set([2]));
  });

  it('toHaveBeenDispatchedWith: an explicit undefined payload is compared, not ignored', () => {
    const bus = tap(createCommandBus());
    bus.register('a', () => 1);
    bus.dispatch('a', null, { x: 1 });
    expect(bus).not.toHaveBeenDispatchedWith('a', undefined);
  });

  it('toHaveFailedWith: matches action and code on a failed dispatch', () => {
    const bus = tap(createCommandBus());
    bus.register('ok', () => 1);
    bus.dispatch('ok', null);
    bus.dispatch('gone', null);
    expect(bus).toHaveFailedWith('gone', 'VC_CORE_NO_HANDLER');
    // A success never matches, whatever the code asked for.
    expect(bus).not.toHaveFailedWith('ok', 'VC_CORE_NO_HANDLER');
    expect(bus).not.toHaveFailedWith('gone', 'VC_CORE_SEALED');
    expect(failure(() => expect(bus).toHaveFailedWith('gone', 'VC_CORE_SEALED'))).toContain(
      'expected "gone" to have failed with VC_CORE_SEALED',
    );
    expect(failure(() => expect(bus).not.toHaveFailedWith('gone', 'VC_CORE_NO_HANDLER'))).toContain(
      'expected "gone" not to have failed with VC_CORE_NO_HANDLER',
    );
  });

  it('toSucceedWith: ok alone, ok with value, and a failure with its code in the message', () => {
    const bus = createCommandBus<Shop>();
    bus.register('cartAdd', (cmd) => cmd.payload.qty);
    const ok = bus.dispatch('cartAdd', { id: 1 }, { qty: 2 });
    expect(ok).toSucceedWith();
    expect(ok).toSucceedWith(2);
    expect(ok).not.toSucceedWith(3);
    expect(failure(() => expect(ok).toSucceedWith(3))).toContain('expected the dispatch to succeed with 3, and it succeeded with 2');

    const failed = bus.dispatch('cartClear', null);
    expect(failed).not.toSucceedWith();
    expect(failure(() => expect(failed).toSucceedWith())).toContain(
      'expected the dispatch to succeed, and it failed with VC_CORE_NO_HANDLER',
    );
    expect(failure(() => expect(ok).not.toSucceedWith())).toContain('expected the dispatch not to succeed');
  });

  it('toFailWith: matches the error code, and a success in the message', () => {
    const bus = createCommandBus();
    bus.register('ok', () => 7);
    const failed = bus.dispatch('gone', null);
    expect(failed).toFailWith('VC_CORE_NO_HANDLER');
    expect(failed).not.toFailWith('VC_CORE_SEALED');
    const ok = bus.dispatch('ok', null);
    expect(ok).not.toFailWith('VC_CORE_NO_HANDLER');
    expect(failure(() => expect(ok).toFailWith('VC_CORE_NO_HANDLER'))).toContain(
      'expected the dispatch to fail with VC_CORE_NO_HANDLER, and it succeeded with 7',
    );
    expect(failure(() => expect(failed).not.toFailWith('VC_CORE_NO_HANDLER'))).toContain(
      'expected the dispatch not to fail with VC_CORE_NO_HANDLER',
    );
  });

  it('result matchers refuse a value that is not a CommandResult, naming the await', async () => {
    const bus = createAsyncCommandBus();
    const pending = bus.dispatch('gone', null);
    for (const received of [pending, null, undefined, { ok: 'yes' }]) {
      const e = thrown(() => expect(received).toSucceedWith());
      expect(e).toBeInstanceOf(TypeError);
      expect(e.message).toContain('await the dispatch first');
      expect(thrown(() => expect(received).not.toFailWith('VC_UNKNOWN'))).toBeInstanceOf(TypeError);
    }
    await pending;
  });
});

describe('vc, the utilities in one object as vi holds Vitest\'s', () => {
  it('each member is the named export itself, not a wrapper', async () => {
    const pure = await import('../src/vitest-pure');
    expect(Object.keys(pure.vc).sort()).toEqual(['mcp', 'stubEnv', 'stubGlobal', 'tap']);
    expect(pure.vc.tap).toBe(pure.tap);
    expect(pure.vc.stubGlobal).toBe(pure.stubGlobal);
    expect(pure.vc.stubEnv).toBe(pure.stubEnv);
    expect(pure.vc.mcp).toBe(pure.mcpClient);
  });

  it('is re-exported by vapor-chamber/vitest', async () => {
    const auto = await import('../src/vitest');
    expect(auto.vc).toBe((await import('../src/vitest-pure')).vc);
  });
});

describe('C3 a failed test shows what it dispatched', () => {
  const failedTask = (message: string) => ({ result: { state: 'fail', errors: [{ message }] } });

  it("prints in full at Vitest's default truncateThreshold, and leaves the user's threshold as it was", () => {
    const before = chai.config.truncateThreshold;
    expect(before).toBe(40);
    tap(createCommandBus()).dispatch('cartAdd', { id: 1 }, { qty: 2 });
    const task = failedTask('x');
    _explainFailure(task, chai);
    expect(task.result.errors[0].message).toContain("{ action: 'cartAdd', target: { id: 1 }, payload: { qty: 2 }, ok: false, code: 'VC_CORE_NO_HANDLER' }");
    expect(chai.config.truncateThreshold).toBe(before);
  });

  it('the stack carries the same text, since reporters such as json read the stack', () => {
    tap(createCommandBus()).dispatch('a', null);
    const task = { result: { state: 'fail', errors: [{ message: 'expected 1 to be 2', stack: 'AssertionError: expected 1 to be 2\n    at t.test.ts:6:13' }] } };
    _explainFailure(task, chai);
    const [error] = task.result.errors;
    expect(error.stack).toBe(`AssertionError: ${error.message}\n    at t.test.ts:6:13`);
    expect(error.stack).toContain('Dispatched during this test:');
  });

  it('appends each dispatch of this test on the shared bus, named by the API that reaches it', () => {
    const bus = getCommandBus();
    bus.register('cartAdd', () => 3);
    bus.dispatch('cartAdd', { id: 1 }, { qty: 2 });
    bus.dispatch('cartRemove', { id: 1 });
    const task = failedTask('expected 1 to be 2');
    _explainFailure(task, chai);
    const [head, body] = task.result.errors[0].message.split('\n\nDispatched during this test:\n\n');
    expect(head).toBe('expected 1 to be 2');
    expect(body).toContain("  1st dispatch on getCommandBus():\n\n    { action: 'cartAdd', target: { id: 1 }, payload: { qty: 2 }, ok: true, value: 3 }");
    expect(body).toContain("  2nd dispatch on getCommandBus():\n\n    { action: 'cartRemove', target: { id: 1 }, ok: false, code: 'VC_CORE_NO_HANDLER' }");
    expect(body).toMatch(/Number of dispatches: 2$/);
  });

  it('names a bus from tap() by its place when several were dispatched on', () => {
    const one = tap(createCommandBus());
    const two = tap(createCommandBus());
    one.dispatch('a', null);
    two.dispatch('b', null);
    const task = failedTask('boom');
    _explainFailure(task, chai);
    expect(task.result.errors[0].message).toContain('1st dispatch on tap() bus 1 of 2:');
    expect(task.result.errors[0].message).toContain('1st dispatch on tap() bus 2 of 2:');
  });

  it('a thrown handler error without a code shows its message', () => {
    const bus = tap(createCommandBus());
    bus.register('a', () => {
      throw new Error('boom');
    });
    bus.dispatch('a', null);
    const task = failedTask('x');
    _explainFailure(task, chai);
    expect(task.result.errors[0].message).toContain("{ action: 'a', target: null, ok: false, error: 'boom' }");
  });

  it('a success with no value shows no value key', () => {
    const bus = tap(createCommandBus());
    bus.register('a', () => undefined);
    bus.dispatch('a', null);
    const task = failedTask('x');
    _explainFailure(task, chai);
    expect(task.result.errors[0].message).toContain("{ action: 'a', target: null, ok: true }");
  });

  it('adds nothing when the test passed, dispatched nothing, has no error, or already failed on a bus matcher', () => {
    const passed = { result: { state: 'pass', errors: [{ message: 'm' }] } };
    getCommandBus().dispatch('x', null);
    _explainFailure(passed, chai);
    expect(passed.result.errors[0].message).toBe('m');

    const noErrors = { result: { state: 'fail' } };
    expect(() => _explainFailure(noErrors, chai)).not.toThrow();

    const matcher = failedTask('expected "y" to be dispatched at least once\n\nNumber of dispatches: 1');
    _explainFailure(matcher, chai);
    expect(matcher.result.errors[0].message).toBe('expected "y" to be dispatched at least once\n\nNumber of dispatches: 1');

    _beginTest();
    const quiet = failedTask('q');
    _explainFailure(quiet, chai);
    expect(quiet.result.errors[0].message).toBe('q');
  });
});

describe('A12 pure is pure (in-repo half)', () => {
  it('the pure entry imports nothing at runtime', () => {
    const file = resolve(process.cwd(), 'src/vitest-pure.ts');
    const source = readFileSync(file, 'utf8');
    const runtime = ts.preProcessFile(source, true, true).importedFiles.map((f) => f.fileName);
    // preProcessFile lists type-only imports too; the only ones allowed are type imports.
    expect(runtime).toEqual(['./command-bus', './mcp']);
    expect(source).toMatch(/import type \{[^}]*\} from '\.\/command-bus';/);
    expect(source).toMatch(/import type \{[^}]*\} from '\.\/mcp';/);
  });
});
