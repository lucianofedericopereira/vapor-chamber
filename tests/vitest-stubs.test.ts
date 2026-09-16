// @vitest-environment happy-dom
/**
 * `stubGlobal` and `stubEnv` from `vapor-chamber/vitest/pure`: stubs that
 * `using` restores at the end of the block (plan 11.4, C0).
 *
 * Vitest's own `vi.stubGlobal` / `vi.stubEnv` return nothing disposable, and
 * its `unstubGlobals` / `unstubEnvs` restore at the START of the next test,
 * after the current test's after-hooks (plan 9.5). A stub an `afterEach`
 * depends on has to be gone before that hook runs, and `using` is the moment.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { stubEnv, stubGlobal } from '../src/vitest-pure';

describe('stubGlobal', () => {
  it('using restores an existing global exactly, descriptor included, at the end of the block', () => {
    const getter = () => 'real';
    Object.defineProperty(globalThis, '__c0Getter', { get: getter, configurable: true, enumerable: false });
    try {
      {
        using _stub = stubGlobal('__c0Getter', 'stubbed');
        expect((globalThis as any).__c0Getter).toBe('stubbed');
      }
      expect(Object.getOwnPropertyDescriptor(globalThis, '__c0Getter')).toEqual({
        get: getter,
        set: undefined,
        configurable: true,
        enumerable: false,
      });
    } finally {
      Reflect.deleteProperty(globalThis, '__c0Getter');
    }
  });

  it('a name that was absent is deleted again, not left as undefined', () => {
    {
      using _stub = stubGlobal('__c0Absent', 1);
      expect((globalThis as any).__c0Absent).toBe(1);
    }
    expect(Object.hasOwn(globalThis, '__c0Absent')).toBe(false);
  });

  it('the stub is defined the way vi.stubGlobal defines it: writable, configurable, enumerable', () => {
    using _stub = stubGlobal('__c0Shape', 'x');
    expect(Object.getOwnPropertyDescriptor(globalThis, '__c0Shape')).toEqual({
      value: 'x',
      writable: true,
      configurable: true,
      enumerable: true,
    });
  });

  it('nested stubs of one name unwind in order', () => {
    {
      using _outer = stubGlobal('__c0Nested', 'outer');
      {
        using _inner = stubGlobal('__c0Nested', 'inner');
        expect((globalThis as any).__c0Nested).toBe('inner');
      }
      expect((globalThis as any).__c0Nested).toBe('outer');
    }
    expect(Object.hasOwn(globalThis, '__c0Nested')).toBe(false);
  });

  it('disposing twice restores once: the second call does nothing', () => {
    const stub = stubGlobal('__c0Twice', 1);
    stub[Symbol.dispose]();
    (globalThis as any).__c0Twice = 'written between the calls';
    stub[Symbol.dispose]();
    expect((globalThis as any).__c0Twice).toBe('written between the calls');
    Reflect.deleteProperty(globalThis, '__c0Twice');
  });

  it('a throw inside the block still restores', () => {
    const real = globalThis.document;
    expect(() => {
      using _stub = stubGlobal('document', undefined);
      throw new Error('boom');
    }).toThrow('boom');
    expect(globalThis.document).toBe(real);
  });
});

describe('the discriminating probe: an afterEach that needs the real document (owner, 11.4)', () => {
  const seen: string[] = [];
  afterEach(() => {
    try {
      document.body.innerHTML = '';
      seen.push('real document');
    } catch (e) {
      seen.push(String((e as Error).message));
    }
  });

  it('a stub made with using is gone before afterEach runs', () => {
    using _stub = stubGlobal('document', undefined);
    expect(globalThis.document).toBeUndefined();
  });

  it('every afterEach so far saw the real document', () => {
    expect(seen).toEqual(['real document']);
  });
});

describe('stubEnv', () => {
  it('using restores a set variable, and deletes one that was absent', () => {
    const before = process.env.NODE_ENV;
    {
      using _mode = stubEnv('NODE_ENV', 'production');
      using _extra = stubEnv('VC_C0_ABSENT', 'yes');
      expect(process.env.NODE_ENV).toBe('production');
      expect(import.meta.env.NODE_ENV).toBe('production');
      expect(process.env.VC_C0_ABSENT).toBe('yes');
    }
    expect(process.env.NODE_ENV).toBe(before);
    expect(Object.hasOwn(process.env, 'VC_C0_ABSENT')).toBe(false);
  });

  it('undefined unsets for the block, as vi.stubEnv does', () => {
    using _set = stubEnv('VC_C0_UNSET', 'x');
    {
      using _unset = stubEnv('VC_C0_UNSET', undefined);
      expect(Object.hasOwn(process.env, 'VC_C0_UNSET')).toBe(false);
    }
    expect(process.env.VC_C0_UNSET).toBe('x');
  });

  it('DEV, PROD and SSR take booleans and are stored as "1" or "", as vi.stubEnv stores them', () => {
    using _dev = stubEnv('DEV', false);
    using _prod = stubEnv('PROD', true);
    expect(process.env.DEV).toBe('');
    expect(process.env.PROD).toBe('1');
    expect(import.meta.env.PROD).toBe(true);
  });
});

describe('a stub made without using is restored at the start of the next test', () => {
  it('first test: stubs and does not restore', () => {
    stubGlobal('__c0Leftover', 'left');
    stubEnv('VC_C0_LEFTOVER', 'left');
    stubGlobal('__c0Leftover', 'left twice');
  });

  it('second test: both are gone, in reverse order, before the test body', () => {
    expect(Object.hasOwn(globalThis, '__c0Leftover')).toBe(false);
    expect(Object.hasOwn(process.env, 'VC_C0_LEFTOVER')).toBe(false);
  });

  it('a stub disposed with using is not restored a second time: first test', () => {
    Object.defineProperty(globalThis, '__c0Once', { value: 'real', configurable: true, writable: true });
    {
      using _stub = stubGlobal('__c0Once', 'stubbed');
    }
    // A second restore at the next test start would put 'real' back over this.
    (globalThis as any).__c0Once = 'written after the block';
  });

  it('a stub disposed with using is not restored a second time: the write survived the next test start', () => {
    expect((globalThis as any).__c0Once).toBe('written after the block');
    Reflect.deleteProperty(globalThis, '__c0Once');
  });
});
