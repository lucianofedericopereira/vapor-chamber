/**
 * Tier-1 branch mop-up - cheap, pure-logic branches reachable with plain calls
 * (no fetch/WS/storage mocks). Targets the leftover ternary/condition sides in
 * retryDelay, buildFullUrl, validateFields, and the Standard Schema validator.
 */
import { describe, expect, vi, afterEach } from 'vitest';
import { createAsyncCommandBus } from '../src/command-bus';
import { retry } from '../src/plugins-io';
import { buildFullUrl } from '../src/http-query';
import { schemaValidator } from '../src/schema';
import { validateSchemasAsync, type StandardSchemaV1 } from '../src/plugins-schema';
import { it } from '../src/vitest';

afterEach(() => { vi.useRealTimers(); });

// ── plugins-io: retryDelay 'linear' + missing-error fallback ──────────────────
describe('branch mop-up - retry plugin', () => {
  it("retries with the 'linear' backoff strategy", async () => {
    vi.useFakeTimers();
    const bus = createAsyncCommandBus();
    let calls = 0;
    bus.use(retry({ maxAttempts: 2, strategy: 'linear', baseDelay: 10 })); // plugins-io.ts:37
    bus.register('flaky', async () => { calls++; throw new Error('boom'); });

    const promise = bus.dispatch('flaky', {});
    await vi.advanceTimersByTimeAsync(50); // past the linear delay (base * attempt)
    const result = await promise;

    expect(result.ok).toBe(false);
    expect(calls).toBe(2); // retried once -> the linear delay ran between attempts
  });

  it('falls back to a generic error when a failed result carries no error field', async ({ asyncBus: bus }) => {
    bus.use(retry({ maxAttempts: 1 }), { priority: 10 });
    // Inner plugin returns a failed result WITHOUT an `error`, so retry hits
    // `lastResult.error ?? new Error('Unknown error')` (plugins-io.ts:67).
    // eslint-disable-next-line -- a result with no `error` is the point; see below
    bus.use(((_cmd: unknown, _next: unknown) => ({ ok: false })) as never, { priority: 1 });
    bus.register('x', async () => 'unused');

    const result = await bus.dispatch('x', {});
    expect(result.ok).toBe(false);
  });
});

// ── http-query: buildFullUrl baseURL join branches ────────────────────────────
describe('branch mop-up - buildFullUrl', () => {
  it('strips a trailing slash on baseURL and adds a missing leading slash on the path', () => {
    expect(buildFullUrl('users', 'http://api.test/')).toBe('http://api.test/users'); // trailing-slash strip
    expect(buildFullUrl('/users', 'http://api.test')).toBe('http://api.test/users'); // path already absolute
    expect(buildFullUrl('users', 'http://api.test')).toBe('http://api.test/users');  // both joined
  });

  it('leaves an absolute URL untouched by baseURL', () => {
    expect(buildFullUrl('http://other.test/x', 'http://api.test')).toBe('http://other.test/x');
  });

  // "absolute" was decided by startsWith('http'), which is also true of a
  // RELATIVE path whose first segment happens to begin with those four
  // letters. Two different failures fell out of the same test, and the second
  // one is the loud half of a bug whose quiet half is worse.
  it('treats a relative path beginning with "http" as relative, not absolute', () => {
    expect(buildFullUrl('httpbin/get', 'https://api.test')).toBe('https://api.test/httpbin/get');
    expect(buildFullUrl('http-logs', 'https://api.test')).toBe('https://api.test/http-logs');
  });

  it('joins the baseURL before parsing, so such a path does not blow up on params', () => {
    expect(buildFullUrl('httpbin/get', 'https://api.test', { q: 1 }))
      .toBe('https://api.test/httpbin/get?q=1');
  });

  // startsWith is case-sensitive; the URL scheme is not.
  it('recognises an upper-case scheme as absolute', () => {
    expect(buildFullUrl('HTTPS://other.test/x', 'https://api.test')).toBe('HTTPS://other.test/x');
    expect(buildFullUrl('HTTP://other.test/x', 'https://api.test', { q: 1 }))
      .toBe('http://other.test/x?q=1');
  });
});

// ── schema: validateFields 'any' + 'array' branches via schemaValidator ───────
describe('branch mop-up - schemaValidator field validation', () => {
  it("skips 'any' fields and flags an 'array' field given a non-array", ({ bus }) => {
    bus.register('save', () => 'ok');
    bus.use(schemaValidator({ save: { target: { tags: 'array', meta: 'any' } } }));

    const bad = bus.dispatch('save', { tags: 'not-an-array', meta: 123 });
    expect(bad.ok).toBe(false);
    expect(bad.error?.message).toContain('tags: expected array');

    const good = bus.dispatch('save', { tags: ['a'], meta: { anything: true } });
    expect(good.ok).toBe(true);
  });
});

// ── plugins-schema: pickValue field options + describe() object paths + passthrough ─
function passing(): StandardSchemaV1 {
  return { '~standard': { version: 1, vendor: 'fake', validate: (value) => ({ value }) } };
}
function failingObjectPath(): StandardSchemaV1 {
  return {
    '~standard': {
      version: 1,
      vendor: 'fake',
      // Path mixes an object segment ({ key }) and a primitive - covers both
      // sides of describe()'s path mapping (plugins-schema.ts:99).
      validate: () => ({ issues: [{ message: 'bad', path: [{ key: 'field' }, 'sub'] }] }),
    },
  };
}

describe('branch mop-up - Standard Schema validator', () => {
  it("pickValue handles field: 'payload' and field: 'both'", async () => {
    const busP = createAsyncCommandBus();
    busP.register('a', async () => 'ok');
    busP.use(validateSchemasAsync({ a: passing() }, { field: 'payload' }));
    expect((await busP.dispatch('a', { t: 1 }, { p: 2 })).ok).toBe(true);

    const busB = createAsyncCommandBus();
    busB.register('a', async () => 'ok');
    busB.use(validateSchemasAsync({ a: passing() }, { field: 'both' }));
    expect((await busB.dispatch('a', { t: 1 }, { p: 2 })).ok).toBe(true);
  });

  it('renders object-keyed issue paths in the error message', async ({ asyncBus: bus }) => {
    bus.register('a', async () => 'ok');
    bus.use(validateSchemasAsync({ a: failingObjectPath() }));
    const r = await bus.dispatch('a', { x: 1 });
    expect(r).toFailWith('VC_VALIDATION_FAILED');
    expect(r.error?.message).toContain('field.sub');
  });

  it('passes through actions that have no schema in the map', async ({ asyncBus: bus }) => {
    bus.register('other', async () => 'o');
    bus.use(validateSchemasAsync({ known: passing() }));
    const r = await bus.dispatch('other', {});
    expect(r).toSucceedWith('o');
  });
});
