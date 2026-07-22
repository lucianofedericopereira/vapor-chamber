/**
 * Tests for src/http-errors.ts — classifyError
 */
import { describe, expect, it } from 'vitest';
import { classifyError } from '../src/http-errors';

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
    expect(classifyError(null).transient).toBe(true); // "no response" — treated as network failure
    expect(classifyError(undefined).transient).toBe(true);
  });
});
