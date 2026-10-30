// @vitest-environment happy-dom
/**
 * An inline routes element whose text is not JSON, or has no routes array, fails start() with a coded router error.
 * Why: a plain SyntaxError out of start() would reach onError with no code, so handlers that switch on the code would miss it.
 * Shows: start() rejects with router:unexpected:routes carrying the selector in the message and the SyntaxError as cause,
 * onError receives that same error, and JSON without a routes array gets the same code.
 * See: log s35.93
 */
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
    router.dispose();
  });

  it('control: JSON without a routes array is the same code', async () => {
    inline('{"base": "/admin"}');
    const { router } = build();
    const failure = await router.start().then(() => null, (error: unknown) => error);
    expect(isRouterError(failure, 'router:unexpected:routes')).toBe(true);
    router.dispose();
  });
});
