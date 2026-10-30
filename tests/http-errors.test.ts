/**
 * The failure rules in src/http-errors.ts: classifyError, isRetryableStatus and the status table.
 * Why: a wrong rule would retry a request that must be sent once, or serve stale data for a failure that is not transient.
 * Shows: each status maps to its declared condition; 408, 429 and every 5xx are retryable, other statuses are not; classifyError marks timeouts, lost replies, 5xx and non-client errors transient, and 4xx and aborts not; both rules are exported from the package root.
 * See: log s35.131, docs/contract.md, docs/manual/04-backend.md
 */
import { describe, expect, it } from 'vitest';
import { classifyError, isRetryableStatus } from '../src/http-errors';
import { conditionOfStatus } from '../src/command-bus';
import { _failures } from '../src/failure';
import { _answered } from '../src/http';

// The client's own failures, as it throws them.
const answered = (status: number) => _answered(status, null, {});
const transport = _failures('transport');
import * as root from '../src/index';

describe('the status table (docs/contract.md 4)', () => {
  it('each status declares the condition RFC 9110 gives it', () => {
    const table: Array<[number, string]> = [
      [404, 'missing'], [410, 'missing'], [409, 'conflict'], [412, 'conflict'],
      [401, 'unauthenticated'], [419, 'unauthenticated'], [403, 'refused'],
      [429, 'limited'], [503, 'limited'], [408, 'timeout'], [504, 'timeout'],
      [501, 'unexpected'], [502, 'unexpected'], [505, 'unexpected'],
      [500, 'failed'], [599, 'failed'], [400, 'invalid'], [422, 'invalid'], [413, 'invalid'],
    ];
    for (const [status, condition] of table) expect(conditionOfStatus(status), String(status)).toBe(condition);
  });
});

describe('isRetryableStatus', () => {
  it('408, 429 and every 5xx may be sent again (the AWS SDK and .NET defaults)', () => {
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
      expect(classifyError(answered(s)).transient).toBe(false);
    }
  });

  it('both rules are exported from the package root (manual chapter 4, "How a failure is judged")', () => {
    expect(root.classifyError).toBe(classifyError);
    expect(root.isRetryableStatus).toBe(isRetryableStatus);
  });
});

describe('classifyError', () => {
  it('a timeout is transient', () => {
    expect(classifyError(transport('timeout:reply', 't')).transient).toBe(true);
  });

  it('no response (network failure) is transient', () => {
    expect(classifyError(transport('lost:reply', 'l')).transient).toBe(true);
  });

  it('5xx is transient', () => {
    expect(classifyError(answered(500)).transient).toBe(true);
    expect(classifyError(answered(503)).transient).toBe(true);
  });

  it('4xx is never transient, nor an abort', () => {
    expect(classifyError(answered(404)).transient).toBe(false);
    expect(classifyError(answered(422)).transient).toBe(false);
    expect(classifyError(answered(429)).transient).toBe(false);
    expect(classifyError(transport('aborted:request', 'a')).transient).toBe(false);
  });

  it('anything that is not the client failure reads as no response', () => {
    expect(classifyError(null).transient).toBe(true);
    expect(classifyError(undefined).transient).toBe(true);
    expect(classifyError(new Error('network down')).transient).toBe(true);
  });
});
