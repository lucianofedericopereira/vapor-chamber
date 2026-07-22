/**
 * vapor-chamber-router — history layer.
 *
 * Base-aware wrapper over the History API: all router-facing paths are
 * RELATIVE to the base ('/admin' stays a server concern); `createHref`
 * prepends it back for the DOM. `createMemoryHistory` is the same contract
 * for tests and SSR. Link handling lives in core/dom.ts, not here.
 */

export type HistoryListener = (fullPath: string, info: { delta: number; state: unknown }) => void;

export type RouterHistory = {
  readonly base: string;
  /** Current fullPath (path + search + hash) relative to base. */
  location: () => string;
  state: () => unknown;
  push: (fullPath: string, state?: Record<string, unknown>) => void;
  replace: (fullPath: string, state?: Record<string, unknown>) => void;
  go: (delta: number) => void;
  listen: (cb: HistoryListener) => () => void;
  /** Absolute href for the DOM: base + fullPath. */
  createHref: (fullPath: string) => string;
  destroy: () => void;
};

/** '' stays '', anything else gets a leading slash and loses the trailing one. */
export function normalizeBase(base?: string): string {
  if (!base) return '';
  const withLead = base.startsWith('/') ? base : `/${base}`;
  return withLead.replace(/\/$/, '');
}

/** Case-insensitive base prefix strip; null when pathname is outside base. */
export function stripBase(pathname: string, base: string): string | null {
  if (!base) return pathname;
  const lower = pathname.toLowerCase();
  const baseLower = base.toLowerCase();
  if (lower !== baseLower && !lower.startsWith(`${baseLower}/`)) return null;
  return pathname.slice(base.length) || '/';
}

export type ResolveBaseOptions = {
  /** Explicit base — wins outright, everything else ignored. */
  url?: string;
  /** Mount prefix, e.g. '/admin' (or '/backend', anything — never assumed).
   *  Omit for locale-first URLs where the pathname starts with the locale. */
  prefix?: string;
  /** Locale segments to detect after the prefix (or at the pathname start
   *  when there is no prefix). The segment is OPTIONAL — absent locale just
   *  yields the prefix alone. */
  locales?: readonly string[];
  /** Pathname to inspect. Default: window.location.pathname. */
  pathname?: string;
};

/**
 * Derive the router base from the current URL at boot.
 *
 *   resolveBase({ url: '/whatever' })                       → '/whatever'
 *   resolveBase({ prefix: '/admin', locales: ['it','en'] })
 *     on /admin/it/catalog                                  → '/admin/it'
 *     on /admin/catalog        (locale optional)            → '/admin'
 *   resolveBase({ locales: ['it','en'] })   (no prefix)
 *     on /en/checkout                                       → '/en'
 *     on /checkout                                          → ''
 *
 * The locale segment lives in the BASE, not in route paths — the table stays
 * locale-free, one generated module serves every locale, and Blade-inlined
 * payloads can localize titles per request.
 */
export function resolveBase(options: ResolveBaseOptions = {}): string {
  if (options.url !== undefined) return normalizeBase(options.url);
  const prefix = normalizeBase(options.prefix);
  const pathname = options.pathname ?? (typeof window !== 'undefined' ? window.location.pathname : '');

  let rest = pathname;
  if (prefix) {
    const stripped = stripBase(pathname, prefix);
    if (stripped === null) return prefix; // outside the prefix — mount at prefix anyway
    rest = stripped;
  }
  const first = rest.split('/').find(Boolean);
  if (first && options.locales?.some((locale) => locale.toLowerCase() === first.toLowerCase())) {
    return `${prefix}/${first.toLowerCase()}`;
  }
  return prefix;
}

/**
 * Can this context actually use the History API? A probe, not a heuristic:
 * pushState/replaceState throw SecurityError whenever the document URL and
 * origin mismatch — sandboxed/srcdoc iframes (opaque origin), data:
 * documents, and even non-sandboxed freshly-created contexts (see
 * whatwg/html#6836). Attribute sniffing can't cover all of those; calling
 * replaceState with the CURRENT state is side-effect-free and authoritative.
 */
export function canUseWebHistory(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    window.history.replaceState(window.history.state, '');
    return true;
  } catch {
    return false;
  }
}

type PositionState = { __vr: number } & Record<string, unknown>;

export function createWebHistory(rawBase?: string): RouterHistory {
  const base = normalizeBase(rawBase);
  const listeners = new Set<HistoryListener>();

  function currentFullPath(): string {
    const stripped = stripBase(window.location.pathname, base);
    return (stripped ?? '/') + window.location.search + window.location.hash;
  }

  function position(): number {
    const state = window.history.state as PositionState | null;
    return typeof state?.__vr === 'number' ? state.__vr : 0;
  }

  // Stamp the entry we booted on so popstate deltas are computable.
  if (window.history.state?.__vr === undefined) {
    window.history.replaceState({ ...window.history.state, __vr: 0 }, '');
  }
  let lastPosition = position();

  function onPopState(event: PopStateEvent): void {
    const state = event.state as PositionState | null;
    const newPosition = typeof state?.__vr === 'number' ? state.__vr : 0;
    const delta = newPosition - lastPosition;
    lastPosition = newPosition;
    const fullPath = currentFullPath();
    for (const cb of listeners) cb(fullPath, { delta, state });
  }
  window.addEventListener('popstate', onPopState);

  function change(fullPath: string, state: Record<string, unknown> | undefined, replace: boolean): void {
    const nextPosition = replace ? lastPosition : lastPosition + 1;
    const nextState: PositionState = { ...state, __vr: nextPosition };
    try {
      window.history[replace ? 'replaceState' : 'pushState'](nextState, '', base + fullPath);
      lastPosition = nextPosition;
    } catch {
      // Safari "100 pushState per 30s" throttle — fall back to a full load.
      window.location[replace ? 'replace' : 'assign'](base + fullPath);
    }
  }

  return {
    base,
    location: currentFullPath,
    state: () => window.history.state,
    push: (fullPath, state) => change(fullPath, state, false),
    replace: (fullPath, state) => change(fullPath, state, true),
    go: (delta) => window.history.go(delta),
    listen: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    createHref: (fullPath) => base + fullPath,
    destroy: () => {
      listeners.clear();
      window.removeEventListener('popstate', onPopState);
    },
  };
}

/** In-memory history — tests and SSR. Same contract as createWebHistory. */
export function createMemoryHistory(rawBase?: string, initialFullPath = '/'): RouterHistory {
  const base = normalizeBase(rawBase);
  const listeners = new Set<HistoryListener>();
  const stack: Array<{ fullPath: string; state: unknown }> = [{ fullPath: initialFullPath, state: null }];
  let index = 0;

  return {
    base,
    location: () => (stack[index] as { fullPath: string }).fullPath,
    state: () => (stack[index] as { state: unknown }).state,
    push: (fullPath, state) => {
      stack.splice(index + 1);
      stack.push({ fullPath, state: state ?? null });
      index = stack.length - 1;
    },
    replace: (fullPath, state) => {
      stack[index] = { fullPath, state: state ?? null };
    },
    go: (delta) => {
      const next = Math.max(0, Math.min(stack.length - 1, index + delta));
      const applied = next - index;
      if (!applied) return;
      index = next;
      const entry = stack[index] as { fullPath: string; state: unknown };
      for (const cb of listeners) cb(entry.fullPath, { delta: applied, state: entry.state });
    },
    listen: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    createHref: (fullPath) => base + fullPath,
    destroy: () => listeners.clear(),
  };
}
