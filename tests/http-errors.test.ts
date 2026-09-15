/**
 * Tests for src/http-errors.ts - classifyError
 */
import { describe, expect, it } from 'vitest';
import { classifyError, isRetryableStatus } from '../src/http-errors';
import * as root from '../src/index';

describe('isRetryableStatus', () => {
  it('408, 429 and every 5xx may be sent again', () => {
    for (const s of [408, 429, 500, 501, 502, 503, 504, 505, 599]) {
      expect(isRetryableStatus(s), String(s)).toBe(true);
    }
  });

  it('every other status is sent once', () => {
    for (const s of [200, 301, 400, 401, 403, 404, 409, 419, 422]) {
      expect(isRetryableStatus(s), String(s)).toBe(false);
    }
  });

  it('differs from classifyError on 408 and 429, on purpose', () => {
    // Retried, but not transient: serveStaleOnError does not serve stale data for them.
    for (const s of [408, 429]) {
      expect(isRetryableStatus(s)).toBe(true);
      expect(classifyError({ response: { status: s } }).transient).toBe(false);
    }
  });

  it('both rules are exported from the package root (README documents them)', () => {
    expect(root.classifyError).toBe(classifyError);
    expect(root.isRetryableStatus).toBe(isRetryableStatus);
  });
});

describe('classifyError', () => {
  it('timeout is transient', () => {
    expect(classifyError({ name: 'TimeoutError' }).transient).toBe(true);
  });

  it('no response (network failure) is transient', () => {
    expect(classifyError(new Error('network down')).transient).toBe(true);
  });

  it('5xx is transient', () => {
    expect(classifyError({ response: { status: 500 } }).transient).toBe(true);
    expect(classifyError({ response: { status: 503 } }).transient).toBe(true);
  });

  it('4xx is never transient', () => {
    expect(classifyError({ response: { status: 404 } }).transient).toBe(false);
    expect(classifyError({ response: { status: 422 } }).transient).toBe(false);
    expect(classifyError({ response: { status: 429 } }).transient).toBe(false);
  });

  it('2xx/3xx status present is not transient', () => {
    expect(classifyError({ response: { status: 200 } }).transient).toBe(false);
  });

  it('handles null/undefined input', () => {
    expect(classifyError(null).transient).toBe(true); // "no response" - treated as network failure
    expect(classifyError(undefined).transient).toBe(true);
  });
});
