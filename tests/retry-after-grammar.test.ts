/**
 * _parseRetryAfter reads Retry-After by RFC 9110's grammar: delay-seconds (1*DIGIT) or an HTTP-date.
 * Why: if the header were read with `Number()`, `-5`, `1.5`, `1e1`, `0x10` or `+3` would become waits, and a negative or zero wait turns a 503 with a bad header into a request storm. If dates went through `Date.parse`, an asctime-date (no zone) would be read as local time and non-HTTP-date forms would be accepted.
 * Shows: digits-only seconds and the three GMT date forms are read (whatever the local zone); signs, fractions, exponents, hex, whitespace, Infinity and dates in other forms give undefined; a two-digit rfc850 year is its next occurrence, across a century.
 * See: RFC 9110 5.6.7, RFC 9110 10.2.3, log s35.41, log s35.100
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { _parseRetryAfter } from '../src/http';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('Retry-After by RFC 9110', () => {
  it('control: delay-seconds (1*DIGIT) and an HTTP-date are read', () => {
    vi.useFakeTimers({ now: Date.parse('Wed, 01 Oct 2026 12:00:00 GMT') });
    expect(_parseRetryAfter('0')).toBe(0);
    expect(_parseRetryAfter('1')).toBe(1000);
    expect(_parseRetryAfter('007')).toBe(7000);
    expect(_parseRetryAfter('30')).toBe(30_000);
    expect(_parseRetryAfter('Wed, 01 Oct 2026 12:00:10 GMT')).toBe(10_000);
  });

  it('anything else is ignored: sign, fraction, exponent, hex, whitespace, Infinity', () => {
    for (const value of ['-5', '-0', '+3', '1.5', '0.001', '1e1', '0x10', '0b1', ' 2 ', '2 ', 'Infinity', 'NaN', '1_000']) {
      expect([value, _parseRetryAfter(value)]).toEqual([value, undefined]);
    }
  });

  it('the three HTTP-date forms are GMT, whatever the local zone (RFC 9110 5.6.7)', () => {
    vi.stubEnv('TZ', 'America/Argentina/Buenos_Aires'); // UTC-3
    vi.useFakeTimers({ now: Date.parse('Wed, 01 Oct 2026 12:00:00 GMT') });
    expect(_parseRetryAfter('Wed, 01 Oct 2026 12:00:10 GMT')).toBe(10_000); // IMF-fixdate
    expect(_parseRetryAfter('Wednesday, 01-Oct-26 12:00:10 GMT')).toBe(10_000); // rfc850-date
    expect(_parseRetryAfter('Wed Oct  1 12:00:10 2026')).toBe(10_000); // asctime-date
    expect(_parseRetryAfter('Thu Oct 22 12:00:00 2026')).toBe(21 * 86_400_000); // two-digit day
  });

  it('an rfc850 two-digit year is its next occurrence, across a century too', () => {
    vi.useFakeTimers({ now: Date.parse('Thu, 31 Dec 2099 23:59:50 GMT') });
    expect(_parseRetryAfter('Friday, 01-Jan-00 00:00:00 GMT')).toBe(10_000);
  });

  it('a date in no HTTP-date form is ignored', () => {
    vi.useFakeTimers({ now: Date.parse('Wed, 01 Oct 2026 12:00:00 GMT') });
    for (const value of [
      '2026-10-01T12:00:10Z', '10/1/2026 12:00:10', 'Oct 1 2026 12:00:10',
      'Wed, 01 Oct 2026 12:00:10 +0000', 'wed, 01 oct 2026 12:00:10 gmt', 'Wed, 1 Oct 2026 12:00:10 GMT',
      'Wed, 01 Xyz 2026 12:00:10 GMT', 'Foo, 01 Oct 2026 12:00:10 GMT', 'Wed Oct 1 12:00:10 2026',
    ]) {
      expect([value, _parseRetryAfter(value)]).toEqual([value, undefined]);
    }
  });
});
