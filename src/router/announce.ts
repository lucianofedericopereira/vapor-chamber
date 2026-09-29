/**
 * vapor-chamber/router - tell assistive technology that the page changed.
 *
 * A full page load does two things a client-side navigation does not: a screen
 * reader announces the new page, and focus starts again from the top. Without
 * them a keyboard or screen-reader user is left on the link they pressed (or on
 * <body>, when the old page took that link with it) and is told nothing.
 *
 * Two sources set the rules (tests/router/announce.test.ts pins each):
 *   - Next.js announces every client-side navigation in an assertive live
 *     region, reading `document.title`, then the first `<h1>`, then the path.
 *   - Gatsby's user testing with disabled users (Marcy Sutton, Fable Tech Labs,
 *     2019): focus on a SMALL element (a heading, a skip link) served best; on a
 *     large wrapper it broke magnification, and a live region alone did not
 *     help magnification users.
 * So announcing is on by default (it is invisible and only adds), and moving
 * focus is an option naming an element THE APP provides, since it changes what
 * a sighted keyboard user sees.
 *
 * Not announced: the initial load (the browser already read the page), and a
 * query-only change (sorting or paging is not a new page). Read one frame after
 * the commit, so the new view and any title it sets are in place.
 */
import { announce as speak } from '../a11y';
import type { AfterEachHook, RouteLocation } from './types';

export type AnnounceOption = boolean | ((to: RouteLocation) => string | null | undefined);

export type RouteAnnouncerOptions = {
  announce?: AnnounceOption;
  /** CSS selector of the element to focus after each client-side navigation. */
  focusOnNavigate?: string;
};

function pageName(to: RouteLocation): string {
  const title = document.title.trim();
  if (title) return title;
  const h1 = document.querySelector('h1')?.textContent?.trim();
  return h1 || to.path;
}

/**
 * Install on a router's `afterEach`. Returns the teardown. The live region is
 * the document's shared one (src/a11y.ts), not the router's, so it outlives the
 * router. A no-op outside a browser.
 */
export function installRouteAnnouncer(
  afterEach: (hook: AfterEachHook) => () => void,
  options: RouteAnnouncerOptions,
): () => void {
  const { announce = true, focusOnNavigate } = options;
  if (typeof document === 'undefined' || (announce === false && !focusOnNavigate)) return () => {};

  let first = true;
  let frame = 0;

  // A query-only change never reaches here: the engine's afterEach fires only
  // after a committed PATH navigation (engine.ts), so paging or sorting is
  // not announced without a check of this module's own.
  const off = afterEach((to) => {
    if (first) {
      first = false;
      return;
    }
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (announce !== false) {
        const text = typeof announce === 'function' ? announce(to) : pageName(to);
        if (text) speak(text, { assertive: true });
      }
      if (focusOnNavigate) {
        const target = document.querySelector<HTMLElement>(focusOnNavigate);
        if (target) {
          // The platform knows what is focusable: anything that is not reports
          // tabIndex -1 with no attribute (a heading); links, buttons, summary,
          // editable content report 0. No hand-kept selector list.
          if (target.tabIndex < 0 && !target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
          target.focus({ preventScroll: true });
        }
      }
    });
  });

  return () => {
    off();
    cancelAnimationFrame(frame);
  };
}
