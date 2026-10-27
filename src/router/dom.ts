/**
 * vapor-chamber-router - the single DOM integration point.
 *
 * Delegated listeners on the document (and on each open shadow root an event
 * comes from) own everything link-shaped inside the base:
 *   . click interception (page.js checklist: shadow DOM via composedPath,
 *     download, rel=external, explicit target, cross-origin - which also
 *     excludes mailto:/tel: - modifier keys, `data-native` opt-out,
 *     `data-replace` for replaceState)
 *   . `data-active` / `data-exact-active` stamping on in-base anchors after
 *     each commit - Blade-rendered menus light up with zero Vue
 *   . hover and focus preheat (100ms intent delay, cancelled on leave or
 *     blur), the link found by the same composed-path scan as a click,
 *     between the links of a shadow root too
 *
 * Plus the idle preheater:
 * load event + requestIdleCallback, saveData/2g skip, abort on first user
 * interaction, errors swallowed.
 */

import { stripBase } from './history';
import { delayOption } from '../bounds';
import { pathActivity } from './url';

export type DomIntegrationOptions = {
  base: string;
  /** Can the router handle this base-relative path? Falls through to a
   *  normal full-page navigation when false. */
  canHandle: (path: string) => boolean;
  navigate: (fullPath: string, replace: boolean) => void;
  /** Warm the lazy component(s) behind a base-relative path (hover or focus intent). */
  preheat?: (path: string) => void;
  intentDelayMs?: number;
  /**
   * Called when the page is restored from the back/forward cache (`pageshow`
   * with `event.persisted`) - the JS heap and DOM were frozen, not torn down,
   * so nothing here re-runs on its own: active-link stamping reflects
   * whatever path was current when the page froze, and one-shot setup tied
   * to the original `load` event (idle preheat) never fires again. Left to
   * the caller to decide what "fresh" means (re-stamp, re-arm preheat,
   * `reload()`) rather than this module guessing at a data-freshness policy.
   */
  onRestore?: () => void;
};

/** `pathname`, `search` and `hash` are the parsed href's, for the same-page hash test. */
export type RoutableTarget = { path: string; fullPath: string; pathname: string; search: string; hash: string };

/**
 * routableMemo - one parse per anchor per href, not per commit.
 *
 * `stampActiveLinks` walks EVERY in-base anchor after EVERY navigation, and the
 * per-anchor work is dominated by `new URL()` plus `stripBase` - both of which
 * depend only on the href, which almost never changes. So the invariant parse
 * is hoisted out of the hot loop and something cheap is compared instead.
 *
 * The memo is **validated against the raw href it was derived from**, not merely
 * against the element's identity - a Blade menu can rewrite an anchor's `href`
 * in place, and a memo keyed only by element would then answer for the old URL.
 *
 * A `WeakMap` rather than an expando on the node: entries die with the anchor,
 * and this module never mutates DOM it does not own except through the
 * documented `data-active` attributes. That choice is measured, not assumed -
 * head-to-head against an expando (`a.__vcR`) the two are **0.98-1.02x**, i.e.
 * inside noise at every size tested, so the non-invasive one wins on no
 * measurable cost.
 *
 * `null` is cached too - a page's non-routable links (cross-origin, outside
 * base) are re-tested on every commit otherwise, and on a typical menu they are
 * a large share of the anchors.
 *
 * **Measured 1.77-1.86x per commit** (42 us saved at 50 anchors, 172 us at 200,
 * 828 us at 1000), `tests/router-stamp-ab.test.ts`, with the baseline arm
 * DERIVED from the shipped source: a variant written inside a test file is
 * optimised differently by V8 and inflates the ratio. Prefer the harness's
 * printed table over any figure copied into prose, including this one.
 */
const routableMemo = new WeakMap<HTMLAnchorElement, { href: string; target: RoutableTarget | null }>();

/** Resolve an anchor's href to a base-relative fullPath, or null when the
 *  link is not ours (cross-origin, outside base, not a plain string href). */
function routableTarget(anchor: HTMLAnchorElement, base: string): RoutableTarget | null {
  const href = anchor.href;
  if (typeof href !== 'string') return null;

  const memo = routableMemo.get(anchor);
  // `base` is fixed per router instance, so href alone settles validity.
  if (memo !== undefined && memo.href === href) return memo.target;

  const target = parseRoutable(href, base);
  routableMemo.set(anchor, { href, target });
  return target;
}

/** The uncached parse. Split out so the memo above wraps one expression. */
function parseRoutable(href: string, base: string): RoutableTarget | null {
  let url: URL;
  try {
    url = new URL(href, window.location.href);
  } catch {
    return null;
  }
  if (url.origin !== window.location.origin) return null;
  const path = stripBase(url.pathname, base);
  if (path === null) return null;
  return { path, fullPath: path + url.search + url.hash, pathname: url.pathname, search: url.search, hash: url.hash };
}

/** The user asked to save data (Save-Data), or the connection is 2G. False
 *  where the browser has no `navigator.connection` (Firefox, Safari). */
function savingData(): boolean {
  const connection = (navigator as { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  const type = connection?.effectiveType;
  return !!connection?.saveData || type === '2g' || type === 'slow-2g';
}

/**
 * The link an event is on: the first `<a>` with an href on its composed path
 * (`event.composedPath()`). The path crosses an open shadow root (page.js
 * scans it for this reason). A walk up from `event.target` cannot: at the
 * document, an event from inside a shadow root has the host as its target.
 * Every build target has composedPath (scripts/build.mjs: chrome100,
 * firefox100, safari16). Click, hover and focus read it
 * (tests/browser/router-shadow-hover.browser.test.ts).
 */
function anchorOf(path: EventTarget[]): HTMLAnchorElement | null {
  for (const node of path) {
    if ((node as Element).nodeName?.toUpperCase() === 'A' && (node as HTMLAnchorElement).href) return node as HTMLAnchorElement;
  }
  return null;
}

export function installDomIntegration(options: DomIntegrationOptions): () => void {
  const { base, canHandle, navigate, preheat, intentDelayMs: rawIntentDelayMs = 100, onRestore } = options;
  // setTimeout reads NaN as 0, so a bad delay fires the preheat immediately on
  // every hover or focus - the intent delay this option exists for, silently gone.
  const intentDelayMs = delayOption(rawIntentDelayMs, 100);
  // Every listener below, a shadow root's included, is added with this signal,
  // and teardown aborts it. So they come off, as `router.dispose()` promises,
  // and no list of roots is kept (tests/router/dom-shadow.test.ts).
  const controller = new AbortController();
  const listening = { signal: controller.signal };

  function onClick(event: MouseEvent): void {
    if (event.defaultPrevented) return;
    // Some synthetic events (element.click(), test DOMs) omit button; only a
    // real non-left button should bail.
    if (typeof event.button === 'number' && event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    const anchor = anchorOf(event.composedPath());
    if (!anchor) return;

    if (anchor.hasAttribute('download') || anchor.hasAttribute('data-native')) return;
    const rel = anchor.getAttribute('rel');
    if (rel && /\bexternal\b/i.test(rel)) return;
    const target = anchor.getAttribute('target');
    if (target && !/\b_self\b/i.test(target)) return;

    const routable = routableTarget(anchor, base);
    if (!routable) return;

    // In-page hash link on the same path -> browser default.
    if (routable.hash && routable.pathname === window.location.pathname && routable.search === window.location.search) return;
    if (!canHandle(routable.path)) return;

    event.preventDefault();
    navigate(routable.fullPath, anchor.hasAttribute('data-replace'));
  }

  // Built only when `preheat` was given, inside this branch, so the warm-up
  // needs no "no preheat" check (tests/router/dom.test.ts, hover preheat).
  let stopWarming: (() => void) | undefined;
  if (preheat) {
    const roots = new WeakSet<Node>();

    // A move between two nodes of one shadow root never reaches the document:
    // the dispatch stops at the host when the target and the related target
    // retarget to it (DOM Standard, dispatch steps 6.9.3 and 6.9.7). So every
    // open shadow root an event comes from gets these listeners too, each
    // unseen one out to the document, innermost first
    // (tests/browser/router-shadow-hover.browser.test.ts). The walk asks each
    // root's type: an app listener may remove the hovered node before this one
    // runs, and its root is then an element or a fragment. A shadow root's host
    // is never null (DOM Standard), and nothing else of type 11 has one
    // (tests/router/dom-shadow.test.ts). A root that already holds the pointer
    // or focus when the router starts is attached once it leaves and comes back.
    const warmable = (event: Event): HTMLAnchorElement | null => {
      const path = event.composedPath();
      for (
        let root = (path[0] as Node).getRootNode();
        root.nodeType === 11 && (root as ShadowRoot).host && !roots.has(root);
        root = (root as ShadowRoot).host.getRootNode()
      ) {
        roots.add(root);
        listen(root);
      }
      // The click asks whether the router handles a link in place. The warm-up
      // asks whether a page of the app will use this code. So a `_blank` or
      // `rel="external"` link warms, and a `download` link, which opens no
      // page, does not (tests/router/preheat-gate.test.ts).
      const anchor = anchorOf(path);
      return anchor && !anchor.hasAttribute('data-native') && !anchor.hasAttribute('download') ? anchor : null;
    };

    // One timer per intent, built once: an arm resets it, a leave clears it.
    // Pointer and focus each get their own: with one, the mouse leaving a link
    // would cancel the warm-up a focused link armed
    // (tests/router/preheat-gate.test.ts). The pointer's timer keeps the link
    // that armed it until it fires or is cleared. A move onto an icon inside
    // that link fires `mouseout` and `mouseover` with a `relatedTarget` inside
    // the link, and neither restarts the delay
    // (tests/router/preheat-inside-link.test.ts). The focus timer ignores it.
    const intent = (pointer: boolean): [arm: (event: Event) => void, cancel: (event?: Event) => void] => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let link: Node | null = null;
      // Teardown cancels with no event.
      const inside = (event?: Event): boolean =>
        pointer && link !== null && event !== undefined && link.contains((event as MouseEvent).relatedTarget as Node | null);
      return [
        (event) => {
          if (inside(event)) return;
          const anchor = warmable(event);
          // Which link only. Whether the user saves data and whether a route
          // matches are read when the timer fires, the route against the table
          // of that moment (`preheat` resolves it). So most arms, swept past and
          // cancelled, never match a route (tests/router/index-gaps.test.ts,
          // preheat racing a table swap, and tests/router/preheat-gate.test.ts).
          const routable = anchor && routableTarget(anchor, base);
          if (!routable) return;
          clearTimeout(timer);
          link = anchor;
          timer = setTimeout(() => {
            link = null;
            savingData() || preheat(routable.path);
          }, intentDelayMs);
        },
        (event) => {
          if (inside(event)) return;
          clearTimeout(timer);
          link = null;
        },
      ];
    };
    const [pointerArm, pointerCancel] = intent(true);
    const [focusArm, focusCancel] = intent(false);

    const listen = (target: EventTarget): void => {
      target.addEventListener('mouseover', pointerArm, listening);
      target.addEventListener('mouseout', pointerCancel, listening);
      target.addEventListener('focusin', focusArm, listening);
      target.addEventListener('focusout', focusCancel, listening);
    };
    listen(document);
    stopWarming = () => {
      pointerCancel();
      focusCancel();
    };
  }

  function onPageshow(event: PageTransitionEvent): void {
    if (event.persisted) onRestore?.();
  }

  document.addEventListener('click', onClick, listening);
  if (onRestore) window.addEventListener('pageshow', onPageshow, listening);
  return () => {
    controller.abort();
    stopWarming?.();
  };
}

/**
 * Remove `aria-current` only when it is the `"page"` this module sets: a value
 * the page chose for another purpose (`"step"`, `"location"`) is not ours.
 */
function releaseCurrentPage(anchor: Element): void {
  if (anchor.getAttribute('aria-current') === 'page') anchor.removeAttribute('aria-current');
}

/**
 * Stamp `data-active` (prefix match) / `data-exact-active` (same path,
 * trailing-slash tolerant) on every in-base anchor. Call after each commit.
 *
 * The exact match also gets `aria-current="page"`, which is what a screen
 * reader announces as "current page" (WAI-ARIA 1.2). Only the exact match: a
 * section link that is merely a prefix match is active for styling, not the
 * page, and ARIA asks for one current element per set.
 */
export function stampActiveLinks(base: string, currentPath: string, root: ParentNode = document): void {
  for (const anchor of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const routable = routableTarget(anchor, base);
    if (!routable) {
      anchor.removeAttribute('data-active');
      anchor.removeAttribute('data-exact-active');
      releaseCurrentPage(anchor);
      continue;
    }
    const { active, exact } = pathActivity(routable.path, currentPath);
    anchor.toggleAttribute('data-active', active);
    anchor.toggleAttribute('data-exact-active', exact);
    if (exact) anchor.setAttribute('aria-current', 'page');
    else releaseCurrentPage(anchor);
  }
}

export type IdlePreheatOptions = {
  /** ms between successive loads. Default 200. */
  gap?: number;
  /** ms ceiling for the idle wait. Default 4000. */
  idleTimeout?: number;
};

/**
 * Idle-time preheating of lazy chunks: waits
 * for the load event + requestIdleCallback, skips on saveData/2g, aborts all
 * remaining loads on the first real user interaction, swallows errors.
 * One-shot per call; returns a cancel function.
 */
export function preheatIdle(factories: ReadonlyArray<() => Promise<unknown>>, options: IdlePreheatOptions = {}): () => void {
  const { gap: rawGap = 200, idleTimeout: rawIdleTimeout = 4000 } = options;
  const gap = delayOption(rawGap, 200);
  const idleTimeout = delayOption(rawIdleTimeout, 4000);
  if (typeof window === 'undefined' || factories.length === 0) return () => {};
  if (savingData()) return () => {};

  let aborted = false;
  const abortEvents = ['scroll', 'click', 'keydown', 'pointerdown'] as const;
  // `{ once: true }` removes only the listener that actually FIRES, so the
  // returned canceller detaches the rest itself: otherwise a visitor who never
  // scrolls or clicks keeps four listeners for the life of the page, one more
  // set per bfcache restore (the router re-arms this in `armIdlePreheat`).
  const abort = () => {
    aborted = true;
    for (const ev of abortEvents) window.removeEventListener(ev, abort);
  };
  for (const ev of abortEvents) window.addEventListener(ev, abort, { once: true, passive: true });

  const run = async () => {
    for (const factory of factories) {
      if (aborted) break;
      try {
        await factory();
      } catch {
        /* preheat is best-effort */
      }
      if (aborted) break;
      await new Promise((resolve) => setTimeout(resolve, gap));
    }
  };

  const start = () => {
    if ('requestIdleCallback' in window) {
      (window as Window & { requestIdleCallback: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback(
        () => void run(),
        { timeout: idleTimeout },
      );
    } else {
      setTimeout(() => void run(), 2500); // Safari fallback
    }
  };

  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });

  return abort;
}
