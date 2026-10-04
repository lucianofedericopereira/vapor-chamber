// @vitest-environment happy-dom
/** An inline routes element that is not JSON fails start() with a coded router error. The long note is at the end. */
import { afterEach, describe, expect, it } from 'vitest';
import { isRouterError } from '@router/errors';
import { makeRouter } from './fixture';

afterEach(() => {
  document.body.innerHTML = '';
});

function inline(text: string) {
  const el = document.createElement('script');
  el.id = 'vcr-routes';
  el.type = 'application/json';
  el.textContent = text;
  document.body.appendChild(el);
}

function build() {
  const errors: unknown[] = [];
  const router = makeRouter({
    routes: { inline: '#vcr-routes' },
    links: false,
    announce: false,
    onError: (error) => errors.push(error),
  });
  return { router, errors };
}

describe('inline routes that are not JSON', () => {
  it('start() rejects with router:unexpected:routes, the parse error as its cause', async () => {
    inline('{"routes": [');
    const { router, errors } = build();
    const failure = await router.start().then(() => null, (error: unknown) => error);
    expect(isRouterError(failure, 'router:unexpected:routes')).toBe(true);
    expect((failure as Error).message).toContain('#vcr-routes');
    expect((failure as Error).cause).toBeInstanceOf(SyntaxError);
    expect(errors).toEqual([failure]);
    router.destroy();
  });

  it('control: JSON without a routes array is the same code', async () => {
    inline('{"base": "/admin"}');
    const { router } = build();
    const failure = await router.start().then(() => null, (error: unknown) => error);
    expect(isRouterError(failure, 'router:unexpected:routes')).toBe(true);
    router.destroy();
  });
});

/*
 * Router re-review, 1.26 (log 35.93). `readInlinePayload` (the constructor's
 * synchronous read, for `base`) is total by design and says why: "a missing
 * element, malformed JSON or a non-DOM environment all return null and leave
 * the real diagnosis to `loadInlineTable()` during start(), which throws a
 * coded router error". For malformed JSON it did not: `JSON.parse` threw a
 * plain SyntaxError out of start() and into onError, the one inline failure
 * with no code (a missing element is `inline_routes_missing`, JSON without a
 * routes array `invalid_routes_payload`). The parse is the router reading its
 * own input, not someone else's error passing through (shape rule 2), so it is
 * coded as the payload being invalid, with the SyntaxError as its cause.
 */
