/** Retry-After is read by RFC 9110's grammar: delay-seconds or an HTTP-date. The long note is at the end. */
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

/*
 * Found by the 1.26 evaluation (external item 6, log s35.41). The parser read
 * the header with `Number()`, which accepts far more than RFC 9110 section
 * 10.2.3 allows: `delay-seconds = 1*DIGIT`. `-5` became a wait of -5,000 ms,
 * `1.5` 1,500, `1e1` 10,000, `0x10` 16,000, `+3` 3,000. A negative or zero
 * wait is how a 503 with a bad header turned into a request storm in the
 * outbox. The seconds branch now takes digits only; everything else goes to
 * the HTTP-date branch, where none of those is one of its three shapes. A
 * value fetch hands over has no surrounding whitespace (the Fetch
 * standard strips it), so a digit-only test of the raw value is the grammar.
 *
 * The HTTP-date branch (log s35.100). It was
 * `Date.parse`, which reads an asctime-date (no zone) as LOCAL time - 3 h late
 * on a UTC-3 machine - and takes any form it knows: ISO, `10/1/2026`, a
 * numeric offset, lowercase names, a made-up weekday. RFC 9110 5.6.7: an
 * HTTP-date is IMF-fixdate, or the obsolete rfc850-date or asctime-date a
 * recipient MUST still accept, all three GMT. The branch now takes those
 * three shapes only and computes the time in GMT itself. A two-digit year is
 * its next occurrence: the RFC's 50-year rule only moves a year into the
 * past, which no wait reads, and `Date.parse`'s own rule read `00` sent late
 * in 2099 as 2000.
 */
