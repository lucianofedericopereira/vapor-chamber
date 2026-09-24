/**
 * vapor-chamber - HTTP client
 *
 * Adapted and improved from useFetch (2026-02-05A).
 * TypeScript rewrite aligned with vapor-chamber conventions and CDCC thresholds.
 *
 * Improvements over the original:
 *  - Full TypeScript types
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
  /**
   * Request timeout in ms.
   *
   * Two consumers, two defaults - this type is shared by `postCommand` and by
   * `createHttpClient` (via `HttpRequestConfig`), and they do not agree:
   * **10_000 through `postCommand`, 30_000 through a client** (a command POST
   * and a general-purpose GET have different patience). Stating only the first
   * made this tooltip wrong for every `http.get()` caller.
   *
   * Bounds: a value that does not compare as a number (NaN, a non-numeric
   * string) takes that default; anything above
   * 2_147_483_647 ms (`setTimeout`'s ceiling, where it would fire at once)
   * is capped there, so `Infinity` means "as long as a timer can wait"; 0 or
   * a negative value times out immediately.
   */
  timeout?: number;
  /**
   * Max retry attempts on 5xx/429/408.
   *
   * Same split: **0 through `postCommand`**, and through a client **2 for
   * idempotent methods (GET), 0 for mutations** - retrying a POST is not safe
   * to do on the caller's behalf.
   */
  retry?: number;
  /** External abort signal (e.g. from component unmount) */
  signal?: AbortSignal;
  /** Read CSRF token from DOM and attach as header. Default: false */
  csrf?: boolean;
  /**
   * URL to fetch when a CSRF-expiry response (HTTP 419) occurs, to obtain a
   * fresh token. The default targets the Laravel Sanctum SPA convention
   * because it's the most common backend issuing 419 - override for other
   * frameworks, or set to '' to disable the auto-refresh entirely (the lib
   * will then only re-read the token from the DOM on retry).
   * Default: '/sanctum/csrf-cookie'.
   */
  csrfCookieUrl?: string;
  /** Additional headers merged into every request */
  headers?: Record<string, string>;
  /** Called when a 401 session-expired response is received */
  onSessionExpired?: (status: number) => void;
  /**
   * Stamps a thrown error's `.silent` so a caller-provided global error
   * handler can skip it - for fire-and-forget requests (best-effort
   * telemetry, background prefetch) that shouldn't surface UI noise.
   * Default: false.
   */
  silent?: boolean;
};

export type HttpResponse<T = unknown> = {
  data: T;
  status: number;
  headers: Record<string, string>;
  ok: boolean;
  /** True when this response was served from a stale (past-fresh) cache entry. */
  stale?: boolean;
  /** Present on a stale hit: resolves with the fresh response once the background revalidation lands. */
  revalidation?: Promise<HttpResponse<T>>;
  /** True when this is a retained cache entry served in place of a transient failure (`cache.serveStaleOnError`). */
  servedOnError?: boolean;
  /** The transient error `servedOnError` masked - surfaced alongside the stale data, never silently dropped. */
  error?: unknown;
};

export type HttpErrorName = 'HttpError' | 'TimeoutError' | 'AbortError';

/**
 * A CLASS since v1.23.0, and a type - `Error & { ... }` - since v0.4.
 *
 * The type was why FOUR places built this shape by hand: `responseError` and
 * the timeout below, and the two catch blocks in `transports.ts` that
 * re-assemble it field by field to swap in the backend's own message. A type
 * cannot be called, so each site spelled the same four assignments out and each
 * was free to forget one. That is not hypothetical: the envelope paths dropped
 * `code` while the catch path kept it, and the two sat twelve lines apart in one
 * function (fixed in v1.23.0, `tests/envelope-code.test.ts`).
 *
 * Nothing about the shape moved: the same five fields under the same names, and
 * `HttpError` still names a type wherever it did, because a class declaration
 * declares one. `index.ts` re-exports it as a type only, so the constructor is
 * not new public surface and stays shakeable out of a barrel import.
 *
 * MEASURED, three shapes of the same consolidation, one build each. Brotli,
 * full / core / elements:
 *
 *     class (this)                 12,011 / 8,125 / 8,638
 *     plain factory function       12,030 / 8,128 / 8,645
 *     one Object.assign expression 12,021 / 8,131 / 8,642
 *
 * The class is smallest in all three. It is 34 B LARGER raw than either of the
 * others, in all three, and raw is the ceiling that absorbs toolchain drift
 * rather than the headline number - so brotli decides, as the budget comments in
 * `scripts/check-size.mjs` already say it does.
 *
 * It is also the only one of the three that can be extended: a factory returns
 * an intersection type nobody can subclass, and `Object.assign` returns a shape
 * with no identity at all. That is the tie-break the bytes did not need to make
 * here, and it is why this is a class rather than the cheapest expression.
 *
 * None of the three is a byte SAVING over the four hand-assembled sites - the
 * class costs +8 B brotli on full. What it buys is that a site can no longer
 * omit a field, which is the defect that produced `tests/envelope-code.test.ts`.
 *
 * `response`, `status` and `code` are assigned unconditionally rather than
 * behind a `!== undefined` guard, the shape `okResult`/`errResult` and
 * `backendError` already use, so two instances built here never differ. NOT a
 * claim that an HttpError has one hidden class for its whole life: `silent` is
 * stamped after construction at two call sites, and always was.
 *
 * `instanceof` is deliberately NOT part of what this buys. Using it to tell a
 * library error from a backend one was considered and dropped - `emitter` is
 * the field that answers that, and it answers it for a plain object too.
 */
export class HttpError extends Error {
  declare name: HttpErrorName;
  declare response?: HttpResponse;
  declare status?: number;
  /** Machine-readable error code from response body (e.g. `'CART_ITEM_LIMIT_EXCEEDED'`). */
  declare code?: string;
  /** Set when the request's `silent: true` config opts the caller out of a global error handler/toast. */
  declare silent?: boolean;

  constructor(
    name: HttpErrorName,
    message: string,
    opts: { response?: HttpResponse; status?: number; code?: string; cause?: Error } = {},
  ) {
    super(message, opts.cause ? { cause: opts.cause } : undefined);
    this.name = name;
    this.response = opts.response;
    // `status` is taken from the response when the caller does not say
    // otherwise. The catch paths in `transports.ts` pass it explicitly because
    // a custom `httpClient` may throw something carrying a status and no
    // response, and deriving it would drop the one field `retry()` reads.
    this.status = opts.status ?? opts.response?.status;
    this.code = opts.code;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RETRY_AFTER_STATUS = [429, 503];
const SESSION_EXPIRED_STATUS = [401]; // 419 is CSRF expiry, not session expiry
const MAX_RETRY_AFTER_MS = 30_000;
const CSRF_TTL_MS = 300_000; // 5 min
const DEFAULT_CSRF_COOKIE_URL = '/sanctum/csrf-cookie';

// ---------------------------------------------------------------------------
// CSRF - multi-source with TTL cache
// ---------------------------------------------------------------------------

type CsrfResult = { token: string; headerName: string };
type CsrfCacheEntry = CsrfResult & { expiresAt: number };

let _csrfCache: CsrfCacheEntry | null = null;

/** Read CSRF token from DOM: meta tag -> cookie -> hidden input. TTL-cached for 5 min. */
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

/** Every CSRF header this library may set - both are cleared before a refresh
 *  attaches the fresh one, so a stale header cannot outrank it (Laravel reads
 *  X-CSRF-TOKEN before X-XSRF-TOKEN; getTokenFromRequest, verified at source). */
const CSRF_HEADER_NAMES = ['X-CSRF-TOKEN', 'X-XSRF-TOKEN'] as const;

/** Set `token` as the ONLY csrf header - clears the other name first. */
function setCsrfHeader(headers: Record<string, string>, result: CsrfResult): void {
  for (const name of CSRF_HEADER_NAMES) delete headers[name];
  headers[result.headerName] = result.token;
}

/**
 * The `XSRF-TOKEN` cookie only. Split out of `readCsrfFromDom` because the
 * post-refresh re-read needs it FIRST (see `readCsrfAfterRefresh`). The cookie
 * name comes from `<meta name="xsrf-cookie">` or defaults to `XSRF-TOKEN`.
 */
function readCsrfFromCookie(): CsrfResult | null {
  if (typeof document === 'undefined') return null;
  const q = typeof document.querySelector === 'function'
    ? (sel: string) => document.querySelector(sel)
    : null;
  const cookieNameMeta = q?.('meta[name="xsrf-cookie"]') as HTMLMetaElement | null;
  const cookieName = cookieNameMeta?.content || 'XSRF-TOKEN';
  const escaped = cookieName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const cookieMatch = document.cookie?.match(new RegExp(`(?:^|;\\s*)${escaped}=([^;]+)`));
  if (cookieMatch) return { token: decodeURIComponent(cookieMatch[1]), headerName: 'X-XSRF-TOKEN' };
  return null;
}

function readCsrfFromDom(): CsrfResult | null {
  const q = typeof document.querySelector === 'function'
    ? (sel: string) => document.querySelector(sel)
    : null;

  // 1. Meta tag - `<meta name="csrf-token" content="...">`. Common in
  //    server-rendered frameworks (Laravel Blade, Rails, others).
  if (q) {
    const meta = q('meta[name="csrf-token"]') as HTMLMetaElement | null;
    if (meta?.content) return { token: meta.content, headerName: 'X-CSRF-TOKEN' };
  }

  // 2. Cookie - `XSRF-TOKEN` (or the name in `<meta name="xsrf-cookie">`).
  const fromCookie = readCsrfFromCookie();
  if (fromCookie) return fromCookie;

  // 3. Hidden input - `<input name="_token">`. Emitted by Laravel's `@csrf`
  //    Blade directive, also appears in Rails forms and other stacks.
  if (q) {
    const input = q('input[name="_token"]') as HTMLInputElement | null;
    if (input?.value) return { token: input.value, headerName: 'X-CSRF-TOKEN' };
  }

  return null;
}

/**
 * Re-read the token AFTER a 419 refresh, cookie FIRST.
 *
 * The initial read prefers the `<meta name="csrf-token">` tag. But a 419 means
 * that token expired, and the meta tag is rendered ONCE per page load, so it
 * stays stale for the life of the page - re-reading it would retry with the
 * same dead token and 419 again (a long-open panel hit exactly this). The
 * refresh fetch makes the backend set a fresh `XSRF-TOKEN` cookie (Laravel's
 * CSRF middleware sets it on every response), so after a refresh the cookie is
 * the live source. Fall back to the full DOM read for a page with no cookie
 * (a `@csrf` hidden-input form), so this is a superset of the old behaviour.
 */
function readCsrfAfterRefresh(): CsrfResult | null {
  const fromCookie = readCsrfFromCookie();
  if (fromCookie) {
    _csrfCache = { ...fromCookie, expiresAt: Date.now() + CSRF_TTL_MS };
    return fromCookie;
  }
  // No cookie: fall back to `readCsrfToken`, NOT `readCsrfFromDom` directly -
  // readCsrfToken guards `typeof document` (a 419 refresh can run on a server,
  // where document is undefined) and caches its own result.
  return readCsrfToken();
}

/** Invalidate the CSRF token cache (e.g. after logout). */
export function invalidateCsrfCache(): void {
  _csrfCache = null;
}

let _csrfRefreshPromise: Promise<CsrfResult> | null = null;

function refreshCsrfOnce(cookieUrl: string): Promise<CsrfResult> {
  // Coalesce: concurrent 419s share the single in-flight refresh promise -
  // waiters resolve/reject the instant it settles, no polling.
  //
  // RETURNS the token rather than leaving callers to re-read it. Both call
  // sites used to do `await refreshCsrfOnce(...); const fresh =
  // readCsrfToken();` - and between those two statements sits a microtask
  // boundary that several coalesced waiters resume across. A waiter that ran
  // first could invalidate the cache (the exported `invalidateCsrfCache()`) or
  // clear the DOM before a later waiter re-read, so the later one saw null and
  // silently retried with no CSRF header. Handing back the value this function
  // has already proven readable closes that window, makes the coalescing
  // semantics exact (every waiter gets the SAME token), and removes the
  // `if (fresh)` guard at both call sites - which was unreachable in ordinary
  // flow anyway, because this function throws when no token is found.
  if (_csrfRefreshPromise) return _csrfRefreshPromise;
  _csrfRefreshPromise = (async () => {
    try {
      // Fetch the CSRF cookie endpoint so the backend issues a fresh
      // XSRF-TOKEN cookie (Laravel Sanctum's `/sanctum/csrf-cookie` is the
      // most common shape; other frameworks expose equivalent endpoints).
      // Only fetch if cookieUrl is a non-empty string.
      if (typeof cookieUrl === 'string' && cookieUrl.length > 0) {
        try { await fetch(cookieUrl, { method: 'GET', credentials: 'same-origin' }); } catch { /* ignore network errors */ }
      }
      invalidateCsrfCache();
      // Cookie FIRST here: the fetch above just made the backend set a fresh
      // XSRF-TOKEN cookie, while the meta tag is still the stale one the page
      // was rendered with. See readCsrfAfterRefresh.
      const freshToken = readCsrfAfterRefresh();
      if (!freshToken) {
        throw new Error('[vapor-chamber] CSRF refresh failed: no token found in DOM after refresh');
      }
      return freshToken;
    } finally {
      _csrfRefreshPromise = null;
    }
  })();
  return _csrfRefreshPromise;
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

/** Exponential backoff plus 0-200ms of jitter to avoid thundering herd. */
function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 30_000) + Math.random() * 200;
}

// ---------------------------------------------------------------------------
// AbortSignal utilities
// ---------------------------------------------------------------------------

type CombinedSignal = { signal: AbortSignal; detach: () => void };

function combineSignals(a: AbortSignal, b: AbortSignal): CombinedSignal {
  // AbortSignal.any listeners are platform-managed (GC-safe) - nothing to detach.
  if (typeof AbortSignal.any === 'function') {
    return { signal: AbortSignal.any([a, b]), detach: () => {} };
  }
  // Fallback for environments without AbortSignal.any. Callers MUST detach()
  // when the request settles - the user signal is typically component-lifetime,
  // so listeners left behind accrete once per request until unmount.
  const ctrl = new AbortController();
  const abort = () => ctrl.abort();
  a.addEventListener('abort', abort, { once: true });
  b.addEventListener('abort', abort, { once: true });
  return {
    signal: ctrl.signal,
    detach: () => {
      a.removeEventListener('abort', abort);
      b.removeEventListener('abort', abort);
    },
  };
}

function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(id);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    // Detach on normal resolve too - the signal outlives this sleep, and the
    // listener would otherwise pin the timer closure per retry sleep.
    const id = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Error constructors
// ---------------------------------------------------------------------------

/**
 * `HttpError` for a non-2xx, with the body's `code` lifted out.
 *
 * The `!= null` guard and the `String()` stay here rather than moving into the
 * the constructor: this is the one site reading an UNTRUSTED body, where `code`
 * may be a number or absent, and every other site already holds a string.
 */
function responseError(message: string, response: HttpResponse): HttpError {
  const data = response.data as any;
  const code = data?.code;
  // An RFC 9457 problem's `detail` is the backend's own sentence for this
  // occurrence, so it replaces `HTTP <status>` - here, once, for the client,
  // router-fetch and both bridges alike: a bridge's catch path hands this
  // error on as it is when the body has no `error`/`message` of its own.
  return new HttpError('HttpError', data?.detail || message, { response, code: code == null ? undefined : String(code) });
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
// Used by createHttpBridge - not intended as a general-purpose HTTP client.
// ---------------------------------------------------------------------------

/**
 * A Response's headers as a plain object, tolerating a double or polyfill that
 * has no `headers` at all.
 *
 * Extracted because this line existed TWICE, written out longhand - once in
 * `doFetch` and once in `doClientFetch`. That duplication is what let the two
 * drift: `doFetch` never touched `raw.headers` again and stayed correct, while
 * `doClientFetch` grew responseType handling whose content-type read went back
 * to the raw object and reintroduced the crash this guard exists to prevent.
 * One owner for "normalize a Response's headers" removes that channel.
 *
 * Keys are lower-cased here, and this is the only place that should do it.
 * Every consumer reads this snapshot case-sensitively -
 * `res.headers['retry-after']` and `['x-ratelimit-reset']` in both retry
 * loops, `['content-disposition']` in the download path - so a `Headers` whose
 * `entries()` yields `Retry-After` makes all of them miss with NO error:
 * backoff silently not honoured, filename silently lost.
 *
 * The Fetch spec does store header names lower-cased, so against a compliant
 * implementation this is a no-op, and it costs +6 bytes brotli in the minimal
 * consumer bundle (measured: 6_539 -> 6_545). Taken deliberately: the argument
 * for skipping it assumes every Headers implementation in every consumer's
 * environment is compliant, and the price of being wrong is a SILENT
 * mis-behaviour rather than a crash. Six bytes to make a silent failure
 * impossible is the trade this library wants - correctness over the byte.
 * Normalizing at the four call sites instead would re-create exactly the
 * duplication this helper exists to remove.
 *
 * The content-type read in `doClientFetch` goes through `Headers.get()` rather
 * than this snapshot for the same reason from the other direction: `get()` is
 * case-insensitive BY SPEC and joins repeated headers, so delegating keeps
 * both guarantees the platform's problem rather than ours. Reading
 * `resHeaders['content-type']` instead would miss on odd casing - and a miss
 * there does not throw, it silently hands the caller a STRING where they asked
 * for JSON.
 */
function headersToObject(headers: Headers | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [key, value] of headers.entries()) out[key.toLowerCase()] = value;
  return out;
}

async function doFetch<T>(url: string, serialized: string, headers: Record<string, string>, signal: AbortSignal): Promise<HttpResponse<T>> {
  const raw = await fetch(url, { method: 'POST', headers, body: serialized, credentials: 'same-origin', signal });
  const resHeaders = headersToObject(raw.headers);
  let data: T = null as T;
  try { data = await raw.json() as T; } catch { /* non-JSON */ }
  return { data, status: raw.status, headers: resHeaders, ok: raw.ok };
}

/**
 * The retry / timeout / CSRF-refresh / session-expiry loop, shared by
 * `postCommand` and `clientRequest`. The only per-caller difference is the
 * fetch itself (passed as `doRequest`) and whether thrown errors are stamped
 * `silent`. The two used to carry a near-identical copy of this loop.
 *
 * ONE policy, correct for both (whitepaper 5.7): 401 = session expiry, fires
 * `onSessionExpired`; 419 = CSRF expiry, refreshed and retried ONCE and NEVER
 * escalated to session expiry. `clientRequest` previously escalated a 419 that
 * survived the refresh - that contradicted both the contract and `postCommand`,
 * and is gone (pre-1.0, no compat shim).
 *
 * `headers` is the object the request sends; on a 419 the fresh token replaces
 * the stale one on it via `setCsrfHeader`, which clears the other csrf header
 * name so Laravel's `X-CSRF-TOKEN`-first read cannot keep the dead one.
 */
async function runWithRetry<T>(
  doRequest: (signal: AbortSignal) => Promise<HttpResponse<T>>,
  headers: Record<string, string>,
  opts: {
    retry: number;
    timeout: number;
    userSignal?: AbortSignal;
    csrfCookieUrl: string;
    onSessionExpired?: (status: number) => void;
    url: string;
    silent?: boolean;
  },
): Promise<HttpResponse<T>> {
  const { retry, timeout, userSignal, csrfCookieUrl, onSessionExpired, url, silent = false } = opts;
  let csrfRetried = false;

  for (let attempt = 0; attempt <= retry; attempt++) {
    if (userSignal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const timeoutCtrl = new AbortController();
    const timeoutId = setTimeout(() => timeoutCtrl.abort(), timeout);
    const combined = userSignal ? combineSignals(userSignal, timeoutCtrl.signal) : null;
    const signal = combined ? combined.signal : timeoutCtrl.signal;

    try {
      const res = await doRequest(signal);
      clearTimeout(timeoutId);
      combined?.detach();

      if (!res.ok) {
        if (SESSION_EXPIRED_STATUS.includes(res.status)) handleSessionExpiry(res.status, url, onSessionExpired);

        // 419 = CSRF expiry: refresh once (off the retry budget), then retry.
        // It NEVER fires onSessionExpired - that is 401's job (whitepaper 5.7).
        if (res.status === 419 && !csrfRetried) {
          csrfRetried = true;
          setCsrfHeader(headers, await refreshCsrfOnce(csrfCookieUrl));
          attempt--;
          continue;
        }

        // Retry on a retryable status - the one rule (http-errors.ts): 408/429/5xx.
        if (isRetryableStatus(res.status) && attempt < retry) {
          const retryAfter = res.headers['retry-after'] ?? res.headers['x-ratelimit-reset'] ?? null;
          const wait = RETRY_AFTER_STATUS.includes(res.status)
            ? (parseRetryAfter(retryAfter) ?? backoffMs(attempt))
            : backoffMs(attempt);
          await sleepMs(wait, userSignal);
          continue;
        }

        const failed = responseError(`HTTP ${res.status}`, res);
        if (silent) failed.silent = true;
        throw failed;
      }

      return res;
    } catch (e) {
      clearTimeout(timeoutId);
      combined?.detach();
      const err = e as HttpError;
      if (err.name === 'AbortError' && userSignal?.aborted) throw err;
      // A timeout-triggered abort is transient: it competes for the retry
      // budget like a 5xx/429/408 instead of throwing on the first attempt.
      const failure = err.name === 'AbortError'
        ? new HttpError('TimeoutError', `"${url}" timed out after ${timeout}ms`)
        : err;
      // A non-transient response thrown above re-enters here; do not retry it
      // (a 422 must not re-send a mutation). isRetryableStatus above owns the
      // retryable statuses.
      if (failure.response && !classifyError(failure).transient) {
        if (silent) failure.silent = true;
        throw failure;
      }
      if (attempt >= retry) {
        if (silent) failure.silent = true;
        throw failure;
      }
      await sleepMs(backoffMs(attempt), userSignal);
    }
  }

  throw new Error('unreachable');
}

export async function postCommand<T = unknown>(
  url: string,
  body: unknown,
  config: HttpConfig = {},
): Promise<HttpResponse<T>> {
  const { timeout: rawTimeout = 10_000, retry = 0, signal: userSignal, csrf = false, csrfCookieUrl = DEFAULT_CSRF_COOKIE_URL, headers: extra = {}, onSessionExpired, silent = false } = config;
  // setTimeout fires a delay it cannot hold AT ONCE: NaN reads as 0, and past
  // MAX_TIMEOUT_MS Node clamps to 1ms and browsers wrap. So `timeout: NaN`
  // (a failed `Number(config.x)`) and `timeout: Infinity` ("no timeout")
  // aborted every request as it started. Two comparisons: NaN (or anything
  // that does not compare as a number) fails both and takes the default,
  // Infinity fails the first and is capped at the ceiling, and 0 and
  // negatives pass through as an explicit "fire now". Chosen over an inline
  // typeof check and over countOption() by measurement - smallest in the
  // Blade bundle (tests/esm-treeshake.test.ts). Pinned by
  // tests/http-timeout-bounds.test.ts.
  const timeout = rawTimeout < MAX_TIMEOUT_MS ? rawTimeout : rawTimeout > 0 ? MAX_TIMEOUT_MS : 10_000;

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
  return runWithRetry<T>(
    (signal) => doFetch<T>(url, serialized, headers, signal),
    headers,
    { retry, timeout, userSignal, csrfCookieUrl, onSessionExpired, url, silent },
  );
}

// ---------------------------------------------------------------------------
// Multi-method HTTP client - createHttpClient
//
// For new code, prefer createHttpClient(). postCommand is retained for
// backward compatibility and is used by createHttpBridge.
// ---------------------------------------------------------------------------

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type ResponseType = 'json' | 'blob' | 'text';

export type HttpRequestConfig = HttpConfig & {
  /** HTTP method. Default: 'GET' */
  method?: HttpMethod;
  /** Request body (auto-serialized if object, passthrough for FormData) */
  data?: unknown;
  /** Query parameters - supports arrays and nested objects */
  params?: Record<string, unknown>;
  /** Base URL prepended to relative paths */
  baseURL?: string;
  /** Response parsing mode. Default: 'json' */
  responseType?: ResponseType;
  /**
   * Enable LRU caching for GET. `true` = default TTL, no stale window.
   * `{ ttl }` sets the fresh-window duration. `{ staleTtl }` opts into
   * stale-while-revalidate: a hit within `ttl + staleTtl` past `ttl` is
   * served instantly with `{ stale: true, revalidation: Promise }` attached,
   * while a background fetch refreshes the entry. `serveStaleOnError` is a
   * separate opt-in: a transient failure (timeout/network/5xx) with ANY
   * retained entry (even past its stale window) resolves to
   * `{ stale: true, servedOnError: true, error }` instead of rejecting.
   */
  cache?: boolean | { ttl?: number; staleTtl?: number; serveStaleOnError?: boolean };
  /** Enable request deduplication for GET. Default: true */
  dedupe?: boolean;
  /** @internal marks a CSRF-retried request */
  _csrfRetried?: boolean;
};

export type SafeResult<T = unknown> = {
  data: T | null;
  error: { message: string; code?: string; [key: string]: unknown } | null;
  status: number;
};

export type DownloadResult = {
  data: Blob;
  status: number;
  filename: string;
};

export type Interceptor<T> = {
  onFulfilled?: (value: T) => T | void;
  onRejected?: (error: unknown) => void;
};

export type InterceptorManager<T> = {
  use(onFulfilled?: (value: T) => T | void, onRejected?: (error: unknown) => void): number;
  eject(id: number): void;
};

export type HttpClient = {
  get<T = unknown>(url: string, config?: HttpRequestConfig): Promise<HttpResponse<T>>;
  post<T = unknown>(url: string, data?: unknown, config?: HttpRequestConfig): Promise<HttpResponse<T>>;
  put<T = unknown>(url: string, data?: unknown, config?: HttpRequestConfig): Promise<HttpResponse<T>>;
  patch<T = unknown>(url: string, data?: unknown, config?: HttpRequestConfig): Promise<HttpResponse<T>>;
  delete<T = unknown>(url: string, config?: HttpRequestConfig): Promise<HttpResponse<T>>;
  request<T = unknown>(url: string, config?: HttpRequestConfig): Promise<HttpResponse<T>>;
  download(url: string, filename?: string, config?: HttpRequestConfig): Promise<DownloadResult>;
  safe: {
    get<T = unknown>(url: string, config?: HttpRequestConfig): Promise<SafeResult<T>>;
    post<T = unknown>(url: string, data?: unknown, config?: HttpRequestConfig): Promise<SafeResult<T>>;
    put<T = unknown>(url: string, data?: unknown, config?: HttpRequestConfig): Promise<SafeResult<T>>;
    patch<T = unknown>(url: string, data?: unknown, config?: HttpRequestConfig): Promise<SafeResult<T>>;
    delete<T = unknown>(url: string, config?: HttpRequestConfig): Promise<SafeResult<T>>;
  };
  interceptors: {
    request: InterceptorManager<HttpRequestConfig>;
    response: InterceptorManager<HttpResponse>;
  };
  create(defaults?: Partial<HttpRequestConfig>): HttpClient;
  clearCache(): void;
  invalidateCache(pattern: string | RegExp): void;
};

// ---------------------------------------------------------------------------
// Interceptor manager
// ---------------------------------------------------------------------------

type InterceptorEntry<T> = Interceptor<T> | null;

function createInterceptorManager<T>(): InterceptorManager<T> & { forEach(fn: (h: Interceptor<T>) => void): void } {
  const handlers: InterceptorEntry<T>[] = [];
  return {
    use(onFulfilled, onRejected) {
      handlers.push({ onFulfilled, onRejected });
      return handlers.length - 1;
    },
    eject(id) {
      if (handlers[id]) handlers[id] = null;
    },
    forEach(fn) {
      for (const h of handlers) { if (h) fn(h); }
    },
  };
}

// ---------------------------------------------------------------------------
// Imports from internal helpers
// ---------------------------------------------------------------------------

import { MAX_TIMEOUT_MS } from './bounds';
import { createResponseCache, CACHE_DEFAULT_TTL } from './http-cache';
import { classifyError, isRetryableStatus } from './http-errors';
import { buildFullUrl } from './http-query';

// ---------------------------------------------------------------------------
// Constants for multi-method client
// ---------------------------------------------------------------------------

const IDEMPOTENT_METHODS: HttpMethod[] = ['GET'];
const MUTATION_METHODS: HttpMethod[] = ['POST', 'PUT', 'PATCH', 'DELETE'];
const DEFAULT_GET_RETRY = 2;
const DEFAULT_MUTATION_RETRY = 0;
const DEFAULT_CLIENT_TIMEOUT = 30_000;

// ---------------------------------------------------------------------------
// Internal: generic fetch with retry, CSRF, timeout (multi-method)
// ---------------------------------------------------------------------------

async function doClientFetch<T>(
  fullUrl: string,
  method: HttpMethod,
  headers: Record<string, string>,
  body: string | FormData | undefined,
  responseType: ResponseType,
  signal: AbortSignal,
): Promise<HttpResponse<T>> {
  const init: RequestInit = { method, headers, credentials: 'same-origin', signal };
  if (body !== undefined) init.body = body;

  const raw = await fetch(fullUrl, init);
  const resHeaders = headersToObject(raw.headers);

  let data: any = null;
  if (responseType === 'blob') {
    data = await raw.blob();
  } else if (responseType === 'text') {
    data = await raw.text();
  } else {
    // json (default) - graceful fallback for non-JSON responses.
    //
    // `?.get()` rather than the `resHeaders` snapshot above, deliberately: the
    // rationale is on the snapshot helper's docblock (case-insensitive by
    // spec; a miss here hands the caller a string where they asked for JSON).
    //
    // JSON is `application/json` or any `+json` structured suffix (RFC 6839) -
    // `application/problem+json` (RFC 9457) above all, whose `code` was lost
    // as an unparsed string. A type that only CONTAINS "json"
    // (`application/json-seq`) is not JSON and stays text.
    const contentType = raw.headers?.get('content-type') || '';
    if (/[/+]json\s*(;|$)/i.test(contentType)) {
      const text = await raw.text();
      data = text ? JSON.parse(text) : null;
    } else {
      data = await raw.text();
    }
  }

  return { data: data as T, status: raw.status, headers: resHeaders, ok: raw.ok };
}

async function clientRequest<T>(
  fullUrl: string,
  method: HttpMethod,
  headersObj: Record<string, string>,
  body: string | FormData | undefined,
  responseType: ResponseType,
  maxRetries: number,
  timeout: number,
  userSignal: AbortSignal | undefined,
  csrf: boolean,
  csrfCookieUrl: string,
  onSessionExpired?: (status: number) => void,
): Promise<HttpResponse<T>> {
  // Attach CSRF for mutation methods
  if (csrf && MUTATION_METHODS.includes(method)) {
    const token = readCsrfToken();
    if (token) headersObj[token.headerName] = token.token;
  }

  return runWithRetry<T>(
    (signal) => doClientFetch<T>(fullUrl, method, headersObj, body, responseType, signal),
    headersObj,
    { retry: maxRetries, timeout, userSignal, csrfCookieUrl, onSessionExpired, url: fullUrl },
  );
}

// ---------------------------------------------------------------------------
// createHttpClient
// ---------------------------------------------------------------------------

/**
 * createHttpClient - multi-method HTTP client with interceptors, caching,
 * deduplication, safe mode, and file download.
 *
 * Aligned with useFetch (2026-02-05A) patterns. Framework-agnostic - no Vue imports.
 *
 * @example
 * const http = createHttpClient({ baseURL: '/api', csrf: true });
 *
 * // All methods
 * const users = await http.get('/users', { params: { page: 1 } });
 * await http.post('/cart', { itemId: 1, qty: 2 });
 * await http.put('/cart/1', { qty: 5 });
 * await http.delete('/cart/1');
 *
 * // Safe mode - never throws
 * const result = await http.safe.post('/login', credentials);
 * if (result.error) console.log(result.error.message);
 *
 * // File download
 * await http.download('/export/csv', 'products.csv');
 *
 * // Interceptors
 * http.interceptors.request.use((config) => { config.headers = { ...config.headers, 'X-Custom': '1' }; return config; });
 *
 * // Create scoped instance
 * const adminHttp = http.create({ baseURL: '/admin/api', headers: { 'X-Admin': 'true' } });
 */
export function createHttpClient(instanceDefaults: Partial<HttpRequestConfig> = {}): HttpClient {
  const requestInterceptors = createInterceptorManager<HttpRequestConfig>();
  const responseInterceptors = createInterceptorManager<HttpResponse>();
  // Owned by this client - see http-cache.ts. `create()` below mints a fresh
  // one for the derived client, so one instance's clearCache() can never empty
  // another's, and a per-request client under SSR is genuinely isolated.
  const cache = createResponseCache();

  async function request<T = unknown>(url: string, options: HttpRequestConfig = {}): Promise<HttpResponse<T>> {
    // Merge instance defaults with per-call options
    let config: HttpRequestConfig = {
      ...instanceDefaults,
      ...options,
      headers: {
        'Accept': 'application/json, application/problem+json',
        'X-Requested-With': 'XMLHttpRequest',
        ...instanceDefaults.headers,
        ...options.headers,
      },
    };

    // Run request interceptors
    requestInterceptors.forEach(({ onFulfilled, onRejected }) => {
      try { if (onFulfilled) config = onFulfilled(config) || config; }
      catch (e) { if (onRejected) onRejected(e); }
    });

    const method: HttpMethod = (config.method ?? 'GET') as HttpMethod;
    // Same bounds as postCommand's, normalized once before clientRequest's loop.
    const rawTimeout = config.timeout as number;
    const timeout = rawTimeout < MAX_TIMEOUT_MS ? rawTimeout : rawTimeout > 0 ? MAX_TIMEOUT_MS : DEFAULT_CLIENT_TIMEOUT;
    const isIdempotent = IDEMPOTENT_METHODS.includes(method);
    const maxRetries = config.retry ?? (isIdempotent ? DEFAULT_GET_RETRY : DEFAULT_MUTATION_RETRY);
    const responseType: ResponseType = config.responseType ?? 'json';
    const csrf = config.csrf ?? false;
    const csrfCookieUrl = config.csrfCookieUrl ?? DEFAULT_CSRF_COOKIE_URL;
    const dedupe = config.dedupe ?? true;

    const fullUrl = buildFullUrl(url, config.baseURL, config.params);
    // responseType is part of both keys - a concurrent get(url) (json) and
    // get(url, { responseType: 'blob' }) must not collapse to one request or
    // one cache slot, or the loser receives the wrong data type.
    const dedupeKey = `${method}:${responseType}:${fullUrl}`;
    const cacheKey = `${responseType}:${fullUrl}`;

    // Request deduplication for GET
    if (isIdempotent && dedupe) {
      const inflight = cache.getInflight(dedupeKey);
      if (inflight) return inflight as Promise<HttpResponse<T>>;
    }

    // LRU cache for GET. A fresh hit short-circuits; a stale hit (within
    // cache.staleTtl) is captured and served below with a background
    // revalidation attached - the stale-while-revalidate path.
    const cacheEnabled = config.cache && isIdempotent;
    const cacheCfg = typeof config.cache === 'object' ? config.cache : {};
    let staleResponse: HttpResponse | null = null;
    if (cacheEnabled) {
      const cached = cache.get(cacheKey);
      if (cached && !cached.stale) return cached.data as HttpResponse<T>;
      if (cached) staleResponse = cached.data as HttpResponse;
    }

    // Build headers and body
    const headersObj: Record<string, string> = { ...config.headers } as Record<string, string>;
    let body: string | FormData | undefined;
    const rawData = config.data;

    if (rawData !== undefined && rawData !== null) {
      if (rawData instanceof FormData) {
        body = rawData;
        delete headersObj['Content-Type']; // let browser set boundary
      } else if (typeof rawData === 'object') {
        body = JSON.stringify(rawData);
        headersObj['Content-Type'] = 'application/json';
      } else {
        body = String(rawData);
      }
    }

    // Execute request
    const fetchPromise = clientRequest<T>(
      fullUrl, method, headersObj, body, responseType, maxRetries, timeout,
      config.signal, csrf, csrfCookieUrl, config.onSessionExpired,
    ).then((res) => {
      // Run response interceptors
      let response = res as HttpResponse;
      responseInterceptors.forEach(({ onFulfilled }) => {
        if (onFulfilled) response = onFulfilled(response) || response;
      });

      // Cache successful GET responses
      if (cacheEnabled && response.ok) {
        cache.set(cacheKey, response, cacheCfg.ttl ?? CACHE_DEFAULT_TTL, cacheCfg.staleTtl ?? 0);
      }

      return response as HttpResponse<T>;
    }).catch((err) => {
      // Run response error interceptors
      responseInterceptors.forEach(({ onRejected }) => { if (onRejected) onRejected(err); });
      if (config.silent) (err as HttpError).silent = true;
      throw err;
    });

    // cache.serveStaleOnError (opt-in): a transient failure (timeout/network/
    // 5xx per classifyError) with ANY retained entry for this URL - even one
    // past its stale window - resolves to { stale, servedOnError, error }
    // instead of rejecting. Business errors (4xx) and user aborts always
    // surface; deduped followers share this promise's outcome.
    //
    // This wrapper is built BEFORE the promise is registered for dedupe, and
    // that ordering is the whole point. Registering the raw `fetchPromise`
    // while handing the caller a `.catch()`-wrapped one gives the two callers
    // different promises: the leader was served the retained entry while a
    // follower on the same key received the untouched rejection - the exact
    // opposite of the sentence above. The features were only ever tested
    // apart, every serveStaleOnError case passing `dedupe: false`, so the
    // disagreement never showed up.
    const sharedPromise: Promise<HttpResponse<T>> =
      cacheEnabled && cacheCfg.serveStaleOnError
        ? fetchPromise.catch((error) => {
            const aborted = (error as HttpError)?.name === 'AbortError';
            if (!aborted && classifyError(error).transient) {
              const retained = cache.getAny(cacheKey);
              if (retained) {
                return { ...(retained.data as HttpResponse<T>), stale: true, servedOnError: true, error };
              }
            }
            throw error;
          })
        : fetchPromise;

    // Track in-flight GET for deduplication
    if (isIdempotent && dedupe) {
      cache.setInflight(dedupeKey, sharedPromise);
    }

    // Stale-while-revalidate: serve the stale response now; the fetch above
    // finishes in the background and is cached (cache.set) on success. `revalidation`
    // lets a caller push the fresh data into its own state when it lands.
    if (staleResponse) {
      sharedPromise.catch(() => {}); // background failure must not surface as an unhandled rejection
      return { ...staleResponse, stale: true, revalidation: fetchPromise } as HttpResponse<T>;
    }

    return sharedPromise;
  }

  // Safe mode wrapper
  async function safeRequest<T>(method: HttpMethod, url: string, data?: unknown, config: HttpRequestConfig = {}): Promise<SafeResult<T>> {
    try {
      const reqConfig: HttpRequestConfig = { ...config, method };
      if (data !== undefined) reqConfig.data = data;
      const response = await request<T>(url, reqConfig);
      return { data: response.data, error: null, status: response.status };
    } catch (err) {
      const e = err as HttpError;
      const errorData = e.response?.data as any;
      return {
        data: null,
        error: errorData && typeof errorData === 'object' ? errorData : { message: e.message, code: e.code },
        status: e.status ?? e.response?.status ?? 0,
      };
    }
  }

  // Download helper
  async function download(url: string, filename?: string, config: HttpRequestConfig = {}): Promise<DownloadResult> {
    const response = await request<Blob>(url, { ...config, method: config.method ?? 'GET', responseType: 'blob' });

    let downloadFilename = filename;
    if (!downloadFilename) {
      const disposition = response.headers['content-disposition'];
      if (disposition) {
        const match = disposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
        if (match) downloadFilename = match[1].replace(/['"]/g, '');
      }
    }
    downloadFilename = downloadFilename || 'download';

    // Trigger browser download (guarded for SSR)
    if (typeof document !== 'undefined' && response.data instanceof Blob) {
      const link = document.createElement('a');
      link.href = URL.createObjectURL(response.data);
      link.download = downloadFilename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(link.href);
    }

    return { data: response.data, status: response.status, filename: downloadFilename };
  }

  return {
    get:     <T>(url: string, config?: HttpRequestConfig) => request<T>(url, { ...config, method: 'GET' }),
    post:    <T>(url: string, data?: unknown, config?: HttpRequestConfig) => request<T>(url, { ...config, method: 'POST', data }),
    put:     <T>(url: string, data?: unknown, config?: HttpRequestConfig) => request<T>(url, { ...config, method: 'PUT', data }),
    patch:   <T>(url: string, data?: unknown, config?: HttpRequestConfig) => request<T>(url, { ...config, method: 'PATCH', data }),
    delete:  <T>(url: string, config?: HttpRequestConfig) => request<T>(url, { ...config, method: 'DELETE' }),
    request,
    download,
    safe: {
      get:    <T>(url: string, config?: HttpRequestConfig) => safeRequest<T>('GET', url, undefined, config),
      post:   <T>(url: string, data?: unknown, config?: HttpRequestConfig) => safeRequest<T>('POST', url, data, config),
      put:    <T>(url: string, data?: unknown, config?: HttpRequestConfig) => safeRequest<T>('PUT', url, data, config),
      patch:  <T>(url: string, data?: unknown, config?: HttpRequestConfig) => safeRequest<T>('PATCH', url, data, config),
      delete: <T>(url: string, config?: HttpRequestConfig) => safeRequest<T>('DELETE', url, undefined, config),
    },
    interceptors: {
      request: requestInterceptors,
      response: responseInterceptors,
    },
    create: (newDefaults) => createHttpClient({
      ...instanceDefaults,
      ...newDefaults,
      headers: { ...instanceDefaults.headers, ...newDefaults?.headers },
    }),
    clearCache: () => cache.clear(),
    invalidateCache: (pattern) => cache.invalidate(pattern),
  };
}
