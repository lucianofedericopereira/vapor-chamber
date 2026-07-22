/**
 * vapor-chamber-router — the single DOM integration point.
 *
 * One delegated listener pair owns everything link-shaped inside the base:
 *   · click interception (page.js checklist: shadow DOM via composedPath,
 *     download, rel=external, explicit target, cross-origin — which also
 *     excludes mailto:/tel: — modifier keys, `data-native` opt-out,
 *     `data-replace` for replaceState)
 *   · `data-active` / `data-exact-active` stamping on in-base anchors after
 *     each commit — Blade-rendered menus light up with zero Vue
 *   · hover preheat (100ms intent delay, cancelled on leave)
 *
 * Plus the idle preheater:
 * load event + requestIdleCallback, saveData/2g skip, abort on first user
 * interaction, errors swallowed.
 */

import { stripBase } from './history';
import { pathActivity } from './url';

export type DomIntegrationOptions = {
  base: string;
  /** Can the router handle this base-relative path? Falls through to a
   *  normal full-page navigation when false. */
  canHandle: (path: string) => boolean;
  navigate: (fullPath: string, replace: boolean) => void;
  /** Warm the lazy component(s) behind a base-relative path (hover intent). */
  preheat?: (path: string) => void;
  hoverDelayMs?: number;
  /**
   * Called when the page is restored from the back/forward cache (`pageshow`
   * with `event.persisted`) — the JS heap and DOM were frozen, not torn down,
   * so nothing here re-runs on its own: active-link stamping reflects
   * whatever path was current when the page froze, and one-shot setup tied
   * to the original `load` event (idle preheat) never fires again. Left to
   * the caller to decide what "fresh" means (re-stamp, re-arm preheat,
   * `reload()`) rather than this module guessing at a data-freshness policy.
   */
  onRestore?: () => void;
};

/** Resolve an anchor's href to a base-relative fullPath, or null when the
 *  link is not ours (cross-origin, outside base, not a plain string href). */
function routableTarget(anchor: HTMLAnchorElement, base: string): { path: string; fullPath: string } | null {
  if (typeof anchor.href !== 'string' || anchor.href === '') return null;
  let url: URL;
  try {
    url = new URL(anchor.href, window.location.href);
  } catch {
    return null;
  }
  if (url.origin !== window.location.origin) return null;
  const path = stripBase(url.pathname, base);
  if (path === null) return null;
  return { path, fullPath: path + url.search + url.hash };
}

export function installDomIntegration(options: DomIntegrationOptions): () => void {
  const { base, canHandle, navigate, preheat, hoverDelayMs = 100, onRestore } = options;

  function onClick(event: MouseEvent): void {
    if (event.defaultPrevented) return;
    // Some synthetic events (element.click(), test DOMs) omit button; only a
    // real non-left button should bail.
    if (typeof event.button === 'number' && event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    // Find the anchor by scanning the composed path (crosses shadow
    // boundaries — a parentElement walk would stop at the shadow root; the
    // page.js source iterates the full path for exactly this reason), then
    // fall back to an ancestor walk for browsers without composedPath.
    let anchor: HTMLAnchorElement | null = null;
    const path = event.composedPath?.();
    if (path) {
      for (const node of path) {
        if ((node as Element).nodeName?.toUpperCase() === 'A' && (node as HTMLAnchorElement).href) {
          anchor = node as HTMLAnchorElement;
          break;
        }
      }
    } else {
      let element = event.target as Element | null;
      while (element && element.nodeName.toUpperCase() !== 'A') element = element.parentElement;
      anchor = element as HTMLAnchorElement | null;
    }
    if (!anchor) return;

    if (anchor.hasAttribute('download') || anchor.hasAttribute('data-native')) return;
    const rel = anchor.getAttribute('rel');
    if (rel && /\bexternal\b/i.test(rel)) return;
    const target = anchor.getAttribute('target');
    if (target && !/\b_self\b/i.test(target)) return;

    const routable = routableTarget(anchor, base);
    if (!routable) return;

    // In-page hash link on the same path → browser default.
    const url = new URL(anchor.href, window.location.href);
    if (url.hash && url.pathname === window.location.pathname && url.search === window.location.search) return;
    if (!canHandle(routable.path)) return;

    event.preventDefault();
    navigate(routable.fullPath, anchor.hasAttribute('data-replace'));
  }

  let hoverTimer: ReturnType<typeof setTimeout> | null = null;
  function onMouseover(event: MouseEvent): void {
    if (!preheat) return;
    const anchor = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!anchor || anchor.hasAttribute('data-native')) return;
    const routable = routableTarget(anchor, base);
    if (!routable || !canHandle(routable.path)) return;
    if (hoverTimer) clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => preheat(routable.path), hoverDelayMs);
  }
  function onMouseout(): void {
    if (hoverTimer) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
  }

  function onPageshow(event: PageTransitionEvent): void {
    if (event.persisted) onRestore?.();
  }

  document.addEventListener('click', onClick);
  if (preheat) {
    document.addEventListener('mouseover', onMouseover);
    document.addEventListener('mouseout', onMouseout);
  }
  if (onRestore) window.addEventListener('pageshow', onPageshow);
  return () => {
    document.removeEventListener('click', onClick);
    document.removeEventListener('mouseover', onMouseover);
    document.removeEventListener('mouseout', onMouseout);
    if (onRestore) window.removeEventListener('pageshow', onPageshow);
    if (hoverTimer) clearTimeout(hoverTimer);
  };
}

/**
 * Stamp `data-active` (prefix match) / `data-exact-active` (same path,
 * trailing-slash tolerant) on every in-base anchor. Call after each commit.
 */
export function stampActiveLinks(base: string, currentPath: string, root: ParentNode = document): void {
  for (const anchor of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const routable = routableTarget(anchor, base);
    if (!routable) {
      anchor.removeAttribute('data-active');
      anchor.removeAttribute('data-exact-active');
      continue;
    }
    const { active, exact } = pathActivity(routable.path, currentPath);
    anchor.toggleAttribute('data-active', active);
    anchor.toggleAttribute('data-exact-active', exact);
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
  const { gap = 200, idleTimeout = 4000 } = options;
  if (typeof window === 'undefined' || factories.length === 0) return () => {};

  const connection = (navigator as { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  if (connection?.saveData) return () => {};
  if (connection?.effectiveType && /2g/.test(connection.effectiveType)) return () => {};

  let aborted = false;
  const abort = () => {
    aborted = true;
  };
  const abortEvents = ['scroll', 'click', 'keydown', 'pointerdown'] as const;
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
