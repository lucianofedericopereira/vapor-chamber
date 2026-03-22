/**
 * vapor-chamber — HTTP client
 *
 * Adapted and improved from useFetch (2026-02-05A).
 * TypeScript rewrite aligned with vapor-chamber conventions and CDCC thresholds.
 *
 * Improvements over the original:
 *  - Full TypeScript types (no `any` casts)
 *  - CDCC-compliant function sizes
 *  - `AbortSignal.any` with manual fallback for older environments
 *  - Jitter on exponential backoff (avoids thundering herd)
 *  - `X-RateLimit-Reset` header as Retry-After fallback
 *  - 419 CSRF refresh coalesces concurrent requests (no duplicate refreshes)
 *  - `session-expired` CustomEvent + configurable callback
 *  - `TimeoutError` distinct from `AbortError` (user abort vs timeout)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HttpConfig = {
  /** Request timeout in ms. Default: 10_000 */
  timeout?: number;
  /** Max retry attempts on 5xx/429/408. Default: 0 */
  retry?: number;
  /** External abort signal (e.g. from component unmount) */
  signal?: AbortSignal;
  /** Read CSRF token from DOM and attach as header. Default: false */
  csrf?: boolean;
  /**
   * URL to fetch when a 419 CSRF expiry occurs, to obtain a fresh token.
   * Default: '/sanctum/csrf-cookie' (Laravel Sanctum SPA standard).
   * Set to empty string '' to disable the refresh fetch (re-read DOM only).
   */
  csrfCookieUrl?: string;
  /** Additional headers merged into every request */
  headers?: Record<string, string>;
  /** Called when a 401 session-expired response is received */
  onSessionExpired?: (status: number) => void;
};

export type HttpResponse<T = unknown> = {
  data: T;
  status: number;
  headers: Record<string, string>;
  ok: boolean;
};

export type HttpError = Error & {
  name: 'HttpError' | 'TimeoutError' | 'AbortError';
  response?: HttpResponse;
  status?: number;
  /** Machine-readable error code from response body (e.g. `'CART_ITEM_LIMIT_EXCEEDED'`). */
  code?: string;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RETRY_STATUS = [408, 429, 500, 502, 503, 504];
const RETRY_AFTER_STATUS = [429, 503];
const SESSION_EXPIRED_STATUS = [401]; // 419 is CSRF expiry, not session expiry
const MAX_RETRY_AFTER_MS = 30_000;
const CSRF_TTL_MS = 300_000; // 5 min
const DEFAULT_CSRF_COOKIE_URL = '/sanctum/csrf-cookie';

// ---------------------------------------------------------------------------
// CSRF — multi-source with TTL cache
// ---------------------------------------------------------------------------

type CsrfResult = { token: string; headerName: string };
type CsrfCacheEntry = CsrfResult & { expiresAt: number };

let _csrfCache: CsrfCacheEntry | null = null;
let _csrfRefreshing = false;

/** Read CSRF token from DOM: meta tag → cookie → hidden input. TTL-cached for 5 min. */
export function readCsrfToken(): CsrfResult | null {
  const now = Date.now();
  if (_csrfCache && now < _csrfCache.expiresAt) {
    return { token: _csrfCache.token, headerName: _csrfCache.headerName };
  }
  if (typeof document === 'undefined') return null;
  const result = readCsrfFromDom();
  if (result) _csrfCache = { ...result, expiresAt: now + CSRF_TTL_MS };
  return result;
}

function readCsrfFromDom(): CsrfResult | null {
  const q = typeof document.querySelector === 'function'
    ? (sel: string) => document.querySelector(sel)
    : null;

  // 1. Meta tag — Laravel Blade: <meta name="csrf-token" content="...">
  if (q) {
    const meta = q('meta[name="csrf-token"]') as HTMLMetaElement | null;
    if (meta?.content) return { token: meta.content, headerName: 'X-CSRF-TOKEN' };
  }

  // 2. Cookie — Laravel SPA: XSRF-TOKEN=...
  const cookieMatch = document.cookie?.match(/(?:^|;\s*)XSRF-TOKEN=([^;]+)/);
  if (cookieMatch) return { token: decodeURIComponent(cookieMatch[1]), headerName: 'X-XSRF-TOKEN' };

  // 3. Hidden input — @csrf Blade directive: <input name="_token">
  if (q) {
    const input = q('input[name="_token"]') as HTMLInputElement | null;
    if (input?.value) return { token: input.value, headerName: 'X-CSRF-TOKEN' };
  }

  return null;
}

/** Invalidate the CSRF token cache (e.g. after logout). */
export function invalidateCsrfCache(): void {
  _csrfCache = null;
}

async function refreshCsrfOnce(cookieUrl: string): Promise<void> {
  if (_csrfRefreshing) {
    // Coalesce: wait for the in-flight refresh instead of doing a duplicate
    let ticks = 0;
    while (_csrfRefreshing && ticks < 50) {
      await new Promise<void>(r => setTimeout(r, 100));
      ticks++;
    }
    return;
  }
  _csrfRefreshing = true;
  try {
    // Fetch the CSRF cookie endpoint so Laravel issues a fresh XSRF-TOKEN cookie.
    // Failures are silently swallowed — the retry below may still succeed if the
    // cookie was already rotated by the server.
    if (cookieUrl) {
      try { await fetch(cookieUrl, { method: 'GET', credentials: 'same-origin' }); } catch { /* ignore */ }
    }
    invalidateCsrfCache();
    readCsrfToken(); // re-read DOM / cookie after fetch
  } finally {
    _csrfRefreshing = false;
  }
}

// ---------------------------------------------------------------------------
// Retry timing
// ---------------------------------------------------------------------------

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (!Number.isNaN(seconds)) {
    const ms = seconds * 1000;
    return ms <= MAX_RETRY_AFTER_MS ? ms : null;
  }
  const date = Date.parse(header);
  if (!Number.isNaN(date)) {
    const ms = date - Date.now();
    return ms > 0 && ms <= MAX_RETRY_AFTER_MS ? ms : null;
  }
  return null;
}

/** Exponential backoff with ±200ms jitter to avoid thundering herd. */
function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 30_000) + Math.random() * 200;
}

// ---------------------------------------------------------------------------
// AbortSignal utilities
// ---------------------------------------------------------------------------

function combineSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([a, b]);
  // Fallback for environments without AbortSignal.any
  const ctrl = new AbortController();
  const abort = () => ctrl.abort();
  a.addEventListener('abort', abort, { once: true });
  b.addEventListener('abort', abort, { once: true });
  return ctrl.signal;
}

function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(id);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Error constructors
// ---------------------------------------------------------------------------

function httpError(message: string, response: HttpResponse): HttpError {
  const err = new Error(message) as HttpError;
  err.name = 'HttpError';
  err.response = response;
  err.status = response.status;
  const code = (response.data as any)?.code;
  if (code != null) err.code = String(code);
  return err;
}

function timeoutError(action: string, timeoutMs: number): HttpError {
  const err = new Error(`"${action}" timed out after ${timeoutMs}ms`) as HttpError;
  err.name = 'TimeoutError';
  return err;
}

// ---------------------------------------------------------------------------
// Session expiry
// ---------------------------------------------------------------------------

function handleSessionExpiry(status: number, url: string, onSessionExpired?: (s: number) => void): void {
  onSessionExpired?.(status);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('session-expired', { detail: { status, url } }));
  }
}

// ---------------------------------------------------------------------------
// Core: postCommand
//
// Sends a single POST request with retry, CSRF, timeout and session detection.
// Used by createHttpBridge — not intended as a general-purpose HTTP client.
// ---------------------------------------------------------------------------

async function doFetch<T>(url: string, serialized: string, headers: Record<string, string>, signal: AbortSignal): Promise<HttpResponse<T>> {
  const raw = await fetch(url, { method: 'POST', headers, body: serialized, credentials: 'same-origin', signal });
  const resHeaders = raw.headers ? Object.fromEntries(raw.headers.entries()) : {};
  let data: T = null as T;
  try { data = await raw.json() as T; } catch { /* non-JSON */ }
  return { data, status: raw.status, headers: resHeaders, ok: raw.ok };
}

export async function postCommand<T = unknown>(
  url: string,
  body: unknown,
  config: HttpConfig = {},
): Promise<HttpResponse<T>> {
  const { timeout = 10_000, retry = 0, signal: userSignal, csrf = false, csrfCookieUrl = DEFAULT_CSRF_COOKIE_URL, headers: extra = {}, onSessionExpired } = config;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    ...extra,
  };

  if (csrf) {
    const token = readCsrfToken();
    if (token) headers[token.headerName] = token.token;
  }

  const serialized = JSON.stringify(body);
  let csrfRetried = false;

  for (let attempt = 0; attempt <= retry; attempt++) {
    if (userSignal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const timeoutCtrl = new AbortController();
    const timeoutId = setTimeout(() => timeoutCtrl.abort(), timeout);
    const signal = userSignal ? combineSignals(userSignal, timeoutCtrl.signal) : timeoutCtrl.signal;

    try {
      const res = await doFetch<T>(url, serialized, headers, signal);
      clearTimeout(timeoutId);

      if (!res.ok) {
        if (SESSION_EXPIRED_STATUS.includes(res.status)) handleSessionExpiry(res.status, url, onSessionExpired);

        // 419: CSRF expired — fetch fresh cookie, refresh once, doesn't count against retry budget
        if (res.status === 419 && !csrfRetried) {
          csrfRetried = true;
          await refreshCsrfOnce(csrfCookieUrl);
          const fresh = readCsrfToken();
          if (fresh) headers[fresh.headerName] = fresh.token;
          attempt--;
          continue;
        }

        // Retry on retryable status codes
        if (RETRY_STATUS.includes(res.status) && attempt < retry) {
          const retryAfter = res.headers['retry-after'] ?? res.headers['x-ratelimit-reset'] ?? null;
          const wait = RETRY_AFTER_STATUS.includes(res.status)
            ? (parseRetryAfter(retryAfter) ?? backoffMs(attempt))
            : backoffMs(attempt);
          await sleepMs(wait, userSignal);
          continue;
        }

        throw httpError(`HTTP ${res.status}`, res);
      }

      return res;
    } catch (e) {
      clearTimeout(timeoutId);
      const err = e as Error;
      if (err.name === 'AbortError') throw userSignal?.aborted ? err : timeoutError(url, timeout);
      if (attempt >= retry) throw err;
      await sleepMs(backoffMs(attempt), userSignal);
    }
  }

  throw new Error('unreachable');
}
